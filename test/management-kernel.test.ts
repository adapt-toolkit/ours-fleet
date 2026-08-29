import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManagementKernel } from '../src/application/management-kernel.js';
import { ManagementOperationStore, managementDigest } from '../src/application/management-operation-store.js';
import { ResourceManagementService } from '../src/application/resource-management-service.js';
import { FleetError } from '../src/application/errors.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-kernel-')); chmodSync(root, 0o700);
  const conf = join(root, 'fleet.conf.d'); mkdirSync(conf, { mode: 0o700 });
  const bootstrap = join(root, 'fleet.yaml');
  writeFileSync(bootstrap, 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
  const resources = new ResourceManagementService(bootstrap);
  const operations = new ManagementOperationStore(join(root, 'operations'));
  const kernel = new ManagementKernel(resources, { execute: async command => ({ type: 'agent', id: command.id,
    desired: 'running', observed: 'unknown', detail: 'test' }) }, { authorize: principal => principal.local === true },
  operations);
  return { bootstrap, resources, operations, kernel };
}

describe('ManagementKernel', () => {
  it('enforces mutation identity and destructive confirmation inside the kernel', async () => {
    const { resources } = fixture(); const root = mkdtempSync(join(tmpdir(), 'fleet-kernel-contract-'));
    const calls: string[] = [];
    const kernel = new ManagementKernel(resources, { execute: async command => ({ type: 'agent', id: command.id,
      desired: 'running', observed: 'running', detail: 'ok' }) }, { authorize: () => true },
    new ManagementOperationStore(join(root, 'operations')), undefined, { execute: async command => {
      calls.push(command.operation); return { type: 'task', value: {} };
    } });
    const principal = { surface: 'cli' as const, local: true };
    expect(await kernel.execute(principal, { version: 1, requestId: 'missing-key', command: {
      operation: 'task.delete', id: 't-1', confirmationId: 't-1', expectedStateDigest: 'd',
    } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await kernel.execute(principal, { version: 1, requestId: 'bad-confirm', idempotencyKey: 'bad-confirm', command: {
      operation: 'task.delete', id: 't-1', confirmationId: 'other', expectedStateDigest: 'd',
    } })).toMatchObject({ ok: false, error: { code: 'invalid_request', details: { reason: 'confirmation_mismatch' } } });
    expect(calls).toEqual([]);
  });
  it('journals and replays task-room results without identity or invite authority', async () => {
    const { resources } = fixture(); const root = mkdtempSync(join(tmpdir(), 'fleet-kernel-redaction-'));
    const operations = new ManagementOperationStore(join(root, 'operations'));
    const kernel = new ManagementKernel(resources, { execute: async () => { throw new Error('unused'); } },
      { authorize: () => true }, operations, undefined, { execute: async () => ({ type: 'task', value: {
        task_id: 't-1', title: 'Safe', room_identity_cid: 'secret-cid',
        identityCid: 'camel-cid', publicInvite: 'camel-invite', launchEvidence: 'camel-launch',
        accessToken: 'camel-token', password: 'password', credential: 'credential',
        privateKey: 'private-key', delegationCertificate: 'delegation',
        task: [{ title: 'Nested safe', state: 'active', IdentityCID: 'mixed-cid',
          accessTOKEN: 'mixed-token', credential: 'nested-credential' }],
        unknown: { title: 'must drop with unknown container', password: 'nested-password' },
      } }) });
    const request = { version: 1 as const, requestId: 'redact-first', idempotencyKey: 'redact-key',
      command: { operation: 'task.create' as const, title: 'Safe', origin: 'cli' as const } };
    const first = await kernel.execute({ surface: 'cli', local: true }, request);
    expect(first).toMatchObject({ ok: true, result: { value: { room_identity_cid: 'secret-cid' } } });
    const record = readFileSync(operations.path(managementDigest('redact-key')), 'utf8');
    expect(record).not.toMatch(/secret-cid|secret-invite|secret-launch|camel-|password|credential|private-key|delegation|mixed-/iu);
    const restarted = new ManagementKernel(resources, { execute: async () => { throw new Error('must not execute'); } },
      { authorize: () => true }, new ManagementOperationStore(join(root, 'operations')), undefined,
      { execute: async () => { throw new Error('must not execute'); } });
    const replay = await restarted.execute({ surface: 'web', local: true }, { ...request, requestId: 'redact-replay' });
    expect(replay).toMatchObject({ ok: true, replay: { source: 'journal', redacted: true },
      result: { value: { task_id: 't-1', title: 'Safe', task: [{ title: 'Nested safe', state: 'active' }] } } });
    expect(JSON.stringify(replay)).not.toMatch(/cid|invite|evidence|token|password|credential|private|delegation|unknown/iu);
    const crossPrincipal = await restarted.execute({ surface: 'owner', cid: 'owner' },
      { ...request, requestId: 'cross-principal' });
    expect(crossPrincipal).toMatchObject({ ok: false, error: { code: 'idempotency_conflict',
      message: 'idempotency key is unavailable' } });
    expect(JSON.stringify(crossPrincipal)).not.toMatch(/t-1|Safe|secret|identity/u);
  });
  it('projects authority-bearing error details before durable replay', async () => {
    const { resources } = fixture(); const root = mkdtempSync(join(tmpdir(), 'fleet-kernel-error-redaction-'));
    const kernel = new ManagementKernel(resources, { execute: async () => { throw new Error('unused'); } },
      { authorize: () => true }, new ManagementOperationStore(join(root, 'operations')), undefined,
      { execute: async () => { throw new FleetError('invalid_request', 'request rejected',
        { details: { invite: 'secret-invite', password: 'secret-password', credential: 'secret-credential',
          privateKey: 'secret-private', delegation: 'secret-delegation', reason: 'safe_reason' } }); } });
    const request = { version: 1 as const, requestId: 'error-first', idempotencyKey: 'error-key',
      command: { operation: 'task.create' as const, title: 'Error', origin: 'cli' as const } };
    const first = await kernel.execute({ surface: 'cli', local: true }, request);
    expect(first).toMatchObject({ ok: false, error: { details: { invite: 'secret-invite' } } });
    const replay = await kernel.execute({ surface: 'cli', local: true }, { ...request, requestId: 'error-replay' });
    expect(replay).toMatchObject({ ok: false, replay: { source: 'journal', redacted: true },
      error: { details: { reason: 'safe_reason' } } });
    const record = readFileSync(new ManagementOperationStore(join(root, 'operations'))
      .path(managementDigest('error-key')), 'utf8');
    expect(`${record}\n${JSON.stringify(replay)}`).not.toMatch(/secret-(?:invite|password|credential|private|delegation)/u);
  });
  it('binds Owner wire idempotency to one command, one effect, and one authenticated CID', async () => {
    const { resources } = fixture(); const root = mkdtempSync(join(tmpdir(), 'fleet-owner-wire-'));
    let effects = 0;
    const kernel = new ManagementKernel(resources, { execute: async () => { throw new Error('unused'); } },
      { authorize: principal => principal.surface === 'owner' && typeof principal.cid === 'string' },
      new ManagementOperationStore(join(root, 'operations')), undefined, { execute: async command => {
        effects += 1; return { type: 'task', value: { task_id: 'owner-task', title: 'One',
          state: 'backlog', command: command.operation } };
      } });
    const request = { version: 1 as const, requestId: 'wire-1', idempotencyKey: 'wire-1:task.create',
      command: { operation: 'task.create' as const, title: 'One', origin: 'owner_channel' as const } };
    expect(await kernel.execute({ surface: 'owner', cid: 'owner-a' }, request)).toMatchObject({ ok: true });
    expect(await kernel.execute({ surface: 'owner', cid: 'owner-a' }, { ...request, requestId: 'wire-1-retry' }))
      .toMatchObject({ ok: true, replay: { source: 'journal', redacted: true } });
    expect(await kernel.execute({ surface: 'owner', cid: 'owner-a' }, { ...request, requestId: 'wire-1-altered',
      command: { ...request.command, title: 'Altered' } })).toMatchObject({ ok: false,
      error: { code: 'idempotency_conflict' } });
    expect(await kernel.execute({ surface: 'owner', cid: 'owner-b' }, { ...request, requestId: 'wire-1-other-owner' }))
      .toMatchObject({ ok: false, error: { code: 'idempotency_conflict', message: 'idempotency key is unavailable' } });
    expect(effects).toBe(1);
  });
  it('admits one effect across independent store and kernel instances sharing a key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-kernel-race-')); chmodSync(root, 0o700);
    const conf = join(root, 'fleet.conf.d'); mkdirSync(conf, { mode: 0o700 });
    const bootstrap = join(root, 'fleet.yaml');
    writeFileSync(bootstrap, 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
    let effects = 0; let release!: () => void;
    const paused = new Promise<void>(done => { release = done; });
    const port = { execute: async (command: { id: string }) => {
      effects += 1; await paused;
      return { type: 'agent' as const, id: command.id, desired: 'running' as const,
        observed: 'running' as const, detail: 'started' };
    } };
    const make = () => new ManagementKernel(new ResourceManagementService(bootstrap), port,
      { authorize: () => true }, new ManagementOperationStore(join(root, 'operations')));
    const request = { version: 1 as const, requestId: 'one', idempotencyKey: 'shared',
      command: { operation: 'agent.start' as const, id: 'worker' } };
    const first = make().execute({ surface: 'cli', local: true }, request);
    while (effects === 0) await new Promise(done => setTimeout(done, 1));
    const second = make().execute({ surface: 'cli', local: true }, { ...request, requestId: 'two' });
    await new Promise(done => setTimeout(done, 10)); expect(effects).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true); expect(b.ok).toBe(true); expect(effects).toBe(1);
  });
  it('provides one versioned deterministic CRUD contract and idempotent replay', async () => {
    const { resources, kernel } = fixture(); const digest = resources.list().digest;
    const request = { version: 1 as const, requestId: 'request-1', idempotencyKey: 'key-1', command: {
      operation: 'resource.create' as const, expectedDigest: digest,
      resource: { kind: 'Role' as const, version: 1 as const, id: 'writer', spec: { mission: 'Write.' } },
    } };
    const first = await kernel.execute({ surface: 'cli', local: true }, request);
    expect(first.ok).toBe(true);
    const replay = await kernel.execute({ surface: 'cli', local: true }, { ...request, requestId: 'request-2' });
    expect(replay).toMatchObject({ ok: true, requestId: 'request-2',
      replay: { source: 'journal', redacted: false } });
    expect(resources.get('Role', 'writer').resource).toMatchObject({ kind: 'Role', id: 'writer' });
  });
  it('applies mixed typed resources as one digest-guarded graph transaction', async () => {
    const { resources, kernel } = fixture(); const digest = resources.list().digest;
    const response = await kernel.execute({ surface: 'web', local: true }, {
      version: 1, requestId: 'batch-1', idempotencyKey: 'batch-key', command: {
        operation: 'resource.apply', expectedDigest: digest, mutations: [
          { mutation: 'create', resource: { kind: 'Agent', version: 1, id: 'alice', spec: {
            role: 'writer', brain: { template: 'codex' },
            identity: { name: 'alice', ownership: 'existing' }, lifecycle: 'persistent',
            permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
          } } },
          { mutation: 'create', resource: { kind: 'Role', version: 1, id: 'writer', spec: { mission: 'Write.' } } },
          { mutation: 'create', resource: { kind: 'Brain', version: 1, id: 'codex',
            spec: { harness: 'codex', model: 'gpt', effort: 'high', session: 'acp' } } },
        ],
      },
    });
    expect(response).toMatchObject({ ok: true, result: { type: 'resource-batch', resources: [
      { kind: 'Agent', id: 'alice' }, { kind: 'Role', id: 'writer' }, { kind: 'Brain', id: 'codex' },
    ] } });
    expect(resources.list().resources.map(item => `${item.kind}:${item.id}`)).toEqual([
      'Agent:alice', 'Brain:codex', 'Role:writer',
    ]);
  });
  it('leaves no typed effect when a bootstrap mutation makes the mixed graph invalid', async () => {
    const { bootstrap, resources, kernel } = fixture(); const digest = resources.list().digest;
    const revision = createHash('sha256').update(readFileSync(bootstrap)).digest('hex');
    const response = await kernel.execute({ surface: 'web', local: true }, {
      version: 1, requestId: 'mixed-invalid', idempotencyKey: 'mixed-invalid-key', command: {
        operation: 'resource.apply', expectedDigest: digest,
        mutations: [{ mutation: 'create', resource: {
          kind: 'Role', version: 1, id: 'must-not-land', spec: { mission: 'Atomic.' },
        } }],
        bootstrap: { expectedRevision: revision, contents: 'schema_version: [\n' },
      },
    });
    expect(response).toMatchObject({ ok: false });
    expect(() => resources.get('Role', 'must-not-land')).toThrow(/does not exist/u);
    expect(readFileSync(bootstrap, 'utf8')).toContain('schema_version: 2');
  });
  it('reconciles an exact resource effect after a crash before response journaling', async () => {
    const { resources, operations, kernel } = fixture(); const expectedDigest = resources.list().digest;
    const command = { operation: 'resource.create' as const, expectedDigest,
      resource: { kind: 'Role' as const, version: 1 as const, id: 'recovered', spec: { mission: 'Landed.' } } };
    const keyHash = managementDigest('crash-key'); const requestHash = managementDigest(command);
    await resources.create(command.resource, expectedDigest);
    operations.write({ version: 1, keyHash, requestHash,
      principalHash: managementDigest({ authority: 'local' }), phase: 'effecting',
      createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
      checkpoint: { operation: command.operation, resourceVersion: expectedDigest } });
    const response = await kernel.execute({ surface: 'cli', local: true }, {
      version: 1, requestId: 'after-crash', idempotencyKey: 'crash-key', command,
    });
    expect(response).toMatchObject({ ok: true, result: { type: 'resource', resource: { id: 'recovered' } } });
    expect(operations.read(keyHash)).toMatchObject({ phase: 'completed', response: { ok: true } });
  });
  it('reconciles an exact mixed typed and bootstrap effect after a crash', async () => {
    const { bootstrap, resources, operations, kernel } = fixture();
    const expectedDigest = resources.list().digest;
    const expectedRevision = createHash('sha256').update(readFileSync(bootstrap)).digest('hex');
    const bootstrapContents = 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy:\n  marker: recovered\n';
    const command = { operation: 'resource.apply' as const, expectedDigest,
      mutations: [{ mutation: 'create' as const, resource: {
        kind: 'Role' as const, version: 1 as const, id: 'mixed-recovered', spec: { mission: 'Landed.' },
      } }], bootstrap: { expectedRevision, contents: bootstrapContents } };
    const keyHash = managementDigest('mixed-crash-key'); const requestHash = managementDigest(command);
    await resources.apply(command.mutations, expectedDigest, command.bootstrap);
    operations.write({ version: 1, keyHash, requestHash,
      principalHash: managementDigest({ authority: 'local' }), phase: 'effecting',
      createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
      checkpoint: { operation: command.operation, resourceVersion: expectedDigest } });
    const response = await kernel.execute({ surface: 'web', local: true }, {
      version: 1, requestId: 'mixed-after-crash', idempotencyKey: 'mixed-crash-key', command,
    });
    expect(response).toMatchObject({ ok: true, result: { type: 'resource-batch', resources: [
      { kind: 'Role', id: 'mixed-recovered' },
    ] } });
    expect(readFileSync(bootstrap, 'utf8')).toBe(bootstrapContents);
    expect(operations.read(keyHash)).toMatchObject({ phase: 'completed', response: { ok: true } });
  });
  it('fails closed for unauthenticated and conflicting idempotency calls', async () => {
    const { resources, kernel } = fixture(); const digest = resources.list().digest;
    const base = { version: 1 as const, requestId: 'r', idempotencyKey: 'key', command: {
      operation: 'resource.create' as const, expectedDigest: digest,
      resource: { kind: 'Role' as const, version: 1 as const, id: 'one', spec: {} },
    } };
    expect(await kernel.execute({ surface: 'web' }, base)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    await kernel.execute({ surface: 'cli', local: true }, base);
    const conflict = await kernel.execute({ surface: 'cli', local: true }, { ...base,
      command: { ...base.command, resource: { ...base.command.resource, id: 'two' } } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'idempotency_conflict' } });
  });
});
