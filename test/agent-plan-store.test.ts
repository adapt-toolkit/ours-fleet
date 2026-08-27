import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  computeBrainDigest, computePermissionsDigest, resolveAgentPlan,
  type AdapterValidationRecord, type AgentPlan, type AgentPlanResolutionInput,
} from '../src/agent-plan.js';
import { encodeAgentPlan } from '../src/agent-plan-codec.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import type { BrainSpec, PermissionSpec } from '../src/config-resources.js';
import {
  AGENT_PLAN_STORE_FILENAME, AgentPlanStoreError, readStoredAgentPlan, storeAgentPlan,
  type AgentPlanStoreBindings, type AgentPlanStoreDeps,
} from '../src/agent-plan-store.js';

let root: string;
let stateDir: string;
let plan: AgentPlan;
let expected: AgentPlanStoreBindings;

const brain: BrainSpec = { harness: 'codex', model: 'gpt-test', effort: 'high', session: 'acp' };
const permissions: PermissionSpec = { approval: 'ask', filesystem: 'workspace', unattended: 'deny' };
const adapter: AdapterValidationRecord = {
  redacted: true, adapterId: 'codex-acp', adapterVersion: '1', policyRevision: 'policy-1',
  policyDigest: `sha256:${'1'.repeat(64)}`, brainDigest: computeBrainDigest(brain),
  permissionsDigest: computePermissionsDigest(permissions), portableDescriptor: permissions,
  nativeDescriptor: {
    approvalMode: 'ask', filesystemMode: 'workspace', unattendedMode: 'deny', exact: true,
  },
  enforcement: {
    approval: { owner: 'native_adapter', policyDigest: `sha256:${'1'.repeat(64)}` },
    filesystem: { owner: 'native_adapter', policyDigest: `sha256:${'1'.repeat(64)}` },
    unattended: { owner: 'body_controller', policyDigest: `sha256:${'1'.repeat(64)}` },
  },
};

