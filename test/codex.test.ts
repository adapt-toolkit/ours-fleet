import { describe, it, expect } from 'vitest';
import { makeCodexAdapter } from '../src/harness/codex.js';
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
  it('prefers ours-codex when installed', async () => {
    const a = makeCodexAdapter(execWith(true));
    const prep = await a.prepareSession(role(), { stateDir: '/s', runCwd: '/s' });
    expect(prep).toEqual({ argv: [], env: {}, command: 'ours-codex' });
  });

  it('falls back to native codex when ours-codex is absent', async () => {
    const a = makeCodexAdapter(execWith(false));
    const prep = await a.prepareSession(role(), { stateDir: '/s', runCwd: '/s' });
    expect(prep).toEqual({ argv: [], env: {}, command: 'codex' });
  });

  it('fails clearly when ours-codex was explicitly required', async () => {
    const a = makeCodexAdapter(execWith(false));
    await expect(a.prepareSession(role({ harness_options: { launcher: 'ours-codex' } }),
      { stateDir: '/s', runCwd: '/s' })).rejects.toThrow(/not on PATH/);
  });
});

describe('buildLaunch', () => {
  it('fresh: plain prompt, no flags when nothing configured', () => {
    const a = makeCodexAdapter(okExec);
    const r = role();
    const prep = { argv: [], env: {} };
    const fresh = a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep);
    expect(fresh.argv).toEqual([
      'codex', `Read and follow ${agentDir('Alice')}/briefing.md now.`,
    ]);
  });

  it('resume: codex resume --last + restart prompt', () => {
    const a = makeCodexAdapter(okExec);
    const r = role();
    const prep = { argv: [], env: {} };
    const resume = a.buildLaunch(r, 'resume', { sessionId: 'SID' }, prep);
    expect(resume.argv.slice(0, 2)).toEqual(['codex', 'resume']);
    expect(resume.argv).toContain('--last');
    const prompt = resume.argv[resume.argv.length - 1];
    expect(prompt).toContain('choose_identity name "Alice Dev" force=true');
    expect(prompt).toContain('ask the fleet owner');
    expect(prompt).toContain('foreground_monitor');
    expect(prompt.toLowerCase()).not.toContain('a2adapt');
    // A backgrounded watch never wakes a Codex turn (no persistent Monitor primitive) —
    // the restart prompt must not tell the agent to background it.
    expect(prompt).not.toContain('as a background shell command');
    expect(prompt).toContain('native-codex fallback');
  });

  it('injects --model when role.model is set (fresh + resume)', () => {
    const a = makeCodexAdapter(okExec);
    const r = role({ model: 'gpt-5.1-codex' });
    const prep = { argv: [], env: {} };

    const fresh = a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep);
    expect(fresh.argv.slice(0, 3)).toEqual(['codex', '--model', 'gpt-5.1-codex']);
    expect(fresh.argv[fresh.argv.length - 1]).toContain('briefing.md now.');

    const resume = a.buildLaunch(r, 'resume', { sessionId: 'SID' }, prep);
    expect(resume.argv.slice(0, 4)).toEqual(['codex', 'resume', '--last', '--model']);
    expect(resume.argv[4]).toBe('gpt-5.1-codex');
  });

  it('injects --sandbox / --ask-for-approval / --search from harness_options', () => {
    const a = makeCodexAdapter(okExec);
    const r = role({ harness_options: { sandbox: 'workspace-write', approval: 'never', search: true } });
    const prep = { argv: [], env: {} };
    const fresh = a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep);
    expect(fresh.argv.slice(0, 6)).toEqual([
      'codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--search',
    ]);
  });

  it('injects profile, config overrides, add-dir and permission_mode alias', () => {
    const a = makeCodexAdapter(okExec);
    const r = role({ harness_options: {
      profile: 'fleet', permission_mode: 'on-request', add_dirs: ['/data/reports'],
      config: { model_reasoning_effort: 'high', hide_agent_reasoning: true, max_tool_output: 42 },
    } });
    const launch = a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, { argv: [], env: {}, command: 'ours-codex' });
    expect(launch.argv[0]).toBe('ours-codex');
    expect(launch.argv).toContain('--profile');
    expect(launch.argv).toContain('fleet');
    expect(launch.argv).toContain('--add-dir');
    expect(launch.argv).toContain('/data/reports');
    expect(launch.argv).toContain('model_reasoning_effort="high"');
    expect(launch.argv).toContain('hide_agent_reasoning=true');
    expect(launch.argv).toContain('max_tool_output=42');
    expect(launch.argv).toContain('on-request');
  });

  it('argv is byte-identical to before when harness_options is unset (backward compat)', () => {
    const a = makeCodexAdapter(okExec);
    const prep = { argv: [], env: {} };
    const without = a.buildLaunch(role(), 'fresh', { sessionId: 'SID' }, prep);
    const withEmpty = a.buildLaunch(role({ harness_options: {} }), 'fresh', { sessionId: 'SID' }, prep);
    expect(without.argv).toEqual([
      'codex', `Read and follow ${agentDir('Alice')}/briefing.md now.`,
    ]);
    expect(withEmpty.argv).toEqual(without.argv);
  });

  it('throws a clear error naming allowed values on a bad sandbox', () => {
    const a = makeCodexAdapter(okExec);
    const r = role({ harness_options: { sandbox: 'yolo' } });
    const prep = { argv: [], env: {} };
    expect(() => a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep))
      .toThrow(/harness_options\.sandbox/);
    expect(() => a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep))
      .toThrow(/read-only, workspace-write, danger-full-access/);
  });

  it('throws a clear error naming allowed values on a bad approval', () => {
    const a = makeCodexAdapter(okExec);
    const r = role({ harness_options: { approval: 'yolo' } });
    const prep = { argv: [], env: {} };
    expect(() => a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep))
      .toThrow(/harness_options\.approval/);
    expect(() => a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep))
      .toThrow(/untrusted, on-request, never/);
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
