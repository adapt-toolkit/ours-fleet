import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcpBodyBrainDriver } from '../src/session/acp-body-brain-driver.js';
import { AcpProtocolRuntime, acpProtocolMetadataDigest, type AcpProtocolRuntimeBindings,
  type AcpProtocolRuntimeEvent } from '../src/session/acp-protocol-runtime.js';

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const runtimeBindings = { agentId: 'A', generation: 1, planDigest: sha('a'), snapshotDigest: sha('b'),
  reservationDigest: sha('c'), identityEvidenceDigest: sha('d'), runtimeInstanceKey: sha('e'),
  startEffectKey: sha('f'), adapterDescriptorDigest: sha('1'), providerRuntimeId: 'provider-1' };
const launch = { schemaVersion: 1 as const, adapterId: 'codex-acp' as const, adapterVersion: '1.1.7',
  argv: ['node'], env: {}, translation: { model: 'gpt-5', effort: 'high' } };
const lifecycle = { protocolVersion: 1 as const, generation: 'g1', planDigest: sha('a') };
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');

describe('Acp BodyBrain low-level driver', () => {
  it('binds metadata to the full runtime/adapter/plan tuple', () => {
    const bindings: AcpProtocolRuntimeBindings = { agentId: 'A', generation: 1,
      runtimeInstanceKey: sha('e'), providerRuntimeId: 'provider-1', adapterId: 'codex-acp',
      adapterVersion: '1.1.7', adapterArtifactDigest: sha('1'), planDigest: sha('a') };
    const digest = acpProtocolMetadataDigest('session-1', bindings);
    for (const changed of [
      { ...bindings, agentId: 'B' }, { ...bindings, generation: 2 },
      { ...bindings, runtimeInstanceKey: sha('2') }, { ...bindings, providerRuntimeId: 'provider-2' },
      { ...bindings, adapterVersion: '1.1.8' }, { ...bindings, adapterArtifactDigest: sha('3') },
      { ...bindings, planDigest: sha('4') },
    ]) expect(acpProtocolMetadataDigest('session-1', changed)).not.toBe(digest);
  });

  it('rejects mismatched restore metadata before spawning a child', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'driver-restore-')); dirs.push(stateDir);
    const bindings: AcpProtocolRuntimeBindings = { agentId: 'A', generation: 1,
      runtimeInstanceKey: sha('e'), providerRuntimeId: 'provider-1', adapterId: 'codex-acp',
      adapterVersion: '1.1.7', adapterArtifactDigest: sha('1'), planDigest: sha('a') };
    const runtime = new AcpProtocolRuntime(launch, bindings, stateDir, { cwd: stateDir, env: { PATH: process.env.PATH! } });
    await expect(runtime.restore({ schemaVersion: 1, token: 'session-1', digest: sha('0') }))
      .rejects.toThrow(/metadata mismatch/u);
    expect(runtime.pid).toBe(2_147_483_647);
    expect(existsSync(join(stateDir, '.body-brain-acp-session-id'))).toBe(false);
  });

  it('restores the exact session id without a fresh-session fallback', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'driver-exact-restore-')); dirs.push(stateDir);
    const bindings: AcpProtocolRuntimeBindings = { agentId: 'A', generation: 1,
      runtimeInstanceKey: sha('e'), providerRuntimeId: 'provider-1', adapterId: 'codex-acp',
      adapterVersion: '1.1.7', adapterArtifactDigest: sha('1'), planDigest: sha('a') };
    const actualLaunch = { ...launch, argv: [process.execPath, fixture],
      env: { ACP_FIXTURE_RESUME_SESSION: '1' } };
    const first = new AcpProtocolRuntime(actualLaunch, bindings, stateDir, { cwd: stateDir, env: { PATH: process.env.PATH! } });
    const metadata = await first.start(); await first.cleanup();
    const restored = new AcpProtocolRuntime(actualLaunch, bindings, stateDir, { cwd: stateDir, env: { PATH: process.env.PATH! } });
    await expect(restored.restore(metadata)).resolves.toEqual(metadata);
    await expect(restored.prompt('hello')).resolves.toMatchObject({ stopReason: 'end_turn' });
    await restored.cleanup();
  });

  it('reserves the final locator inode before spawn and refuses every extant tombstone', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'driver-locator-cas-')); dirs.push(stateDir);
    const bindings: AcpProtocolRuntimeBindings = { agentId: 'A', generation: 1,
      runtimeInstanceKey: sha('e'), providerRuntimeId: 'provider-1', adapterId: 'codex-acp',
      adapterVersion: '1.1.7', adapterArtifactDigest: sha('1'), planDigest: sha('a') };
    const actualLaunch = { ...launch, argv: [process.execPath, fixture] };
    const context = { cwd: stateDir, env: { PATH: process.env.PATH! } };
    const first = new AcpProtocolRuntime(actualLaunch, bindings, stateDir, context);
    await expect(first.start()).resolves.toMatchObject({ schemaVersion: 1, token: 'fixture-session' });
    expect(readFileSync(join(stateDir, '.body-brain-acp-session-id'), 'utf8')).toBe('fixture-session\n');
    await first.cleanup();
    const retry = new AcpProtocolRuntime(actualLaunch, bindings, stateDir, context);
    await expect(retry.start()).rejects.toThrow(); expect(retry.pid).toBe(2_147_483_647);

    rmSync(join(stateDir, '.body-brain-acp-session-id')); writeFileSync(join(stateDir, '.body-brain-acp-session-id'), '', { mode: 0o600 });
    const emptyRestore = new AcpProtocolRuntime(actualLaunch, bindings, stateDir, context);
    const metadata = { schemaVersion: 1 as const, token: 'fixture-session',
      digest: acpProtocolMetadataDigest('fixture-session', bindings) };
    await expect(emptyRestore.restore(metadata)).rejects.toThrow(/locator mismatch/u);
    expect(emptyRestore.pid).toBe(2_147_483_647);
    writeFileSync(join(stateDir, '.body-brain-acp-session-id'), 'fixture-', { mode: 0o600 });
    const partialRestore = new AcpProtocolRuntime(actualLaunch, bindings, stateDir, context);
    await expect(partialRestore.restore(metadata)).rejects.toThrow(/locator mismatch/u);
    expect(partialRestore.pid).toBe(2_147_483_647);
  });

  it('rejects unsafe state directories and locator symlinks or modes before spawn', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'driver-locator-security-')); dirs.push(stateDir);
    const bindings: AcpProtocolRuntimeBindings = { agentId: 'A', generation: 1,
      runtimeInstanceKey: sha('e'), providerRuntimeId: 'provider-1', adapterId: 'codex-acp',
      adapterVersion: '1.1.7', adapterArtifactDigest: sha('1'), planDigest: sha('a') };
    const context = { cwd: stateDir, env: { PATH: process.env.PATH! } };
    chmodSync(stateDir, 0o755);
    expect(() => new AcpProtocolRuntime(launch, bindings, stateDir, context)).toThrow(/state directory/u);
    chmodSync(stateDir, 0o700);
    const target = join(stateDir, 'target'); writeFileSync(target, 'fixture-session\n', { mode: 0o600 });
    symlinkSync(target, join(stateDir, '.body-brain-acp-session-id'));
    const linked = new AcpProtocolRuntime(launch, bindings, stateDir, context);
    await expect(linked.restore({ schemaVersion: 1, token: 'fixture-session',
      digest: acpProtocolMetadataDigest('fixture-session', bindings) })).rejects.toThrow(/unsafe/u);
    expect(linked.pid).toBe(2_147_483_647);
  });

  it('detects locator inode substitution races and preserves crash-before-publication tombstones', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'driver-locator-race-')); dirs.push(stateDir);
    const bindings: AcpProtocolRuntimeBindings = { agentId: 'A', generation: 1,
      runtimeInstanceKey: sha('e'), providerRuntimeId: 'provider-1', adapterId: 'codex-acp',
      adapterVersion: '1.1.7', adapterArtifactDigest: sha('1'), planDigest: sha('a') };
    const locator = join(stateDir, '.body-brain-acp-session-id');
    writeFileSync(locator, 'fixture-session\n', { mode: 0o600 });
    const metadata = { schemaVersion: 1 as const, token: 'fixture-session',
      digest: acpProtocolMetadataDigest('fixture-session', bindings) };
    const raced = new AcpProtocolRuntime(launch, bindings, stateDir, { cwd: stateDir, env: {} }, () => {}, {
      beforeLocatorOpen: () => { rmSync(locator); writeFileSync(locator, 'fixture-session\n', { mode: 0o600 }); },
    });
    await expect(raced.restore(metadata)).rejects.toThrow(/unsafe/u); expect(raced.pid).toBe(2_147_483_647);

    rmSync(locator);
    const crash = new AcpProtocolRuntime({ ...launch, argv: ['/definitely/missing/acp'] }, bindings, stateDir,
      { cwd: stateDir, env: {} });
    await expect(crash.start()).rejects.toThrow();
    expect(readFileSync(locator)).toHaveLength(0);
    const retry = new AcpProtocolRuntime(launch, bindings, stateDir, { cwd: stateDir, env: {} });
    await expect(retry.start()).rejects.toThrow(); expect(retry.pid).toBe(2_147_483_647);
  });

  it('constructs no semantic durable store and settles prompt failure, permission and exit once', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'driver-owner-')); dirs.push(stateDir);
    let deliver: ((event: AcpProtocolRuntimeEvent) => void) | undefined;
    const settle = vi.fn(); const reject = vi.fn(); const close = vi.fn(async () => undefined);
    const port = { pid: 42, subscribe: (fn: typeof deliver) => { deliver = fn; return () => undefined; },
      start: vi.fn(async () => ({ schemaVersion: 1 as const, token: 'session-1', digest: sha('2') })),
      restore: vi.fn(), prompt: vi.fn(async () => { throw new Error('rejected'); }),
      cancel: vi.fn(async () => undefined), close, cleanup: vi.fn(async () => undefined) };
    const driver = createAcpBodyBrainDriver(stateDir, runtimeBindings, { cwd: stateDir, env: {} }, () => port);
    expect(existsSync(join(stateDir, '.conversation'))).toBe(false);
    expect(existsSync(join(stateDir, '.session-events.jsonl'))).toBe(false);
    const notifications: Array<Record<string, unknown>> = []; driver.subscribe(value => notifications.push(value as never));
    await expect(driver.start({ launch, lifecycle })).resolves.toMatchObject({ state: 'accepted' });
    deliver?.({ kind: 'permission', permissionId: 'perm-1', optionIds: ['allow'], settle, reject });
    await expect(driver.respondPermission({ generation: 'g1', commandId: 'c2', permissionId: 'perm-1',
      optionId: 'allow' })).resolves.toEqual({ state: 'accepted' });
    expect(settle).toHaveBeenCalledOnce();
    await expect(driver.submit({ generation: 'g1', commandId: 'c1', promptId: 'p1',
      origin: { kind: 'startup' } }, new TextEncoder().encode('hello'))).resolves.toEqual({ state: 'accepted' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(notifications.filter(value => value.kind === 'failed')).toHaveLength(1);
    deliver?.({ kind: 'exit', code: 'lost' });
    deliver?.({ kind: 'exit', code: 'lost' });
    expect(notifications.filter(value => value.kind === 'exited')).toHaveLength(0);
    await driver.cleanup(); expect(reject).not.toHaveBeenCalled();
  });

  it('rejects both duplicate permission requests exactly once instead of overwriting either', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'driver-duplicate-permission-')); dirs.push(stateDir);
    let deliver: ((event: AcpProtocolRuntimeEvent) => void) | undefined;
    const port = { pid: 42, subscribe: (fn: typeof deliver) => { deliver = fn; return () => undefined; },
      start: vi.fn(async () => ({ schemaVersion: 1 as const, token: 'session-1', digest: sha('2') })),
      restore: vi.fn(), prompt: vi.fn(), cancel: vi.fn(), close: vi.fn(), cleanup: vi.fn(async () => undefined) };
    const driver = createAcpBodyBrainDriver(stateDir, runtimeBindings, { cwd: stateDir, env: {} }, () => port);
    const notifications: Array<Record<string, unknown>> = []; driver.subscribe(value => notifications.push(value as never));
    await driver.start({ launch, lifecycle });
    const firstReject = vi.fn(); const duplicateReject = vi.fn();
    deliver?.({ kind: 'permission', permissionId: 'same', optionIds: ['allow'], settle: vi.fn(), reject: firstReject });
    deliver?.({ kind: 'permission', permissionId: 'same', optionIds: ['allow'], settle: vi.fn(), reject: duplicateReject });
    expect(firstReject).toHaveBeenCalledOnce(); expect(duplicateReject).toHaveBeenCalledOnce();
    expect(notifications.at(-1)).toMatchObject({ kind: 'failed', code: 'protocol_error' });
    await driver.cleanup(); expect(firstReject).toHaveBeenCalledOnce(); expect(duplicateReject).toHaveBeenCalledOnce();
  });

  it('fails restore without fresh start and settles cleanup/forced exit exactly once', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'driver-terminal-')); dirs.push(stateDir);
    let deliver: ((event: AcpProtocolRuntimeEvent) => void) | undefined;
    const reject = vi.fn(); const close = vi.fn(async () => { deliver?.({ kind: 'exit', code: 'forced' }); });
    const port = { pid: 9, subscribe: (fn: typeof deliver) => { deliver = fn; return () => undefined; },
      start: vi.fn(), restore: vi.fn(async () => { throw new Error('restore rejected'); }),
      prompt: vi.fn(), cancel: vi.fn(async () => undefined), close,
      cleanup: vi.fn(async () => undefined) };
    const failed = createAcpBodyBrainDriver(stateDir, runtimeBindings, { cwd: stateDir, env: {} }, () => port);
    const restoreLifecycle = { ...lifecycle,
      sessionMetadata: { schemaVersion: 1 as const, token: 'session-1', digest: sha('2') } };
    await expect(failed.restore({ launch, lifecycle: restoreLifecycle })).resolves
      .toEqual({ state: 'failed', code: 'adapter_rejected' });
    expect(port.start).not.toHaveBeenCalled();

    const activePort = { ...port, restore: vi.fn(),
      start: vi.fn(async () => ({ schemaVersion: 1 as const, token: 'session-1', digest: sha('2') })) };
    const active = createAcpBodyBrainDriver(stateDir, runtimeBindings, { cwd: stateDir, env: {} }, () => activePort);
    const notifications: Array<Record<string, unknown>> = []; active.subscribe(value => notifications.push(value as never));
    await active.start({ launch, lifecycle });
    deliver?.({ kind: 'permission', permissionId: 'pending', optionIds: ['allow'], settle: vi.fn(), reject });
    await expect(active.cancel({ generation: 'g1', commandId: 'cancel' })).resolves.toEqual({ state: 'accepted' });
    await expect(active.forceTerminate({ generation: 'g1', commandId: 'force' })).resolves.toEqual({ state: 'accepted' });
    expect(notifications.filter(value => value.kind === 'exited')).toHaveLength(1);
    await active.cleanup(); await active.cleanup(); expect(reject).toHaveBeenCalledOnce();
  });
});