function write(relative: string, contents: string): void {
  const path = join(root, 'fleet.conf.d', relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function makePlan(generation = 1, agentId = 'worker-1'): AgentPlan {
  const snapshot = loadConfigResourceSnapshot({ bootstrapFile: join(root, 'fleet.yaml') });
  const input: AgentPlanResolutionInput = {
    snapshot,
    source: {
      kind: 'runtime_composition', agentId, role: 'Builder',
      identity: { name: agentId, ownership: 'create_temporary' }, lifecycle: 'temporary',
      brain, permissions,
    },
    principal: { id: 'owner-1', kind: 'owner' },
    operation: { id: `op-${generation}`, type: 'agent.create', resourceScope: `agents/${agentId}` },
    authorizationRevision: 'auth-1', generation, evaluatedAt: 1000, adapter,
  };
  return resolveAgentPlan(input);
}

const bindings = (value: AgentPlan): AgentPlanStoreBindings => ({
  agentId: value.agentId, generation: value.generation, planDigest: value.planDigest,
  snapshotDigest: value.snapshotDigest,
});
const finalPath = () => join(stateDir, AGENT_PLAN_STORE_FILENAME);
const temps = () => readdirSync(stateDir).filter(name => name.endsWith('.tmp'));
const code = (fn: () => unknown, value: string) => {
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AgentPlanStoreError);
  expect(caught).toMatchObject({ code: value, label: 'test' });
  expect((caught as Error).message).not.toContain(root);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-plan-store-'));
  stateDir = join(root, 'state'); mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(join(root, 'fleet.conf.d'));
  writeFileSync(join(root, 'fleet.yaml'), 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
  write('roles.d/builder.yaml', 'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Build\n');
  plan = makePlan(); expected = bindings(plan);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('durable AgentPlan store', () => {
  it('publishes canonical 0600 bytes and returns a deeply frozen envelope', () => {
    const envelope = storeAgentPlan(stateDir, plan, expected, 'test');
    expect(readFileSync(finalPath())).toEqual(encodeAgentPlan(plan));
    expect(lstatSync(finalPath()).mode & 0o777).toBe(0o600);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.plan.permissionProvenance)).toBe(true);
    expect(readStoredAgentPlan(stateDir, expected, 'test')).toEqual(envelope);
    expect(temps()).toEqual([]);
  });

  it('is idempotent for identical canonical bytes and never replaces the inode', () => {
    storeAgentPlan(stateDir, plan, expected, 'test');
    const before = lstatSync(finalPath());
    storeAgentPlan(stateDir, plan, expected, 'test');
    const after = lstatSync(finalPath());
    expect([after.dev, after.ino, readFileSync(finalPath())]).toEqual([before.dev, before.ino, encodeAgentPlan(plan)]);
  });

  it('makes simultaneous identical contenders converge without replacement', () => {
    let nested = false;
    const envelope = storeAgentPlan(stateDir, plan, expected, 'test', {
      beforePublish: () => {
        if (!nested) { nested = true; storeAgentPlan(stateDir, plan, expected, 'test'); }
      },
    });
    expect(envelope.planDigest).toBe(plan.planDigest);
    expect(readFileSync(finalPath())).toEqual(encodeAgentPlan(plan));
    expect(temps()).toEqual([]);
  });

  it('makes conflicting contenders preserve the winner byte-for-byte', () => {
    const winner = makePlan(2);
    let nested = false;
    code(() => storeAgentPlan(stateDir, plan, expected, 'test', {
      beforePublish: () => {
        if (!nested) { nested = true; storeAgentPlan(stateDir, winner, bindings(winner), 'test'); }
      },
    }), 'binding_mismatch');
    expect(readFileSync(finalPath())).toEqual(encodeAgentPlan(winner));
    expect(temps()).toEqual([]);
  });

  it.each([
    ['agentId', { agentId: 'other' }], ['generation', { generation: 9 }],
    ['planDigest', { planDigest: `sha256:${'f'.repeat(64)}` }],
    ['snapshotDigest', { snapshotDigest: `sha256:${'e'.repeat(64)}` }],
  ])('rejects an exact expected %s mismatch', (_name, patch) => {
    code(() => storeAgentPlan(stateDir, plan, { ...expected, ...patch }, 'test'), 'binding_mismatch');
    expect(existsSync(finalPath())).toBe(false);
  });

  it('rejects absent, malformed, noncanonical, oversized, and wrong-mode final files', () => {
    code(() => readStoredAgentPlan(stateDir, expected, 'test'), 'not_found');
    writeFileSync(finalPath(), '{}\n', { mode: 0o600 });
    code(() => readStoredAgentPlan(stateDir, expected, 'test'), 'invalid_plan');
    writeFileSync(finalPath(), Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
    code(() => readStoredAgentPlan(stateDir, expected, 'test'), 'unsafe_file');
    writeFileSync(finalPath(), encodeAgentPlan(plan), { mode: 0o644 }); chmodSync(finalPath(), 0o644);
    code(() => readStoredAgentPlan(stateDir, expected, 'test'), 'unsafe_file');
  });

  it('rejects parent and final symlinks, including a final swap before open', () => {
    const real = join(root, 'real'); mkdirSync(real); const alias = join(root, 'alias'); symlinkSync(real, alias);
    code(() => storeAgentPlan(alias, plan, expected, 'test'), 'unsafe_state_directory');
    writeFileSync(join(root, 'other'), encodeAgentPlan(plan), { mode: 0o600 });
    symlinkSync(join(root, 'other'), finalPath());
    code(() => readStoredAgentPlan(stateDir, expected, 'test'), 'unsafe_file');
    rmSync(finalPath()); storeAgentPlan(stateDir, plan, expected, 'test');
    code(() => readStoredAgentPlan(stateDir, expected, 'test', {
      beforeOpenFinal: () => { rmSync(finalPath()); symlinkSync(join(root, 'other'), finalPath()); },
    }), 'read_failed');
  });

  it('detects an injected parent identity swap before publication', () => {
    const moved = `${stateDir}-old`;
    code(() => storeAgentPlan(stateDir, plan, expected, 'test', {
      beforePublish: () => {
        rmSync(moved, { recursive: true, force: true });
        renameSync(stateDir, moved); symlinkSync(moved, stateDir);
      },
    }), 'unsafe_state_directory');
    expect(existsSync(finalPath())).toBe(false);
    expect(readdirSync(moved).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each([
    ['partial write then failure', { write: vi.fn().mockReturnValueOnce(7).mockReturnValueOnce(0) }],
    ['zero-progress write', { write: () => 0 }],
    ['file fsync failure', { fsync: () => { throw new Error('secret fsync cause'); } }],
    ['close failure', { close: () => { throw new Error('secret close cause'); } }],
    ['publication failure', { link: () => { throw Object.assign(new Error('secret link cause'), { code: 'EIO' }); } }],
  ] as Array<[string, AgentPlanStoreDeps]>)('cleans private temp after %s', (_name, deps) => {
    code(() => storeAgentPlan(stateDir, plan, expected, 'test', deps), 'write_failed');
    expect(existsSync(finalPath())).toBe(false);
    expect(temps()).toEqual([]);
  });

  it('rejects truncated reads and detects before/after identity changes', () => {
    storeAgentPlan(stateDir, plan, expected, 'test');
    code(() => readStoredAgentPlan(stateDir, expected, 'test', { read: () => 0 }), 'read_failed');
    let calls = 0;
    code(() => readStoredAgentPlan(stateDir, expected, 'test', {
      fstat: fd => {
        const stat = lstatSync(`/proc/self/fd/${fd}`, { bigint: true });
        calls += 1;
        if (calls !== 2) return stat;
        return new Proxy(stat, {
          get(target, property, receiver) {
            if (property === 'mtimeNs') return target.mtimeNs + 1n;
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    }), 'unsafe_file');
  });

  it('redacts invalid labels and never includes content, causes, or paths', () => {
    try { storeAgentPlan(stateDir, plan, expected, '../secret-plan-content'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'invalid_label', label: 'invalid' });
      expect((error as Error).message).toBe('agent plan store invalid: invalid_label');
    }
  });

  it.each([
    ['empty', ''], ['traversal', '../escape'], ['separator', 'abc/def'],
    ['dot', '..'], ['oversized', 'a'.repeat(65)], ['short', 'abcdefg'],
  ])('rejects an injected %s private token before creating any artifact', (_name, token) => {
    code(() => storeAgentPlan(stateDir, plan, expected, 'test', { randomUUID: () => token }), 'write_failed');
    expect(readdirSync(stateDir)).toEqual([]);
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  it('redacts throwing token and hook dependencies and cleans pre-publication state', () => {
    const secret = `${root}/secret-cause-plan-content`;
    for (const deps of [
      { randomUUID: () => { throw new Error(secret); } },
      { beforePublish: () => { throw new Error(secret); } },
    ] satisfies AgentPlanStoreDeps[]) {
      code(() => storeAgentPlan(stateDir, plan, expected, 'test', deps), 'write_failed');
      expect(readdirSync(stateDir)).toEqual([]);
    }
    storeAgentPlan(stateDir, plan, expected, 'test');
    code(() => readStoredAgentPlan(stateDir, expected, 'test', {
      beforeOpenFinal: () => { throw new Error(secret); },
    }), 'read_failed');
    expect(readFileSync(finalPath())).toEqual(encodeAgentPlan(plan));
  });

  it('keeps a valid winner after post-publication temp cleanup failure and retry converges', () => {
    let unlinks = 0;
    code(() => storeAgentPlan(stateDir, plan, expected, 'test', {
      unlink: path => {
        unlinks += 1;
        if (unlinks === 1) throw new Error(`${root}/secret-unlink-cause`);
        unlinkSync(path);
      },
    }), 'cleanup_failed');
    const winner = lstatSync(finalPath());
    expect(readFileSync(finalPath())).toEqual(encodeAgentPlan(plan));
    expect(readStoredAgentPlan(stateDir, expected, 'test').planDigest).toBe(plan.planDigest);
    storeAgentPlan(stateDir, plan, expected, 'test');
    const after = lstatSync(finalPath());
    expect([after.dev, after.ino]).toEqual([winner.dev, winner.ino]);
    expect(temps()).toEqual([]);
  });
});
