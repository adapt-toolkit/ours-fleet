import {
  chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { OursMcpClient } from '../src/owner-channel/mcp.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

it('fences the daemon lease to the owner proxy lifetime, not the supervisor lifetime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-owner-proxy-'));
  dirs.push(dir);
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-ours-mcp.sh');
  const command = join(dir, 'ours-mcp');
  const record = join(dir, 'pids.json');
  copyFileSync(fixture, command);
  chmodSync(command, 0o755);

  const client = new OursMcpClient(command, { OWNER_PID_RECORD: record });
  await client.start();

  const pids = JSON.parse(readFileSync(record, 'utf8')) as { leasePid: number; proxyPid: number };
  expect(pids.leasePid).toBeGreaterThan(1);
  expect(pids.leasePid).not.toBe(process.pid);
  expect(pids.leasePid).toBe(pids.proxyPid);
  expect(alive(pids.leasePid)).toBe(true);

  await client.close();
  expect(alive(pids.leasePid)).toBe(false);
});
