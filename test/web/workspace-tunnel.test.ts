import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const launch = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: launch,
}));

import type { Exec } from '../../src/exec.js';
import { startWorkspaceTunnel } from '../../src/web/workspace-tunnel.js';
import { stateRoot } from '../../src/paths.js';

let dir: string;
let stop: (() => Promise<void>) | undefined;
const currentConnector: Exec = async () => ({code:0,stdout:'cloudflared version 2026.10.2 (built fixture)',stderr:''});
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
  stop = await startWorkspaceTunnel(origin, currentConnector);
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
  stop = await startWorkspaceTunnel(origin, currentConnector);
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
    // A verified connector that disappears before spawn: the real spawn fails with ENOENT.
    const stop = await startWorkspaceTunnel(${JSON.stringify(origin)}, async () => ({ code: 0, stdout: 'cloudflared version 2026.10.2', stderr: '' }));
    const started = performance.now();
    await stop();
    await new Promise(resolve => setTimeout(resolve, 25));
    console.log(JSON.stringify({ elapsed: performance.now() - started }));
  `], { env: { ...process.env, PATH: dir }, encoding: 'utf8', timeout: 10000 });
  expect(JSON.parse(output).elapsed).toBeLessThan(2000);
}, 15000);

it.each([
  ['missing', null, /cloudflared could not be verified \(not found\).*2026\.10\.2 or later.*emudhra-certificate-compromise.*update-cloudflared/],
  ['unsafe', 'cloudflared version 2026.7.2 (built 2026-07-15-1200 UTC)', /cloudflared version 2026\.7\.2 is not permitted/],
])('refuses a real %s connector on PATH before starting it or scheduling retries', (_, version, refusal) => {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (version) writeFileSync(join(bin, 'cloudflared'), `#!/bin/sh\nif [ "$1" = --version ]; then echo "${version}"; else touch "$0.ran"; fi\n`, { mode: 0o700 });
  const module = pathToFileURL(resolve('dist/web/workspace-tunnel.js')).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { startWorkspaceTunnel } from ${JSON.stringify(module)};
    try { await startWorkspaceTunnel(${JSON.stringify(origin)}); process.exitCode=2; }
    catch(error) { console.log(error.message); }
  `], { env: { ...process.env, PATH: bin }, encoding:'utf8',timeout:10000 });
  expect(output).toMatch(refusal);
  expect(existsSync(join(bin, 'cloudflared.ran'))).toBe(false);
},15000);

it.each([
  [{ code: 0, stdout: 'cloudflared version 2026.7.2' }, /cloudflared version 2026\.7\.2 is not permitted/],
  [{ code: 0, stdout: 'cloudflared version 2026.10.2-rc.1' }, /cloudflared with an unrecognized version is not permitted/],
  [{ code: 1, stdout: '' }, /cloudflared could not be verified \(version check failed\)/],
])('rejects an installed unsafe or unverifiable connector %j without spawning a tunnel', async (result, found) => {
  const refusal = startWorkspaceTunnel(origin, async () => ({ ...result, stderr: '' }));
  await expect(refusal).rejects.toThrow(found);
  await expect(refusal).rejects.toThrow(/2026\.10\.2 or later.*emudhra-certificate-compromise.*update-cloudflared/);
  expect(launch).not.toHaveBeenCalled();
});

it('rechecks before reconnecting, keeps refusing a downgraded connector and resumes once it is upgraded', async () => {
  const unsafe = { code: 0, stdout: 'cloudflared version 2026.7.2', stderr: '' };
  const exec = vi.fn<Exec>().mockResolvedValueOnce({ code: 0, stdout: 'cloudflared version 2026.10.2', stderr: '' })
    .mockResolvedValueOnce(unsafe).mockResolvedValueOnce(unsafe)
    .mockResolvedValue({ code: 0, stdout: 'cloudflared version 2026.10.3', stderr: '' });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const first = failedChild(), second = failedChild();
  launch.mockReturnValueOnce(first).mockReturnValueOnce(second);
  stop = await startWorkspaceTunnel(origin, exec);
  first.emit('exit', 1, null);
  await vi.advanceTimersByTimeAsync(1000);
  expect(exec).toHaveBeenCalledTimes(2);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/cloudflared version 2026\.7\.2 is not permitted.*emudhra-certificate-compromise/));
  expect(vi.getTimerCount()).toBe(1);
  // The same refusal is not logged again on every retry.
  await vi.advanceTimersByTimeAsync(2000);
  expect(exec).toHaveBeenCalledTimes(3);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4000);
  expect(exec).toHaveBeenCalledTimes(4);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(launch).toHaveBeenLastCalledWith('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--token-file', join(stateRoot(), 'workspace', 'connector')], { stdio: 'ignore' });
  log.mockRestore();
});

it('stopping during a pending reconnect check never starts the connector', async () => {
  let release!: (value: { code: number; stdout: string; stderr: string }) => void;
  const exec = vi.fn<Exec>().mockResolvedValueOnce({ code: 0, stdout: 'cloudflared version 2026.10.2', stderr: '' })
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const child = failedChild();
  launch.mockReturnValue(child);
  stop = await startWorkspaceTunnel(origin, exec);
  child.emit('exit', 1, null);
  await vi.advanceTimersByTimeAsync(1000);
  expect(exec).toHaveBeenCalledTimes(2);
  await stop();
  release({ code: 0, stdout: 'cloudflared version 2026.10.2', stderr: '' });
  await vi.advanceTimersByTimeAsync(30000);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('stopping while a refused connector waits for its retry clears the retry', async () => {
  const exec = vi.fn<Exec>().mockResolvedValueOnce({ code: 0, stdout: 'cloudflared version 2026.10.2', stderr: '' })
    .mockResolvedValue({ code: 127, stdout: '', stderr: '' });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const child = failedChild();
  launch.mockReturnValue(child);
  stop = await startWorkspaceTunnel(origin, exec);
  child.emit('exit', 1, null);
  await vi.advanceTimersByTimeAsync(1000);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/cloudflared could not be verified \(not found\)/));
  expect(vi.getTimerCount()).toBe(1);
  await stop();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30000);
  expect(exec).toHaveBeenCalledTimes(2);
  expect(launch).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

it('waits for a running child to close and never retries after shutdown', async () => {
  const child = failedChild();
  Object.assign(child, { pid: 12345 });
  vi.mocked(child.kill).mockImplementation(() => {
    child.emit('exit', null, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    return true;
  });
  launch.mockReturnValue(child);
  stop = await startWorkspaceTunnel(origin, currentConnector);
  await stop();
  child.emit('error', new Error('late child error'));
  await vi.advanceTimersByTimeAsync(30000);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(launch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps an SSE opening access deadline despite a renewed credential, and honors fixed-device expiry',async()=>{
  const {WebAuth}=await import('../../src/web/auth.js');
  const {WorkspaceDeviceStore}=await import('../../src/web/workspace-devices.js');
  const {TrustedDeviceStore}=await import('../../src/web/device-store.js');
  const devices=new WorkspaceDeviceStore(join(dir,'devices'),()=>Date.now());
  const auth=new WebAuth('http://localhost','localhost',()=>Date.now(),new TrustedDeviceStore(join(dir,'trusted')),undefined,devices);
  const link=devices.mint(), issued=devices.enroll(link.enrollment,link.workspaceId,'rotating',true);
  const request=(token:string)=>({headers:{host:'localhost',authorization:`Bearer ${token}`}} as any);
  const opening=auth.authenticate(request(issued.accessToken));
  const closed=vi.fn(),unbind=auth.bindTransport(opening,closed);
  try {
    await vi.advanceTimersByTimeAsync(240_000);
    const fresh=devices.refresh(issued.refreshToken);
    const renewed=auth.authenticate(request(fresh.accessToken));
    expect(renewed.absoluteExpiresAt).toBeGreaterThan(opening.absoluteExpiresAt);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(auth.sessionValid(opening)).toBe(false);expect(auth.sessionValid(renewed)).toBe(true);expect(closed).toHaveBeenCalledOnce();
    const fixedLink=devices.mint(),fixed=devices.enroll(fixedLink.enrollment,fixedLink.workspaceId,'fixed');
    const fixedSession=auth.authenticate(request(fixed.token));
    expect(auth.sessionValid(fixedSession)).toBe(true);
    vi.setSystemTime(fixedSession.absoluteExpiresAt);
    expect(auth.sessionValid(fixedSession)).toBe(false);
  }finally{unbind();auth.shutdown();}
});
