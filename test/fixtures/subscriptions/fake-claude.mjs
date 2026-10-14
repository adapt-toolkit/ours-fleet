#!/usr/bin/env node
// Synthetic `claude` for subscription tests. Never touches a real login.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const marker = join(dir, 'fake-login.json');
const [cmd, sub] = process.argv.slice(2);
if (process.argv.includes('-p')) {
  if (!process.argv.includes('--verbose')) process.exit(2);
  if (!existsSync(marker) || process.env.FAKE_CLAUDE_PROBE_FAIL === '1') process.exit(1);
  if (process.env.FAKE_CLAUDE_PROBE_EXHAUSTED === '1') {
    process.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, result: "You've hit your limit" })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ type: 'system', message: 'started' })}\n`);
  if (process.env.FAKE_CLAUDE_NO_LIMIT !== '1')
    process.stdout.write(`${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {
      unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { utilization: 0.17, resetsAt: Math.floor(Date.now() / 1000) + 86400 } },
    } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'result', result: 'OK' })}\n`);
  process.exit(0);
}
if (cmd === 'auth' && sub === 'status') {
  if (!existsSync(marker)) { process.stdout.write(JSON.stringify({ loggedIn: false })); process.exit(1); }
  const who = JSON.parse(readFileSync(marker, 'utf8'));
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: who.authMethod ?? 'claude.ai', email: who.email, subscriptionType: 'max', orgName: 'Org' }));
  process.exit(0);
}
if (cmd === 'auth' && sub === 'login') {
  const url = process.env.FAKE_CLAUDE_URL ?? 'https://claude.com/cai/oauth/authorize?code=true&state=abc';
  process.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `);
  const rl = createInterface({ input: process.stdin });
  let step = 0;
  rl.on('line', line => {
    const code = line.trim();
    if (step === 0) {
      step = 1;
      if (code !== 'good-code#state123') { process.stdout.write('\nInvalid code\n'); process.exit(1); }
      writeFileSync(marker, JSON.stringify({ email: 'second@example.test' }));
      writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET-ACCESS', refreshToken: 'SECRET-REFRESH', expiresAt: Date.now() + 8 * 3600e3, refreshTokenExpiresAt: Date.now() + 28 * 86400e3 } }), { mode: 0o600 });
      process.stdout.write('\nLogin successful. Press Enter to continue\n');
    } else { process.exit(0); }
  });
} else { process.exit(2); }
