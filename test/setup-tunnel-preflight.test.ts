import { mkdtempSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from '../src/exec.js';
import {
  clearPendingTunnelSetup, readPendingTunnelSetup, requiredPortAfterExpiry, savePendingTunnelSetup, setupTunnelPreflight, type PendingTunnelSetup,
} from '../src/setup-tunnel-preflight.js';

const answers = (overrides: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) => {
  const calls: string[] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    const answer = overrides[command] ?? (command === 'cloudflared' ? { code: 0, stdout: 'OPTIONS:\n   --token-file value\n' } : { code: 0 });
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
  };
  return { exec, calls };
};

describe('tunnel setup preflight', () => {
  it('accepts a host with a reachable user service manager and a current cloudflared', async () => {
    const { exec, calls } = answers();
    await setupTunnelPreflight({ exec, platform: 'linux', node: '22.13.0' });
    expect(calls).toEqual(['systemctl --user show-environment', 'cloudflared tunnel run --help']);
  });
  it('refuses an old Node.js before asking the host anything', async () => {
    const { exec, calls } = answers();
    await expect(setupTunnelPreflight({ exec, platform: 'linux', node: '22.12.0' })).rejects.toThrow(/Node\.js 22\.13 or newer; this is 22\.12\.0.*not bound/);
    expect(calls).toEqual([]);
  });
  it('explains an unreachable user service manager', async () => {
    const { exec } = answers({ systemctl: { code: 1, stderr: 'Failed to connect to bus: No medium found\n' } });
    await expect(setupTunnelPreflight({ exec, platform: 'linux', node: '24.1.0' })).rejects.toThrow(/user service manager is not reachable.*Failed to connect to bus: No medium found.*enable-linger.*not bound/s);
  });
  it('does not require systemd on macOS', async () => {
    const { exec, calls } = answers({ systemctl: { code: 127 } });
    await setupTunnelPreflight({ exec, platform: 'darwin', node: '22.13.1' });
    expect(calls).toEqual(['cloudflared tunnel run --help']);
  });
  it('refuses a missing or too old cloudflared', async () => {
    await expect(setupTunnelPreflight({ ...answers({ cloudflared: { code: 127 } }), platform: 'darwin', node: '22.13.0' })).rejects.toThrow(/cloudflared is not installed/);
    await expect(setupTunnelPreflight({ ...answers({ cloudflared: { code: 0, stdout: 'OPTIONS:\n   --token value\n' } }), platform: 'darwin', node: '22.13.0' })).rejects.toThrow(/too old.*--token-file/);
    await expect(setupTunnelPreflight({ ...answers({ cloudflared: { code: 1, stderr: 'unknown command; see --token-file' } }), platform: 'darwin', node: '22.13.0' })).rejects.toThrow(/too old/);
  });
});

describe('unfinished tunnel setup record', () => {
  const pending: PendingTunnelSetup = {
    appOrigin: 'https://app.ours-tunnel.com', origin: 'https://alex-home.ours-tunnel.com', hostWorkspaceId: 'h'.repeat(43), rootCid: 'A'.repeat(64),
    challenge: { nonce: 'n'.repeat(43), workspaceId: 'w'.repeat(43), accountId: 'a'.repeat(43), expiresAt: 1_800_000_000_000 },
    configuration: '/home/alex/fleet.yaml',
  };
  let previousHome: string | undefined;
  beforeEach(() => { previousHome = process.env.OURS_FLEET_HOME; process.env.OURS_FLEET_HOME = mkdtempSync(join(tmpdir(), 'ours-fleet-pending-')); });
  afterEach(() => { if (previousHome === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previousHome; });

  it('only assumes the default tunnel target after expiry when no other port was ever requested', () => {
    expect(requiredPortAfterExpiry(pending)).toBe(49_271);
    expect(requiredPortAfterExpiry({ ...pending, attemptedPort: 49_271 })).toBe(49_271);
    expect(() => requiredPortAfterExpiry({ ...pending, attemptedPort: 51_000 })).toThrow(/unknown whether the tunnel points at port 51000 or 49271/);
  });
  it('reports that there is nothing to finish', () => {
    expect(() => readPendingTunnelSetup()).toThrow(/No unfinished tunnel setup/);
  });
  it('keeps a private record until setup is finished and holds no connector credential', async () => {
    const { stateRoot } = await import('../src/paths.js');
    const { mkdirSync, readFileSync } = await import('node:fs');
    mkdirSync(join(stateRoot(), 'workspace'), { recursive: true, mode: 0o700 });
    savePendingTunnelSetup(pending);
    const path = join(stateRoot(), 'workspace', 'pending-setup.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort()).toEqual(['appOrigin', 'challenge', 'configuration', 'hostWorkspaceId', 'origin', 'rootCid']);
    expect(readPendingTunnelSetup()).toEqual(pending);
    chmodSync(path, 0o644);
    expect(() => readPendingTunnelSetup()).toThrow(/owned private file/);
    writeFileSync(path, '{}\n', { mode: 0o600 }); chmodSync(path, 0o600);
    expect(() => readPendingTunnelSetup()).toThrow(/invalid/);
    clearPendingTunnelSetup();
    expect(() => readPendingTunnelSetup()).toThrow(/No unfinished tunnel setup/);
  });
});
