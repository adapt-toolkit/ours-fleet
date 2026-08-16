import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requestWebControl, startWebControlServer } from '../../src/web/control.js';

describe('owner-only local web control', () => {
  it('dispatches commands through a private socket and removes it on close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-control-'));
    const calls: string[] = [];
    const control = await startWebControlServer({
      dir,
      onOpen() { calls.push('open'); },
      onRevokeAll() { calls.push('revoke-all'); },
    });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(control.path).mode & 0o777).toBe(0o600);
    await requestWebControl('open', control.path);
    await requestWebControl('revoke-all', control.path);
    expect(calls).toEqual(['open', 'revoke-all']);
    await control.close();
    await expect(requestWebControl('open', control.path, 100)).rejects.toThrow(/unavailable/);
  });

  it('rate-limits local control requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-control-rate-'));
    const control = await startWebControlServer({
      dir, rateLimit: 1, onOpen() {}, onRevokeAll() {},
    });
    await requestWebControl('open', control.path);
    await expect(requestWebControl('open', control.path)).rejects.toThrow(/rate limit/);
    await control.close();
  });
});
