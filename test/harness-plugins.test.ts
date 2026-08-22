import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '../src/exec.js';
import {
  harnessPluginLockPath,
  harnessPluginMarketplacePath,
  installHarnessPlugin,
  readHarnessPluginLock,
  resolveHarnessPluginConfigs,
  restoreLockedHarnessMarketplace,
} from '../src/harness-plugins.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ours-fleet-harness-plugins-'));
  process.env.OURS_FLEET_HOME = home;
});

afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(home, { recursive: true, force: true });
});

type Call = { command: string; args: string[] };

function fakeHarnessExec(version: () => string, calls: Call[], failInstall = false): Exec {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'npm' && args[0] === 'view')
      return { code: 0, stdout: `${JSON.stringify(version())}\n`, stderr: '' };
    if (failInstall && ((command === 'npm' && args[0] === 'install')
        || (command === 'claude' && args[1] === 'install')))
      return { code: 1, stdout: '', stderr: 'forced install failure' };
    if (command === 'codex' && args.slice(0, 3).join(' ') === 'plugin marketplace list')
      return { code: 0, stdout: '{"marketplaces":[]}\n', stderr: '' };
    if (command === 'claude' && args.slice(0, 3).join(' ') === 'plugin marketplace list')
      return { code: 0, stdout: '[]\n', stderr: '' };
    if (command === 'codex' && args.slice(0, 2).join(' ') === 'plugin list')
      return { code: 0, stdout: '{"installed":[]}\n', stderr: '' };
    if (command === 'claude' && args.slice(0, 2).join(' ') === 'plugin list')
      return { code: 0, stdout: '[]\n', stderr: '' };
    return { code: 0, stdout: '{}\n', stderr: '' };
  };
}

