import '../src/harness/claude-code.js';
import '../src/harness/codex.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, watch as nativeWatch, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { controlSocketPath } from '../src/session/control.js';
import { ConversationRoleObserver } from '../src/application/conversation-role-observer.js';

const writePrivate = (path: string, data: string) => writeFileSync(path, data, { mode: 0o600 });
const mkdirPrivate = (path: string, options: { recursive?: boolean } = {}) => mkdirSync(path, { ...options, mode: 0o700 });

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.useRealTimers(); });
function fixture(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'role-watch-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'fleet.yaml');
  const config = join(root, 'fleet');
  const agents = join(config, 'agents');
  const permanentRoot = join(root, 'state', 'agents');
  const temporaryRoot = join(root, 'state', 'tmp');
  const dir = join(permanentRoot, 'A');
  for (const path of [agents, dir, temporaryRoot]) mkdirPrivate(path, { recursive: true });
  writePrivate(configPath, 'api_version: ours.network/fleet/v2\n');
  const role = (harness = 'claude-code', session = 'acp') =>
    `role:\n  inline: {}\nbrain:\n  inline:\n    harness: ${harness}\n    session: ${session}\n`;
  writePrivate(join(agents, 'A.yaml'), role());
  writePrivate(join(dir, '.control-token'), 'one');
  writePrivate(controlSocketPath(dir), '');
  loadConfig(configPath);
  const states: any[] = [];
  const observer = new ConversationRoleObserver({ roleId: 'A', configPath, permanentRoot, temporaryRoot, ...extra }, s => states.push(s));
  cleanup.push(() => observer.dispose());
  return { root, configPath, config, agents, dir, role, states, observer };
}
it('observes atomic configuration rename and retains its own ordered revision', async () => {
  const f = fixture();
  expect(f.observer.snapshot()).toMatchObject({ availability: 'available', fallbackHarness: 'claude-code', health: 'healthy' });
  const before = f.observer.snapshot();
  writePrivate(join(f.agents, 'next'), f.role('codex'));
  renameSync(join(f.agents, 'next'), join(f.agents, 'A.yaml'));
  await expect.poll(() => f.observer.snapshot()).toMatchObject({ fallbackHarness: 'codex', health: 'healthy' });
  expect(f.observer.snapshot().roleRevision).toBeGreaterThan(before.roleRevision);
  expect(f.observer.snapshot()).not.toHaveProperty('stateRevision');
});
it('reinstalls parent watchers after config directory replacement', async () => {
  const f = fixture();
  renameSync(f.config, f.config + '-old');
  mkdirPrivate(f.agents, { recursive: true });
  writePrivate(join(f.agents, 'A.yaml'), f.role('codex'));
  await expect.poll(() => f.observer.snapshot()).toMatchObject({ fallbackHarness: 'codex', health: 'healthy' });
  writePrivate(join(f.agents, 'A.yaml'), f.role());
  await expect.poll(() => f.observer.snapshot().fallbackHarness).toBe('claude-code');
});
it('orders missing/recreated role and backend/control/state replacements independently', async () => {
  const f = fixture();
  const original = f.observer.snapshot().roleLifetime;
  rmSync(f.dir, { recursive: true });
  rmSync(join(f.agents, 'A.yaml'));
  await expect.poll(() => f.observer.snapshot().availability).toBe('missing');
  mkdirPrivate(f.dir); writePrivate(controlSocketPath(f.dir), ''); writePrivate(join(f.dir, '.control-token'), 'two');
  writePrivate(join(f.agents, 'A.yaml'), f.role('codex', 'codex-app-server'));
  await expect.poll(() => f.observer.snapshot().backend).toBe('codex-app-server');
  expect(f.observer.snapshot().roleLifetime).not.toBe(original);
  const current = f.observer.snapshot().roleLifetime;
  writePrivate(join(f.dir, '.control-token'), 'three');
  await expect.poll(() => f.observer.snapshot().roleLifetime).not.toBe(current);
  const next = f.observer.snapshot().roleLifetime;
  renameSync(f.dir, f.dir + '-old'); mkdirPrivate(f.dir);
  writePrivate(controlSocketPath(f.dir), ''); writePrivate(join(f.dir, '.control-token'), 'four');
  await expect.poll(() => f.observer.snapshot().roleLifetime).not.toBe(next);
  expect(f.states.map(s => s.roleRevision)).toEqual([...new Set(f.states.map(s => s.roleRevision))].sort((a,b) => a-b));
});
it('reports watcher errors, distinguishes unsupported environments and disposes handles', () => {
  const watchers: any[] = [];
  const f = fixture({ watch: () => { const w = new EventEmitter() as any; w.close = vi.fn(); watchers.push(w); return w; } });
  watchers[0].emit('error', new Error('lost watch'));
  expect(f.observer.snapshot()).toMatchObject({ health: 'failed', failure: 'watch-error' });
  expect(watchers.every(w => w.close.mock.calls.length === 1)).toBe(true);
  const unsupported = fixture({ watch: () => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }); } });
  expect(unsupported.observer.snapshot()).toMatchObject({ health: 'unsupported', failure: 'watch-unsupported' });
});
it('direct mutation signals reread without periodic snapshot sampling and dispose their subscription', async () => {
  let notify = () => {}; const detach = vi.fn();
  const f = fixture({ subscribeMutations: (listener: () => void) => { notify = listener; return detach; }, watch: () => { const w = new EventEmitter() as any; w.close = () => {}; return w; } });
  writePrivate(join(f.agents, 'A.yaml'), f.role('codex'));
  notify();
  await expect.poll(() => f.observer.snapshot()).toMatchObject({ fallbackHarness: 'codex', health: 'healthy' });
  f.observer.dispose(); expect(detach).toHaveBeenCalledOnce();
});

