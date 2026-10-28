import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpSession } from '../src/session/acp.js';
import { CodexAppServerSession } from '../src/session/codex-app-server.js';
import type { CodexAppServerTransportFactory } from '../src/session/codex-app-server-transport.js';
import { SESSION_OWNERSHIP_FILE } from '../src/session/session-ownership.js';
import { TEMP_SUPERVISOR_FILE } from '../src/temp-lifecycle.js';
import { FakeAppServer } from './fixtures/codex-app-server.js';

// A start whose ownership binding fails must release everything it acquired. Evidence classes: the ACP real-child case
// is the one OS-level exit proof; fd checks read this process's real descriptors; fake children/transports prove call
// order and error shape only.
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function stateDir(failure: 'metadata' | 'sidecar'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ownership-start-')); dirs.push(dir);
  if (failure === 'metadata') writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), '{');                  // unreadable metadata
  else {
    // Owned role whose sidecar is corrupt: the writer refuses rather than reset it.
    writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ version: 1, role: 'member', launchId: 'l', taskOwner: { taskId: '0mvrpv4kt1f567911', creationActionId: 'a' } }));
    writeFileSync(join(dir, SESSION_OWNERSHIP_FILE), '{"schema":1');
  }
  return dir;
}
/** Real descriptors of this process that point into the role's ledger. */
const ledgerFds = (dir: string) => readdirSync('/proc/self/fd').flatMap(fd => {
  try { const target = readlinkSync(`/proc/self/fd/${fd}`); return target.startsWith(join(dir, '.conversation')) ? [target] : []; } catch { return []; }
});
const aggregate = (error: unknown) => error instanceof AggregateError ? error.errors : [error];

it.each(['metadata', 'sidecar'] as const)('ACP: a real child is stopped and the ledger fd closed when ownership fails (%s)', async failure => {
  const dir = stateDir(failure), pidFile = join(dir, 'child.pid');
  const start = AcpSession.start({
    name: 'A', argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume();`],
    cwd: dir, stateDir: dir, mode: 'fresh', permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' }, env: {}, log: () => {},
  } as Parameters<typeof AcpSession.start>[0]);
  await expect(start).rejects.toThrow(failure === 'metadata' ? /session ownership unavailable/ : /ownership evidence|JSON|invalid/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  expect(existsSync(`/proc/${pid}`)).toBe(false);                                   // real OS exit, reaped
  expect(ledgerFds(dir)).toEqual([]);
  // No prompt was ever admitted: the ledger holds no ownership binding or prompt.
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
  for (const failure of ['metadata', 'sidecar'] as const) {
    const dir = stateDir(failure), transport = codexTransport(closeRejects, alive);
    const error = await codexStart(dir, transport.factory).then(() => { throw new Error('started'); }, (reason: unknown) => reason);
    const errors = aggregate(error);
    expect(errors).toHaveLength(1 + extra);
    expect(String(errors[0])).toMatch(failure === 'metadata' ? /session ownership unavailable/ : /ownership evidence|JSON|invalid/);
    if (extra) expect((error as AggregateError).cause).toBe(errors[0]);
    if (closeRejects) expect(errors.map(String)).toContain('Error: close failed');
    if (alive) expect(String(errors.at(-1))).toMatch(/pid 4242\) is still running/);
    expect(transport.calls).toEqual(['close']);                                         // never initialized, closed once
    expect(ledgerFds(dir)).toEqual([]);
  }
});

const ledger = (dir: string) => readdirSync(join(dir, '.conversation')).filter(name => name.endsWith('.jsonl'))
  .flatMap(name => readFileSync(join(dir, '.conversation', name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
const acpFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');

it('control: valid standalone metadata starts Codex and binds the generation in the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ownership-ok-')); dirs.push(dir);
  const session = await codexStart(dir, async options => new FakeAppServer(options));
  try { expect(ledger(dir).find(event => event.kind === 'session.ownership')?.payload).toEqual({ launchId: null, taskId: null }); }
  finally { await session.close(); }
});

it('control: valid standalone metadata starts ACP (real fixture agent) and binds the generation in the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ownership-ok-acp-')); dirs.push(dir);
  const session = await AcpSession.start({
    name: 'A', argv: [process.execPath, acpFixture], cwd: dir, stateDir: dir, mode: 'fresh',
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' }, env: {}, log: () => {},
  } as Parameters<typeof AcpSession.start>[0]);
  try { expect(ledger(dir).find(event => event.kind === 'session.ownership')?.payload).toEqual({ launchId: null, taskId: null }); }
  finally { await session.close(); }
});
