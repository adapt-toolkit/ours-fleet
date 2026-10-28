import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
// Parent-side capture of every child the ACP start spawns: the test owns exactly these and tears down only them.
const spawned = vi.hoisted(() => [] as ChildProcess[]);
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: ((...args: Parameters<typeof actual.spawn>) => { const child = actual.spawn(...args); spawned.push(child); return child; }) as typeof actual.spawn };
});
import { AcpSession } from '../src/session/acp.js';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import { CodexAppServerSession } from '../src/session/codex-app-server.js';
import type { CodexAppServerTransportFactory } from '../src/session/codex-app-server-transport.js';
import { SESSION_OWNERSHIP_FILE } from '../src/session/session-ownership.js';
import { TEMP_SUPERVISOR_FILE } from '../src/temp-lifecycle.js';
import { FakeAppServer } from './fixtures/codex-app-server.js';

// A start whose ownership binding fails must release everything it acquired. Evidence classes: the ACP real-child case
// is the one OS-level exit proof; fd checks read this process's real descriptors (acquired-then-released, not fsync
// failure); fake children/transports prove call order and error shape only.
const dirs: string[] = [];
/** Bounded wait for a captured child's exit event (Node reaps it on exit). */
const exitWithin = (child: ChildProcess, ms: number) => new Promise<boolean>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
  const settle = (exited: boolean) => { clearTimeout(timer); child.off('exit', onExit); resolve(exited); };
  const onExit = () => settle(true), timer = setTimeout(() => settle(false), ms);
  child.on('exit', onExit);
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  // Only children this file spawned. Any still running (an assertion failed first, or a close only sent TERM) is stopped
  // TERM, then KILL, each with a bounded wait; a child not proven exited fails the test with its pid.
  const survivors: number[] = [];
  for (const child of spawned.splice(0)) {
    if (await exitWithin(child, 0)) continue;
    child.kill('SIGTERM');
    if (await exitWithin(child, 2_000)) continue;
    child.kill('SIGKILL');
    if (!await exitWithin(child, 2_000)) survivors.push(child.pid ?? -1);
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(survivors, 'captured children not proven exited').toEqual([]);
});
const OWNED = JSON.stringify({ version: 1, role: 'member', launchId: 'l', taskOwner: { taskId: '0mvrpv4kt1f567911', creationActionId: 'a' } });
type Failure = 'metadata' | 'sidecar' | 'append';
/** `append`: a valid owned role whose durable ledger append fails AFTER the ledger descriptor was opened (see failAppend). */
function stateDir(failure: Failure): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ownership-start-')); dirs.push(dir);
  if (failure === 'metadata') writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), '{');                  // unreadable metadata
  else if (failure === 'append') writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), OWNED);
  else {
    // Owned role whose sidecar is corrupt: the writer refuses rather than reset it.
    writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), OWNED);
    writeFileSync(join(dir, SESSION_OWNERSHIP_FILE), '{"schema":1');
  }
  return dir;
}
/** Real descriptors of this process that point into the role's ledger. */
const ledgerFds = (dir: string) => readdirSync('/proc/self/fd').flatMap(fd => {
  try { const target = readlinkSync(`/proc/self/fd/${fd}`); return target.startsWith(join(dir, '.conversation')) ? [target] : []; } catch { return []; }
});
const aggregate = (error: unknown) => error instanceof AggregateError ? error.errors : [error];
const expected: Record<Failure, RegExp> = { metadata: /session ownership unavailable/, sidecar: /JSON/, append: /durable append failed/ };
/** The real append runs (opening the ledger descriptor and writing), then the call throws. This proves only that an
 * acquired ledger descriptor is released when the ownership append fails; it does not simulate a real write/fsync
 * failure or cover the durability fence (the existing conversation-store fence tests do). Records the descriptors held
 * at that moment, so a test can prove one was acquired before asserting it was released. */
function failAppend(dir: string): { held: string[] } {
  const seen = { held: [] as string[] }, real = ConversationEventStore.prototype.append;
  vi.spyOn(ConversationEventStore.prototype, 'append').mockImplementation(function (this: ConversationEventStore, draft) {
    real.call(this, draft); seen.held = ledgerFds(dir); throw new Error('durable append failed');
  });
  return seen;
}