it('observes atomic manifest rename and recovers after a missing manifest', async () => {
  const f = fixture();
  writePrivate(join(f.agents, 'A.yaml'), f.role('${harness}'));
  writePrivate(f.configPath + '.new', 'api_version: ours.network/fleet/v2\nvars:\n  harness: codex\n');
  renameSync(f.configPath + '.new', f.configPath);
  await expect.poll(() => f.observer.snapshot().fallbackHarness).toBe('codex');
  rmSync(f.configPath);
  await expect.poll(() => f.observer.snapshot().availability).toBe('unavailable');
  writePrivate(f.configPath, 'api_version: ours.network/fleet/v2\nvars:\n  harness: claude-code\n');
  await expect.poll(() => f.observer.snapshot()).toMatchObject({ availability: 'available', fallbackHarness: 'claude-code' });
});
it('does not sample changed role data without a mutation notification', async () => {
  vi.useFakeTimers();
  const f = fixture({ watch: () => { const w = new EventEmitter() as any; w.close = () => {}; return w; } });
  writePrivate(join(f.agents, 'A.yaml'), f.role('codex'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.observer.snapshot().fallbackHarness).toBe('claude-code');
  expect(vi.getTimerCount()).toBe(0);
});

it('registers a coherent subscriber that survives missing and recreated role, with idempotent cleanup', async () => {
  const f = fixture(); const changes: any[] = [];
  const subscription = f.observer.subscribe(state => changes.push(state));
  expect(subscription.snapshot).toEqual(f.observer.snapshot());
  rmSync(f.dir, { recursive: true }); rmSync(join(f.agents, 'A.yaml'));
  await expect.poll(() => changes.at(-1)?.availability).toBe('missing');
  mkdirPrivate(f.dir); writePrivate(controlSocketPath(f.dir), ''); writePrivate(join(f.dir, '.control-token'), 'new');
  writePrivate(join(f.agents, 'A.yaml'), f.role());
  await expect.poll(() => changes.at(-1)?.availability).toBe('available');
  subscription.unsubscribe(); subscription.unsubscribe();
  const count = changes.length;
  writePrivate(join(f.agents, 'A.yaml'), f.role('codex'));
  await expect.poll(() => f.observer.snapshot().fallbackHarness).toBe('codex');
  expect(changes).toHaveLength(count);
});
it('uses repository-compatible defaults for temporary role snapshots', async () => {
  const f = fixture();
  // Establish native watcher delivery before replacing the entire initial role.
  writePrivate(join(f.agents, 'A.yaml'), f.role('codex'));
  await expect.poll(() => f.observer.snapshot().fallbackHarness).toBe('codex');
  rmSync(f.dir, { recursive: true }); rmSync(join(f.agents, 'A.yaml'));
  await expect.poll(() => f.observer.snapshot().availability).toBe('missing');
  const temporary = join(f.root, 'state', 'tmp', 'A');
  mkdirPrivate(temporary); writePrivate(join(temporary, 'role.yaml'), '{}\n');
  writePrivate(controlSocketPath(temporary), ''); writePrivate(join(temporary, '.control-token'), 'temp');
  await expect.poll(() => f.observer.snapshot()).toMatchObject({ stateDir: temporary, availability: 'available', backend: 'acp', fallbackHarness: 'claude-code' });
});

it('withdraws complete delivery and closes follow when a current watcher closes unexpectedly', async () => {
  const watchers: FSWatcher[] = [];
  const f = fixture({ watch: (path: string, listener: (event: string, name: string | null) => void) => {
    const handle = nativeWatch(path, { persistent: false }, listener); watchers.push(handle); return handle;
  } });
  const { RoleSessionControlAdapter } = await import('../src/application/session-control.js');
  const socket = new EventEmitter() as any;
  const close = vi.fn(); const onClose = vi.fn();
  const adapter = new RoleSessionControlAdapter(f.dir,
    (async () => ({ ok: true, result: { backend: 'acp', features: ['conversation_observation', 'control_heartbeat'] } })) as any,
    (async () => ({ socket, close })) as any);
  expect((await adapter.describe(f.observer)).features).toContain('conversation_live_complete');
  const follow = await adapter.followConversation({ controller: false, expectedGeneration: 'g', roleObservation: f.observer,
    onReplay: () => {}, onReady: () => {}, onState: () => {}, onEvent: () => {}, onClose });
  cleanup.push(() => follow.close());
  await new Promise<void>(resolve => { watchers[0].once('close', resolve); watchers[0].close(); });
  expect(f.observer.snapshot()).toMatchObject({ health: 'failed', failure: 'watch-closed' });
  expect(onClose).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledWith('watch-closed');
  expect(close).toHaveBeenCalledOnce();
  expect((await adapter.describe(f.observer)).features).not.toContain('conversation_live_complete');
});
it('ignores expected watcher closes during replacement and disposal, including late close events', async () => {
  let notify = () => {};
  const watchers: Array<{ path: string; handle: EventEmitter; close: ReturnType<typeof vi.fn> }> = [];
  const f = fixture({ subscribeMutations: (listener: () => void) => { notify = listener; return () => {}; }, watch: (path: string) => {
    const handle = new EventEmitter() as any;
    const close = vi.fn(() => { handle.emit('close'); queueMicrotask(() => handle.emit('close')); });
    handle.close = close; watchers.push({ path, handle, close }); return handle;
  } });
  renameSync(f.config, f.config + '-old'); mkdirPrivate(f.agents, { recursive: true });
  writePrivate(join(f.agents, 'A.yaml'), f.role('codex')); notify();
  await expect.poll(() => f.observer.snapshot()).toMatchObject({ health: 'healthy', fallbackHarness: 'codex' });
  expect(watchers.some(w => w.close.mock.calls.length > 0)).toBe(true);
  f.observer.dispose(); await Promise.resolve();
  expect(f.states.every(state => state.health === 'healthy')).toBe(true);
  expect(watchers.every(w => w.close.mock.calls.length === 1)).toBe(true);
});
it('observes the actual control socket when a private socket root is configured', async () => {
  const socketRoot = mkdtempSync(join(tmpdir(), 'r-'));
  cleanup.push(() => rmSync(socketRoot, { recursive: true, force: true }));
  const previous = process.env.OURS_FLEET_SOCKET_ROOT;
  process.env.OURS_FLEET_SOCKET_ROOT = socketRoot;
  cleanup.push(() => { if (previous === undefined) delete process.env.OURS_FLEET_SOCKET_ROOT; else process.env.OURS_FLEET_SOCKET_ROOT = previous; });
  const f = fixture();
  expect(f.observer.snapshot().availability).toBe('available');
  const before = f.observer.snapshot().roleLifetime;
  const path = controlSocketPath(f.dir);
  renameSync(path, path + '.old'); writePrivate(path, '');
  await expect.poll(() => f.observer.snapshot().roleLifetime).not.toBe(before);
  expect(f.observer.snapshot()).toMatchObject({ availability: 'available', health: 'healthy' });
});
