import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexAcpLaunchForResolution, makeCodexAdapter, codexCapabilities,
} from '../src/harness/codex.js';
import { checkUnattendedFloor } from '../src/permissions.js';
import { agentDir } from '../src/paths.js';
import type { ResolvedRole } from '../src/config.js';
import type { Exec } from '../src/exec.js';

const role = (over: Partial<ResolvedRole> = {}): ResolvedRole => ({
  name: 'Alice', harness: 'codex', identity: 'Alice Dev', sourceFile: 'x', ...over,
});
const execWith = (oursCodex: boolean): Exec => async (cmd, args) => {
  if (cmd === 'codex' && args[0] === '--version')
    return { stdout: 'codex-cli 0.144.4', stderr: '', code: 0 };
  if (cmd === 'codex' && args[0] === 'plugin')
    return { stdout: JSON.stringify({ installed: [{
      pluginId: 'ours@ours-codex-marketplace', installed: true, enabled: true,
    }] }), stderr: '', code: 0 };
  if (cmd === 'sh') return { stdout: '', stderr: '', code: oursCodex ? 0 : 1 };
  return { stdout: '', stderr: '', code: 0 };
};
const okExec = execWith(false);

describe('prepareSession', () => {
  it('prepares the same ACP environment when ours-codex is installed', async () => {
    const a = makeCodexAdapter(execWith(true));
    const prep = await a.prepareSession(role(), { stateDir: '/s', runCwd: '/s' });
    expect(prep).toEqual({ env: { OURS_BIND_IDENTITY: 'Alice Dev' } });
  });

  it('does not require a CLI launcher when ours-codex is absent', async () => {
    const a = makeCodexAdapter(execWith(false));
    const prep = await a.prepareSession(role(), { stateDir: '/s', runCwd: '/s' });
    expect(prep).toEqual({ env: { OURS_BIND_IDENTITY: 'Alice Dev' } });
  });

  it('does not apply the legacy CLI launcher option to ACP preparation', async () => {
    const a = makeCodexAdapter(execWith(false));
    await expect(a.prepareSession(role({ harness_options: { launcher: 'ours-codex' } }),
      { stateDir: '/s', runCwd: '/s' })).resolves.toEqual({
        env: { OURS_BIND_IDENTITY: 'Alice Dev' },
      });
  });

  it('materializes the ACP app-server override inside the role state boundary', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-codex-prep-'));
    try {
      const r = role({
        session: 'acp',
        permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      });
      const prep = await makeCodexAdapter(okExec).prepareSession(r, { stateDir, runCwd: stateDir });
      expect(prep.env).toMatchObject({
        OURS_FLEET_CODEX_APPROVAL: 'never',
        OURS_FLEET_CODEX_SANDBOX: 'danger-full-access',
      });
      expect(prep.env.CODEX_PATH.startsWith(stateDir)).toBe(true);
      expect(existsSync(prep.env.CODEX_PATH)).toBe(true);
      const launch = makeCodexAdapter(okExec).agentSession.prepareLaunch(r, prep);
      expect(launch.env).toMatchObject({
        CODEX_PATH: prep.env.CODEX_PATH,
        INITIAL_AGENT_MODE: 'agent-full-access',
        OURS_FLEET_CODEX_APPROVAL: 'never',
        OURS_FLEET_CODEX_SANDBOX: 'danger-full-access',
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('leaves explicit ACP commands untouched and unclaimed', async () => {
    const r = role({
      session: 'acp', session_options: { acp: { command: ['custom-codex-acp'] } },
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    });
    const prep = await makeCodexAdapter(okExec).prepareSession(r, { stateDir: '/s', runCwd: '/s' });
    expect(prep.env).toEqual({ OURS_BIND_IDENTITY: 'Alice Dev' });
    expect(makeCodexAdapter(okExec).effectivePermissions!(r)).toMatchObject({ exact: false });
  });

  it('seeds OURS_BIND_IDENTITY onto the agent-session launch', async () => {
    const r = role();
    const prep = await makeCodexAdapter(okExec).prepareSession(r, { stateDir: '/s', runCwd: '/s' });
    expect(prep.env.OURS_BIND_IDENTITY).toBe('Alice Dev');
    expect(makeCodexAdapter(okExec).agentSession.prepareLaunch(r, prep).env.OURS_BIND_IDENTITY)
      .toBe('Alice Dev');
  });
});

describe('vocabulary.monitorInstruction', () => {
  it('asks before arming by default and never backgrounds the watch', () => {
    const a = makeCodexAdapter(okExec);
    const text = a.vocabulary.monitorInstruction('Alice Dev', role());
    expect(text).not.toContain('as a background shell command');
    expect(text).toContain('Ask the fleet owner');
    expect(text).toContain('blocking wait');
    expect(text).toContain('get_messages');
    expect(text).toContain('arm_monitor');
    expect(text).toContain('foreground_monitor');
  });

  it('treats monitor: true as explicit persistent fleet consent', () => {
    const a = makeCodexAdapter(okExec);
    const configured = role({ harness_options: { monitor: true } });
    const text = a.vocabulary.monitorInstruction('Alice Dev', configured);
    expect(text).toContain('explicitly consented');
    expect(text).toContain('Call **arm_monitor**');
    expect(text).not.toContain('Do not call **arm_monitor**');
  });
});

describe('validateOptions / prereqs', () => {
  it('rejects unknown option keys', () => {
    const a = makeCodexAdapter(okExec);
    const errs = a.validateOptions({ sandboxx: 'workspace-write' });
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('launcher, sandbox, approval');
  });
  it('accepts sandbox/approval/search/monitor as known option keys', () => {
    const a = makeCodexAdapter(okExec);
    expect(a.validateOptions({ sandbox: 'workspace-write', approval: 'never', search: true, monitor: true })).toEqual([]);
  });
  it('validates launcher/profile/config/add_dirs and conflicting approval aliases', () => {
    const a = makeCodexAdapter(okExec);
    const errs = a.validateOptions({
      launcher: 'magic', profile: '', add_dirs: [''], config: { nested: { nope: true } },
      approval: 'never', permission_mode: 'on-request', monitor: 'yes',
    });
    expect(errs.map(e => e.path)).toEqual(expect.arrayContaining([
      'harness_options.launcher', 'harness_options.profile', 'harness_options.add_dirs',
      'harness_options.config.nested', 'harness_options.permission_mode',
      'harness_options.monitor',
    ]));
  });
  it('flags a bad sandbox/approval value', () => {
    const a = makeCodexAdapter(okExec);
    const errs = a.validateOptions({ sandbox: 'yolo', approval: 'yolo' });
    expect(errs).toHaveLength(2);
  });
  it('reports missing codex binary', async () => {
    const a = makeCodexAdapter(async () => ({ stdout: '', stderr: '', code: 127 }));
    const rep = await a.checkPrereqs();
    expect(rep.ok).toBe(false);
    expect(rep.checks[0].detail).toContain('not found');
  });
  it('reports ours-codex as an optional enhancement, not a failed prerequisite', async () => {
    const rep = await makeCodexAdapter(execWith(false)).checkPrereqs();
    expect(rep.ok).toBe(true);
    expect(rep.checks.find(c => c.name === 'ours-codex')).toMatchObject({ ok: true });
    expect(rep.checks.find(c => c.name === 'ours-codex')?.detail).toContain('fall back');
  });
  it('requires the native ours plugin for monitor tools', async () => {
    const exec: Exec = async (cmd, args) => {
      if (cmd === 'codex' && args[0] === '--version') return { stdout: 'codex-cli 1.0.0', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 1 };
    };
    const rep = await makeCodexAdapter(exec).checkPrereqs();
    expect(rep.ok).toBe(false);
    expect(rep.checks.find(c => c.name === 'ours plugin')?.detail).toContain('ours-codex-install');
  });

  it('accepts an enabled ours plugin from a local testing marketplace', async () => {
    const exec: Exec = async (cmd, args) => {
      if (cmd === 'codex' && args[0] === '--version')
        return { code: 0, stdout: 'codex-cli 0.144.4\n', stderr: '' };
      if (cmd === 'sh') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'codex' && args[0] === 'plugin') return {
        code: 0, stderr: '', stdout: JSON.stringify({ installed: [{
          pluginId: 'ours@ours-local-testing', name: 'ours', installed: true, enabled: true,
        }] }),
      };
      return { code: 1, stdout: '', stderr: '' };
    };
    const rep = await makeCodexAdapter(exec).checkPrereqs();
    expect(rep.ok).toBe(true);
  });
});

describe('Codex neutral permission mapping and the unattended floor', () => {
  const a = makeCodexAdapter(okExec);
  const APPROVALS = ['ask', 'auto', 'allow', 'deny'] as const;
  const FILESYSTEMS = ['read-only', 'workspace', 'unrestricted'] as const;
  const UNATTENDED = ['deny', 'wait'] as const;

  it('reports the capability set its native settings actually grant', () => {
    const t = a.translatePermissions(
      { approval: 'allow', filesystem: 'workspace', unattended: 'deny' });
    expect(t).toMatchObject({ supported: true, native: { approval: 'never', sandbox: 'workspace-write' } });
    expect(checkUnattendedFloor((t as { capabilities: never }).capabilities).meets).toBe(true);
  });

  it('reports the owner-defined bundled ACP allow and auto modes', () => {
    const workspace = a.effectivePermissions!(role({
      session: 'acp',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    }));
    expect(workspace).toMatchObject({
      supported: true, exact: false,
      native: {
        mode: 'agent-full-access', approval: 'never', sandbox: 'danger-full-access',
      },
    });
    expect((workspace as { warnings: string[] }).warnings.join('\n'))
      .toContain("mode 'agent-full-access' couples approval and filesystem");
    expect(checkUnattendedFloor((workspace as { capabilities: never }).capabilities).meets)
      .toBe(true);

    const full = a.effectivePermissions!(role({
      session: 'acp',
      permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'deny' },
    }));
    expect(full).toMatchObject({
      supported: true, exact: true,
      native: {
        mode: 'agent-full-access', approval: 'never', sandbox: 'danger-full-access',
      },
    });
    expect(checkUnattendedFloor((full as { capabilities: never }).capabilities).meets).toBe(true);

    const automatic = a.effectivePermissions!(role({
      session: 'acp',
      permissions: { approval: 'auto', filesystem: 'unrestricted', unattended: 'deny' },
    }));
    expect(automatic).toMatchObject({
      supported: true, exact: false,
      native: { mode: 'agent', approval: 'on-request', sandbox: 'workspace-write' },
    });
  });

  it('preserves native overrides in ACP launch and effective reporting', () => {
    const r = role({
      session: 'acp',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      permissionsDeclared: true,
      harness_options: { approval: 'on-request', sandbox: 'read-only' },
    });
    expect(a.agentSession.prepareLaunch(r, { env: {} }).env.INITIAL_AGENT_MODE)
      .toBe('read-only');
    expect(a.effectivePermissions!(r)).toMatchObject({
      native: { mode: 'read-only', approval: 'on-request', sandbox: 'read-only' },
    });
    expect(a.effectivePermissionMode!(r)).toEqual({
      fleetMode: 'auto', nativeMode: 'read-only',
    });
  });

  it('reports the effective policy with the exact live ACP mode id', () => {
    expect(a.effectivePermissionMode!(role({
      session: 'acp',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    }))).toEqual({ fleetMode: 'allow', nativeMode: 'agent-full-access' });
    expect(a.effectivePermissionMode!(role({
      session: 'acp',
      permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'deny' },
    }))).toEqual({ fleetMode: 'allow', nativeMode: 'agent-full-access' });
    expect(a.effectivePermissionMode!(role({
      session: 'acp',
      permissions: { approval: 'auto', filesystem: 'unrestricted', unattended: 'deny' },
    }))).toEqual({ fleetMode: 'auto', nativeMode: 'agent' });
  });

  it('maps public modes to Codex approval policies with sandbox kept separate', () => {
    const native = (approval: 'ask' | 'auto' | 'allow') =>
      (a.translatePermissions({ approval, filesystem: 'read-only', unattended: 'deny' }) as
        { native: Record<string, unknown> }).native;
    expect(native('ask')).toEqual({ approval: 'untrusted', sandbox: 'read-only' });
    expect(native('auto').approval).toBe('on-request');
    expect(native('allow').approval).toBe('never');
  });

  it('every neutral combination resolves, and only allow clears the floor', () => {
    for (const approval of APPROVALS)
      for (const filesystem of FILESYSTEMS)
        for (const unattended of UNATTENDED) {
          const label = `${approval}/${filesystem}/${unattended}`;
          const t = a.translatePermissions({ approval, filesystem, unattended });
          expect(t.supported, label).toBe(true);
          const { capabilities } = t as { capabilities: never };
          expect(checkUnattendedFloor(capabilities).meets, label)
            .toBe(approval === 'allow' && filesystem !== 'read-only');
        }
  });

  it('every ACP row reports the selected coupled mode honestly', () => {
    for (const approval of APPROVALS)
      for (const filesystem of FILESYSTEMS)
        for (const unattended of UNATTENDED) {
          const label = `${approval}/${filesystem}/${unattended}`;
          const translated = a.translatePermissions({ approval, filesystem, unattended });
          expect(translated.supported, label).toBe(true);
          if (!translated.supported) continue;
          const effective = a.effectivePermissions!(role({
            session: 'acp', permissions: { approval, filesystem, unattended },
          }));
          expect(effective.supported, label).toBe(true);
          if (!effective.supported) continue;
          expect(effective.exact, label).toBe(
            (approval !== 'allow' && approval !== 'auto')
              || (approval === 'allow' && filesystem === 'unrestricted')
              || (approval === 'auto' && filesystem === 'workspace'));
          if (approval === 'allow') expect(effective.native, label).toMatchObject({
            mode: 'agent-full-access', approval: 'never', sandbox: 'danger-full-access',
          });
          else if (approval === 'auto') expect(effective.native, label).toMatchObject({
            mode: 'agent', approval: 'on-request', sandbox: 'workspace-write',
          });
          else expect(effective.native, label).toMatchObject(translated.native);
          expect(checkUnattendedFloor(effective.capabilities).meets, label)
            .toBe(approval === 'allow');
        }
  });

  it('on-request cannot meet the floor: nobody is there to answer', () => {
    expect(checkUnattendedFloor(codexCapabilities('on-request', 'workspace-write')).meets).toBe(false);
    expect(checkUnattendedFloor(codexCapabilities('never', 'read-only')).missing)
      .toEqual(['write-state', 'workspace-edit']);
    expect(checkUnattendedFloor(codexCapabilities('never', 'danger-full-access')).meets).toBe(true);
  });
});
