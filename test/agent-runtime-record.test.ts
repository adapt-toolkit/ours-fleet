import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntimeRecordStore, runtimeCanonical, runtimeDigest, type RuntimeCommon } from '../src/agent-runtime-record.js';

let root: string;
let canonicalDir: string;
const common: RuntimeCommon = {
  agentId: 'worker-1', generation: 1, planDigest: `sha256:${'1'.repeat(64)}`,
  snapshotDigest: `sha256:${'2'.repeat(64)}`, reservationDigest: `sha256:${'3'.repeat(64)}`,
  identityEvidenceDigest: `sha256:${'4'.repeat(64)}`, runtimeInstanceKey: `sha256:${'5'.repeat(64)}`,
};
const action = 'runtime-action-1';
const revision = 'auth-1';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-runtime-record-'));
  const agentRoot = join(root, 'agents', Buffer.from(common.agentId).toString('base64url'));
  canonicalDir = join(agentRoot, 'generations', 'canonical', '1');
  mkdirSync(canonicalDir, { recursive: true, mode: 0o700 });
  for (let cursor = canonicalDir; cursor.startsWith(root); cursor = join(cursor, '..')) {
    try { chmodSync(cursor, 0o700); } catch { break; }
    if (cursor === root) break;
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('durable runtime prerequisite records', () => {
  it('publishes and securely rereads the exact operation-bound prerequisite', () => {
    const store = new AgentRuntimeRecordStore();
    const published = store.publishPrerequisite(canonicalDir, 'launch', action, revision, common);
    expect(store.readPrerequisite(canonicalDir, 'launch', action, revision, common)).toEqual(published);
    expect(published.prerequisiteDigest).toBe(runtimeDigest(runtimeCanonical({
      schemaVersion: 1, kind: 'AgentRuntimePrerequisite', operation: 'launch',
      requestActionId: action, authorizationRevision: revision, ...common,
    })));
  });

  it('rejects a canonical recomputed prerequisite with an extra field and unsafe mode', () => {
    const store = new AgentRuntimeRecordStore();
    store.publishPrerequisite(canonicalDir, 'launch', action, revision, common);
    const path = join(root, 'agents', Buffer.from(common.agentId).toString('base64url'),
      'runtime-prerequisites', `${Buffer.from(action).toString('base64url')}.json`);
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    value.extra = 'forged';
    unlinkSync(path); writeFileSync(path, `${runtimeCanonical(value)}\n`, { mode: 0o600 });
    expect(() => store.readPrerequisite(canonicalDir, 'launch', action, revision, common))
      .toThrow(expect.objectContaining({ code: 'corrupt' }));
    delete value.extra; unlinkSync(path); writeFileSync(path, `${runtimeCanonical(value)}\n`, { mode: 0o644 });
    expect(() => store.readPrerequisite(canonicalDir, 'launch', action, revision, common))
      .toThrow(expect.objectContaining({ code: 'unsafe' }));
  });
});

describe('exact runtime transition event schemas', () => {
  it('accepts exact state events and rejects missing or extra keys before publication', async () => {
    const store = new AgentRuntimeRecordStore();
    await store.append(canonicalDir, 'launch', action, revision, common,
      'prerequisites_validated', { prerequisiteDigest: `sha256:${'6'.repeat(64)}` });
    await expect(store.append(canonicalDir, 'launch', action, revision, common,
      'active_claimed', {})).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.append(canonicalDir, 'launch', action, revision, common,
      'active_claimed', { claimDigest: `sha256:${'7'.repeat(64)}`, extra: 'forged' }))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(store.readChain(canonicalDir, 'launch', action, common)).toHaveLength(1);
  });

  it('rejects canonical digest-recomputed state/event substitution on reread', async () => {
    const store = new AgentRuntimeRecordStore();
    await store.append(canonicalDir, 'launch', action, revision, common,
      'prerequisites_validated', { prerequisiteDigest: `sha256:${'6'.repeat(64)}` });
    const dir = store.chainDir(canonicalDir, 'launch', action);
    const path = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!);
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    value.event = { prerequisiteDigest: `sha256:${'6'.repeat(64)}`, extra: 'forged' };
    const { digest: _old, ...unsigned } = value; value.digest = runtimeDigest(runtimeCanonical(unsigned));
    unlinkSync(path); writeFileSync(path, `${runtimeCanonical(value)}\n`, { mode: 0o600 });
    expect(() => store.readChain(canonicalDir, 'launch', action, common))
      .toThrow(expect.objectContaining({ code: 'corrupt' }));
  });

  it('rejects a conflicting duplicate transition instead of silently accepting it', async () => {
    const store = new AgentRuntimeRecordStore();
    await store.append(canonicalDir, 'launch', action, revision, common,
      'prerequisites_validated', { prerequisiteDigest: `sha256:${'6'.repeat(64)}` });
    await expect(store.append(canonicalDir, 'launch', action, revision, common,
      'prerequisites_validated', { prerequisiteDigest: `sha256:${'7'.repeat(64)}` }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(store.readChain(canonicalDir, 'launch', action, common)).toHaveLength(1);
  });

  it('rejects recomputed but non-protocol terminal reasons', async () => {
    const store = new AgentRuntimeRecordStore();
    await expect(store.append(canonicalDir, 'launch', action, revision, common,
      'ambiguous', { reason: 'author_supplied_reason' })).rejects.toMatchObject({ code: 'invalid' });
    expect(store.readChain(canonicalDir, 'launch', action, common)).toHaveLength(0);
  });
});

describe('active claim and operation-index recovery', () => {
  it('converges after a crash between claim and index without changing the active generation', async () => {
    let crash = true;
    const store = new AgentRuntimeRecordStore({ duringClaimIndex: () => {
      if (crash) { crash = false; throw new Error('crash before index'); }
    } });
    await expect(store.claim(canonicalDir, common, action, revision, () => undefined))
      .rejects.toThrow('crash before index');
    const claim = await store.claim(canonicalDir, common, action, revision, () => undefined);
    expect(store.readOperationIndex(canonicalDir, common.agentId, 'start', action, revision,
      common.runtimeInstanceKey, claim.claimDigest)).toMatchObject({ operation: 'start' });
  });

  it('rejects a different generation after the active claim is durable', async () => {
    const store = new AgentRuntimeRecordStore();
    await store.claim(canonicalDir, common, action, revision, () => undefined);
    await expect(store.claim(canonicalDir, { ...common, generation: 2,
      runtimeInstanceKey: `sha256:${'a'.repeat(64)}` }, 'runtime-action-2', revision, () => undefined))
      .rejects.toMatchObject({ code: 'conflict' });
  });
});