it.each(['metadata', 'sidecar', 'append'] as const)('ACP: the real spawned child is stopped and the ledger fd closed when ownership fails (%s)', async failure => {
  const dir = stateDir(failure), append = failure === 'append' ? failAppend(dir) : undefined;
  const start = AcpSession.start({
    name: 'A', argv: [process.execPath, '-e', 'process.stdin.resume();'],
    cwd: dir, stateDir: dir, mode: 'fresh', permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' }, env: {}, log: () => {},
  } as Parameters<typeof AcpSession.start>[0]);
  await expect(start).rejects.toThrow(expected[failure]);
  // The pid comes from the parent's own ChildProcess, captured at spawn: no race with the child writing anything.
  expect(spawned).toHaveLength(1);
  const [child] = spawned;
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(existsSync(`/proc/${child.pid}`)).toBe(false);                             // real OS exit, reaped
  if (append) expect(append.held.length).toBeGreaterThan(0);                       // a descriptor was acquired…
  expect(ledgerFds(dir)).toEqual([]);                                               // …and released
  // No prompt was ever admitted (an `append` failure may leave the ownership event itself; never a prompt).
  expect(existsSync(join(dir, '.conversation')) ? readdirSync(join(dir, '.conversation')).filter(name => name.endsWith('.jsonl'))
    .flatMap(name => readFileSync(join(dir, '.conversation', name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).kind)) : [])
    .not.toContain('prompt.admitted');
});

/** Fake child for the helper: `exitOn` names the signal that makes it exit; `throwOn` signals make kill() throw. */
function fakeChild(options: { exitOn?: NodeJS.Signals; throwOn?: NodeJS.Signals[] }) {
  const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, signals: [] as string[],
    kill(signal: NodeJS.Signals) {
      child.signals.push(signal);
      if (options.throwOn?.includes(signal)) throw new Error(`kill ${signal} failed`);
      if (signal === options.exitOn) queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); });
      return true;
    } });
  return child;
}
const release = (child: unknown, connection: { close(): void }, error: unknown) =>
  (AcpSession as unknown as { releaseFailedStart(c: unknown, k: unknown, e: unknown): Promise<unknown> }).releaseFailedStart(child, connection, error);

it('ACP helper: TERM-resistant child gets KILL; a proven exit returns the original error alone; no exit listener remains', async () => {
  vi.useFakeTimers();
  const child = fakeChild({ exitOn: 'SIGKILL' }), order: string[] = [], original = new Error('ownership');
  const connection = { close: () => { order.push(`close@${child.signals.length}`); } };
  const result = release(child, connection, original);
  await vi.advanceTimersByTimeAsync(2_500);
  expect(await result).toBe(original);
  expect(order).toEqual(['close@0']);                                               // connection disposed before any signal
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(child.listenerCount('exit')).toBe(0);
});

it('ACP helper: close() throws and the child never exits → every failure kept, pid named, no early rejection', async () => {
  vi.useFakeTimers();
  const child = fakeChild({}), original = new Error('ownership'), closeError = new Error('close failed');
  const result = release(child, { close: () => { throw closeError; } }, original);
  await vi.advanceTimersByTimeAsync(5_000);
  const error = await result as AggregateError;
  expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(original);
  expect(error.errors.slice(0, 2)).toEqual([original, closeError]);
  expect(String(error.errors.at(-1))).toMatch(/pid 4242\) is still running/);
  expect(child.listenerCount('exit')).toBe(0);
});

it.each([
  ['kill() throws', { throwOn: ['SIGTERM', 'SIGKILL'] as NodeJS.Signals[] }, false],
  ['close() and kill() both throw', { throwOn: ['SIGTERM', 'SIGKILL'] as NodeJS.Signals[] }, true],
])('ACP helper: %s → original, cleanup errors and "exit unproven" with the pid', async (_name, options, closeThrows) => {
  vi.useFakeTimers();
  const child = fakeChild(options), original = new Error('ownership'), closeError = new Error('close failed');
  const result = release(child, { close: () => { if (closeThrows) throw closeError; } }, original);
  await vi.advanceTimersByTimeAsync(5_000);
  const errors = aggregate(await result);
  expect(errors[0]).toBe(original);
  if (closeThrows) expect(errors).toContain(closeError);
  expect(errors.map(String).filter(text => /kill SIG(TERM|KILL) failed/.test(text))).toHaveLength(2);
  expect(String(errors.at(-1))).toMatch(/pid 4242\) exit unproven/);
  expect(child.listenerCount('exit')).toBe(0);
});

