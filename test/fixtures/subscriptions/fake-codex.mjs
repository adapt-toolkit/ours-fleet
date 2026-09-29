#!/usr/bin/env node
// Synthetic `codex app-server` for subscription tests. Never touches a real login.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
if (process.argv[2] !== 'app-server') process.exit(2);
const dir = process.env.CODEX_HOME ?? join(process.env.OURS_FLEET_HOME ?? homedir(), '.codex');
const marker = join(dir, 'fake-login.json');
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  else if (m.method === 'account/read') {
    if (m.params?.refreshToken !== false) { send({ id: m.id, error: { code: -1, message: 'test: health check must not refresh' } }); return; }
    const who = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
    send({ id: m.id, result: { account: who && { type: 'chatgpt', email: who.email, planType: 'pro' }, requiresOpenaiAuth: true } });
  } else if (m.method === 'account/login/start') {
    send({ id: m.id, result: { type: 'chatgptDeviceCode', loginId: 'L1', verificationUrl: process.env.FAKE_CODEX_URL ?? 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } });
    setTimeout(() => {
      writeFileSync(marker, JSON.stringify({ email: 'codex2@example.test' }));
      writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH' } }), { mode: 0o600 });
      send({ method: 'account/login/completed', params: { loginId: 'L1', success: true, error: null } });
    }, Number(process.env.FAKE_CODEX_DELAY ?? 300));
  } else if (m.method === 'account/login/cancel') send({ id: m.id, result: { status: 'canceled' } });
  else if (m.method === 'account/rateLimits/read') {
    if (process.env.FAKE_CODEX_EXPIRED) { send({ id: m.id, error: { code: -1, message: '401 Unauthorized: token expired' } }); return; }
    send({ id: m.id, result: { rateLimits: {}, rateLimitsByLimitId: { codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1791000000 }, secondary: null } } } });
  } else if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'unknown' } });
});
