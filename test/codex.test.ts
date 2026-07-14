import { describe, it, expect } from 'vitest';
import { makeCodexAdapter } from '../src/harness/codex.js';
import { agentDir } from '../src/paths.js';
import type { ResolvedRole } from '../src/config.js';
import type { Exec } from '../src/exec.js';

const role = (over: Partial<ResolvedRole> = {}): ResolvedRole => ({
  name: 'Alice', harness: 'codex', identity: 'Alice Dev', sourceFile: 'x', ...over,
});
const okExec: Exec = async () => ({ stdout: 'codex-cli 0.144.4', stderr: '', code: 0 });

describe('prepareSession', () => {
  it('is a no-op: no argv, no env', async () => {
    const a = makeCodexAdapter(okExec);
    const prep = await a.prepareSession(role(), { stateDir: '/s', runCwd: '/s' });
    expect(prep).toEqual({ argv: [], env: {} });
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
    expect(prompt).toContain('ours-mcp watch "Alice Dev"');
    expect(prompt.toLowerCase()).not.toContain('a2adapt');
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

describe('validateOptions / prereqs', () => {
  it('rejects unknown option keys', () => {
    const a = makeCodexAdapter(okExec);
    const errs = a.validateOptions({ sandboxx: 'workspace-write' });
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('allowed: sandbox, approval, search');
  });
  it('accepts sandbox/approval/search as known option keys', () => {
    const a = makeCodexAdapter(okExec);
    expect(a.validateOptions({ sandbox: 'workspace-write', approval: 'never', search: true })).toEqual([]);
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
});