/** Codex fake transport whose close outcome and liveness after close are scripted; records requests. */
function codexTransport(closeRejects: boolean, aliveAfterClose: boolean) {
  const calls: string[] = [];
  const factory: CodexAppServerTransportFactory = async options => {
    const server = new FakeAppServer(options), request = server.request.bind(server);
    let closed = false;
    server.request = async <T = unknown>(method: string, params: Record<string, unknown> = {}) => { calls.push(method); return request<T>(method, params); };
    server.close = async () => { calls.push('close'); closed = true; if (closeRejects) throw new Error('close failed'); };
    server.isAlive = () => !closed || aliveAfterClose;
    return server;
  };
  return { calls, factory };
}
const codexStart = (dir: string, factory: CodexAppServerTransportFactory) => CodexAppServerSession.start({
  name: 'NativeCodex', argv: ['codex', 'app-server'], cwd: dir, env: {}, stateDir: dir, mode: 'fresh',
  permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'wait' }, permissionMode: { fleetMode: 'allow', nativeMode: 'never' },
  model: 'gpt-fixture', effort: 'medium', approvalPolicy: 'never', sandbox: 'workspace-write', log: () => {},
} as Parameters<typeof CodexAppServerSession.start>[0], factory);

it.each([
  [false, false, 0], [false, true, 1], [true, false, 1], [true, true, 2],
] as const)('Codex: close rejects=%s, alive after close=%s → original plus %i cleanup failure(s); no initialize; fd closed', async (closeRejects, alive, extra) => {
  for (const failure of ['metadata', 'sidecar', 'append'] as const) {
    const dir = stateDir(failure), transport = codexTransport(closeRejects, alive);
    const append = failure === 'append' ? failAppend(dir) : undefined;
    const error = await codexStart(dir, transport.factory).then(() => { throw new Error('started'); }, (reason: unknown) => reason);
    const errors = aggregate(error);
    expect(errors).toHaveLength(1 + extra);
    expect(String(errors[0])).toMatch(expected[failure]);
    if (extra) expect((error as AggregateError).cause).toBe(errors[0]);
    if (closeRejects) expect(errors.map(String)).toContain('Error: close failed');
    if (alive) expect(String(errors.at(-1))).toMatch(/pid 4242\) is still running/);
    expect(transport.calls).toEqual(['close']);                                         // never initialized, closed once
    if (append) expect(append.held.length).toBeGreaterThan(0);
    expect(ledgerFds(dir)).toEqual([]);
    vi.restoreAllMocks();
  }
});

const ledger = (dir: string) => readdirSync(join(dir, '.conversation')).filter(name => name.endsWith('.jsonl'))
  .flatMap(name => readFileSync(join(dir, '.conversation', name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
const acpFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');

it('control: valid standalone metadata starts Codex and binds the generation in the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ownership-ok-')); dirs.push(dir);
  const session = await codexStart(dir, async options => new FakeAppServer(options));
  try {
    const binding = ledger(dir).find(event => event.kind === 'session.ownership');
    expect(binding?.payload).toEqual({ launchId: null, taskId: null });
    const page = session.conversationPage({ limit: 1000 });
    expect(page.events.find(event => event.kind === 'session.ownership')).toEqual(binding);
    expect(page.events.map(event => event.seq)).toEqual(ledger(dir)
      .filter(event => event.sessionGeneration === page.snapshot.sessionGeneration && event.source !== 'agent_replay')
      .map(event => event.seq));
  }
  finally { await session.close(); }
});

it('control: valid standalone metadata starts ACP (real fixture agent) and binds the generation in the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ownership-ok-acp-')); dirs.push(dir);
  const session = await AcpSession.start({
    name: 'A', argv: [process.execPath, acpFixture], cwd: dir, stateDir: dir, mode: 'fresh',
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' }, env: {}, log: () => {},
  } as Parameters<typeof AcpSession.start>[0]);
  try {
    const binding = ledger(dir).find(event => event.kind === 'session.ownership');
    expect(binding?.payload).toEqual({ launchId: null, taskId: null });
    const page = session.conversationPage({ limit: 1000 });
    expect(page.events.find(event => event.kind === 'session.ownership')).toEqual(binding);
    expect(page.events.map(event => event.seq)).toEqual(ledger(dir)
      .filter(event => event.sessionGeneration === page.snapshot.sessionGeneration && event.source !== 'agent_replay')
      .map(event => event.seq));
  }
  finally { await session.close(); }
});
