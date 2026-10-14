import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { ClaudeLogin, LOGIN_TTL_MS } from '../src/subscriptions/login.js';

const roots: string[] = [];
const logins: ClaudeLogin[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const login of logins.splice(0)) { login.cancel(); await login.exited; }
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n++) { if (check()) return; await pause(10); }
  throw Error('synthetic terminal did not settle');
}
function fixture(body: string) {
  const home = mkdtempSync(join(tmpdir(), 'fleet-login-')); roots.push(home);
  // Spaces and shell punctuation must remain literal executable arguments.
  const cli = join(home, "claude ' literal;name");
  writeFileSync(cli, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { home, cli, start(script = 'script') {
    const login = new ClaudeLogin('owner', { claude: cli, codex: 'unused', script }, home, 'profile');
    logins.push(login); return login;
  } };
}
it.each([0, 7])('retains terminal exit %i while input remains open', async code => {
  const f = fixture(`process.exit(${code});`), login = f.start();
  expect(await login.exited).toBe(code);
  login.complete(code === 0); expect(await login.done).toBe(code === 0);
});
it('settles a missing terminal executable without waiting for input', async () => {
  const f = fixture('process.exit(0);'), login = f.start(join(f.home, 'missing-script'));
  expect(await login.exited).not.toBe(0); login.complete(false); expect(await login.done).toBe(false);
});
it.each(['cancel', 'expiry'] as const)('ends the terminal and its CLI on %s', async mode => {
  const f = fixture(`require('node:fs').writeFileSync(process.env.FLEET_LOGIN_PID, String(process.pid));
process.stdout.write('https://claude.com/oauth\\n'); setInterval(() => {}, 1000);`);
  const pidFile = join(f.home, 'pid'); vi.stubEnv('FLEET_LOGIN_PID', pidFile);
  if (mode === 'expiry') vi.useFakeTimers();
  const login = f.start(); await until(() => login.view().state === 'awaiting_user');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  if (mode === 'cancel') login.cancel(); else await vi.advanceTimersByTimeAsync(LOGIN_TTL_MS + 1);
  expect(await login.done).toBe(false); await login.exited;
  await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } });
  expect(login.view().state).toBe(mode === 'cancel' ? 'cancelled' : 'expired');
});
it('sends the post-login Enter once despite later terminal output', async () => {
  const f = fixture(`
const readline = require('node:readline');
process.stdout.write('https://claude.com/oauth\\n');
let lines = 0;
readline.createInterface({input:process.stdin}).on('line', () => {
  lines++;
  if (lines === 1) process.stdout.write('Press Enter to continue\\n');
  else if (lines === 2) {
    process.stdout.write('Finishing sign-in\\n');
    setTimeout(() => process.exit(0), 100);
  } else process.exit(7);
});`);
  // This stand-in terminal deliberately echoes after consuming the one Enter.
  const login = f.start(f.cli); await until(() => login.view().state === 'awaiting_user');
  login.submitCode('fixture-code#state');
  const code = await login.exited; login.complete(code === 0);
  expect(code).toBe(0);
});