describe('harness plugin locks', () => {
  it('defaults both harnesses to stable and validates explicit independent channels', () => {
    expect(resolveHarnessPluginConfigs(undefined)).toEqual({
      codex: { plugin_channel: 'stable' },
      'claude-code': { plugin_channel: 'stable' },
    });
    expect(resolveHarnessPluginConfigs({
      codex: { plugin_channel: 'nightly' },
      'claude-code': { plugin_channel: 'stable' },
    })).toEqual({
      codex: { plugin_channel: 'nightly' },
      'claude-code': { plugin_channel: 'stable' },
    });
    expect(() => resolveHarnessPluginConfigs({ codex: { plugin_channel: 'latest' } }))
      .toThrow(/stable, nightly/);
    expect(() => resolveHarnessPluginConfigs({ cursor: { plugin_channel: 'stable' } }))
      .toThrow(/unknown harness/);
  });

  it('resolves stable once, installs only exact versions, and advances only on update', async () => {
    const calls: Call[] = [];
    let registryVersion = '0.17.0';
    const exec = fakeHarnessExec(() => registryVersion, calls);
    const first = await installHarnessPlugin('codex', 'stable', {
      exec, now: () => new Date('2026-08-22T00:00:00.000Z'),
    });
    expect(first.resolved).toBe(true);
    expect(first.lock.version).toBe('0.17.0');
    expect(calls).toContainEqual({
      command: 'npm', args: ['install', '--global', '@ours.network/codex@0.17.0'],
    });
    expect(calls
      .filter(call => !(call.command === 'npm' && call.args[0] === 'view'))
      .some(call => call.args.some(arg => /@(latest|stable)$/.test(arg))))
      .toBe(false);

    registryVersion = '0.18.0';
    const viewCount = calls.filter(call => call.command === 'npm' && call.args[0] === 'view').length;
    const repaired = await installHarnessPlugin('codex', 'stable', { exec });
    expect(repaired.resolved).toBe(false);
    expect(repaired.lock.version).toBe('0.17.0');
    expect(calls.filter(call => call.command === 'npm' && call.args[0] === 'view')).toHaveLength(viewCount);

    const updated = await installHarnessPlugin('codex', 'stable', { exec, update: true });
    expect(updated.resolved).toBe(true);
    expect(updated.lock.version).toBe('0.18.0');
    expect(readHarnessPluginLock('codex')?.version).toBe('0.18.0');
  });

  it('pins each nightly marketplace to an exact prerelease and never writes a moving tag', async () => {
    for (const harness of ['codex', 'claude-code'] as const) {
      const calls: Call[] = [];
      await installHarnessPlugin(harness, 'nightly', {
        exec: fakeHarnessExec(() => '0.18.0-nightly.3', calls),
        now: () => new Date('2026-08-22T01:02:03.000Z'),
      });
      const lock = JSON.parse(readFileSync(harnessPluginLockPath(harness), 'utf8'));
      const marketplace = readFileSync(harnessPluginMarketplacePath(harness), 'utf8');
      expect(lock).toMatchObject({
        harness, channel: 'nightly', distTag: 'nightly', version: '0.18.0-nightly.3',
      });
      expect(marketplace).toContain('"version": "0.18.0-nightly.3"');
      expect(marketplace).not.toMatch(/"version": "(?:latest|nightly)"/);
      expect(calls).toContainEqual({
        command: harness === 'codex' ? 'codex' : 'claude',
        args: harness === 'codex'
          ? ['plugin', 'add', 'ours@ours-fleet-codex-lock', '--json']
          : ['plugin', 'install', 'ours@ours-fleet-claude-lock', '--scope', 'user'],
      });
    }
  });

  it('replaces known moving marketplace selections only after the exact selection installs', async () => {
    const calls: Call[] = [];
    const base = fakeHarnessExec(() => '0.18.0-nightly.3', calls);
    const exec: Exec = async (command, args) => {
      if (command === 'codex' && args.slice(0, 2).join(' ') === 'plugin list') {
        calls.push({ command, args: [...args] });
        return {
          code: 0,
          stdout: '{"installed":[{"pluginId":"ours@ours-codex-marketplace"}]}\n',
          stderr: '',
        };
      }
      return base(command, args);
    };
    await installHarnessPlugin('codex', 'nightly', { exec });
    const exact = calls.findIndex(call => call.args.includes('ours@ours-fleet-codex-lock'));
    const remove = calls.findIndex(call => call.args.includes('ours@ours-codex-marketplace'));
    expect(exact).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(exact);
  });

  it('refreshes Claude\'s cached local marketplace without re-resolving its lock', async () => {
    await installHarnessPlugin('claude-code', 'stable', {
      exec: fakeHarnessExec(() => '0.17.0', []),
    });
    const calls: Call[] = [];
    const base = fakeHarnessExec(() => '9.9.9', calls);
    const exec: Exec = async (command, args) => {
      if (command === 'claude' && args.slice(0, 3).join(' ') === 'plugin marketplace list') {
        calls.push({ command, args: [...args] });
        return {
          code: 0,
          stdout: '[{"name":"ours-fleet-claude-lock","source":"directory"}]\n',
          stderr: '',
        };
      }
      return base(command, args);
    };
    const repaired = await installHarnessPlugin('claude-code', 'stable', { exec });
    expect(repaired.resolved).toBe(false);
    expect(repaired.lock.version).toBe('0.17.0');
    expect(calls.some(call => call.command === 'npm' && call.args[0] === 'view')).toBe(false);
    expect(calls).toContainEqual({
      command: 'claude',
      args: ['plugin', 'marketplace', 'update', 'ours-fleet-claude-lock'],
    });
  });

  it('persists the exact lock before installation and retries without resolving again', async () => {
    const failedCalls: Call[] = [];
    await expect(installHarnessPlugin('claude-code', 'nightly', {
      exec: fakeHarnessExec(() => '0.18.0-nightly.4', failedCalls, true),
    })).rejects.toThrow(/forced install failure/);
    expect(readHarnessPluginLock('claude-code')?.version).toBe('0.18.0-nightly.4');

    const retryCalls: Call[] = [];
    const retry = await installHarnessPlugin('claude-code', 'nightly', {
      exec: fakeHarnessExec(() => '9.9.9-nightly.9', retryCalls),
    });
    expect(retry.resolved).toBe(false);
    expect(retry.lock.version).toBe('0.18.0-nightly.4');
    expect(retryCalls.some(call => call.command === 'npm' && call.args[0] === 'view')).toBe(false);
  });

  it('ordinary reconciliation restores only from disk and rejects corrupt or moving locks', async () => {
    expect(() => restoreLockedHarnessMarketplace('claude-code', 'nightly'))
      .toThrow(/requests nightly but has no exact lock/);
    await installHarnessPlugin('codex', 'nightly', {
      exec: fakeHarnessExec(() => '0.18.0-nightly.5', []),
    });
    expect(() => restoreLockedHarnessMarketplace('codex', 'stable'))
      .toThrow(/requests stable but its exact lock is nightly/);
    rmSync(harnessPluginMarketplacePath('codex'));
    expect(restoreLockedHarnessMarketplace('codex', 'nightly')?.version).toBe('0.18.0-nightly.5');
    expect(readFileSync(harnessPluginMarketplacePath('codex'), 'utf8'))
      .toContain('"version": "0.18.0-nightly.5"');

    const lockPath = harnessPluginLockPath('codex');
    const moving = JSON.parse(readFileSync(lockPath, 'utf8'));
    moving.version = 'nightly';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(lockPath, JSON.stringify(moving));
    expect(() => restoreLockedHarnessMarketplace('codex')).toThrow(/exact semver/);
  });
});
