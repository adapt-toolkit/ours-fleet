import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const launch = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: launch,
}));

import { startWorkspaceTunnel } from '../../src/web/workspace-tunnel.js';
import { stateRoot } from '../../src/paths.js';

let dir: string;
let stop: (() => Promise<void>) | undefined;
const origin = 'https://fixture.ours-tunnel.com';
const failedChild = () => Object.assign(new EventEmitter(), {
  pid: undefined, exitCode: null, signalCode: null, kill: vi.fn(() => false),
}) as unknown as ChildProcess;

beforeEach(() => {
  vi.useFakeTimers();
  launch.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'workspace-tunnel-'));
  vi.stubEnv('OURS_FLEET_HOME', dir);
  const workspace = join(stateRoot(), 'workspace');
  mkdirSync(workspace, { recursive: true });
  const tokenFile = join(workspace, 'connector');
  writeFileSync(tokenFile, 'fixture-connector', { mode: 0o600 });
  writeFileSync(join(workspace, 'tunnel.json'), JSON.stringify({ origin, tokenFile }));
});

afterEach(async () => {
  const closing = stop?.();
  await vi.runAllTimersAsync();
  await closing;
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it('handles repeated spawn errors and schedules only one retry per child', async () => {
  const first = failedChild(), second = failedChild();
  launch.mockReturnValueOnce(first).mockReturnValueOnce(second);
  stop = startWorkspaceTunnel(origin);
  const missing = Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' });
  first.emit('error', missing);
  expect(() => first.emit('error', missing)).not.toThrow();
  first.emit('close', -2, null);
  expect(launch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(launch).toHaveBeenLastCalledWith('cloudflared', [
    'tunnel', '--no-autoupdate', 'run', '--token-file', join(stateRoot(), 'workspace', 'connector'),
  ], { stdio: 'ignore' });
  await stop();
  second.emit('error', missing);
  second.emit('close', -2, null);
  await vi.advanceTimersByTimeAsync(30000);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(second.kill).not.toHaveBeenCalled();
});

it('stops before a pending failed spawn reports its error without signalling a nonexistent process', async () => {
  const child = failedChild();
  launch.mockReturnValue(child);
  stop = startWorkspaceTunnel(origin);
  const closing = stop();
  child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }));
  child.emit('close', -2, null);
  await vi.advanceTimersByTimeAsync(5000);
  await closing;
  expect(child.kill).not.toHaveBeenCalled();
  expect(launch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('closes a real missing-executable spawn promptly without leaving retry work', () => {
  const module = pathToFileURL(resolve('dist/web/workspace-tunnel.js')).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { startWorkspaceTunnel } from ${JSON.stringify(module)};
    const stop = startWorkspaceTunnel(${JSON.stringify(origin)});
    const started = performance.now();
    await stop();
    await new Promise(resolve => setTimeout(resolve, 25));
    console.log(JSON.stringify({ elapsed: performance.now() - started }));
  `], { env: { ...process.env, PATH: dir }, encoding: 'utf8', timeout: 10000 });
  expect(JSON.parse(output).elapsed).toBeLessThan(2000);
}, 15000);

it('waits for a running child to close and never retries after shutdown', async () => {
  const child = failedChild();
  Object.assign(child, { pid: 12345 });
  vi.mocked(child.kill).mockImplementation(() => {
    child.emit('exit', null, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    return true;
  });
  launch.mockReturnValue(child);
  stop = startWorkspaceTunnel(origin);
  await stop();
  child.emit('error', new Error('late child error'));
  await vi.advanceTimersByTimeAsync(30000);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(launch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
