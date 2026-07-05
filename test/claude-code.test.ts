import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeClaudeCodeAdapter, autocompactPct, pretrust } from '../src/harness/claude-code.js';
import { agentDir } from '../src/paths.js';
import { loadConfig, findRole, type ResolvedRole } from '../src/config.js';
import type { Exec } from '../src/exec.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-cc-'));
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const role = (over: Partial<ResolvedRole> = {}): ResolvedRole => ({
  name: 'Alice', harness: 'claude-code', identity: 'Alice Dev', sourceFile: 'x', ...over,
});
const okExec: Exec = async () => ({ stdout: '2.1.0 (Claude Code)', stderr: '', code: 0 });

describe('autocompactPct', () => {
  it('derives from max_tokens against the 1M window', () =>
    expect(autocompactPct(role({ max_tokens: 500000 }))).toBe(50));
  it('explicit autocompact_pct wins', () =>
    expect(autocompactPct(role({ max_tokens: 500000, autocompact_pct: 80 }))).toBe(80));
  it('clamps to 1..100', () => {
    expect(autocompactPct(role({ max_tokens: 5_000_000 }))).toBe(100);
    expect(autocompactPct(role({ max_tokens: 1 }))).toBe(1);
  });
  it('defaults to 50', () => expect(autocompactPct(role())).toBe(50));
});

describe('pretrust', () => {
  it('merges trust flags without clobbering other projects', () => {
    const cj = join(dir, '.claude.json');
    writeFileSync(cj, JSON.stringify({ projects: { '/other': { keep: true } }, topLevel: 1 }));
    pretrust('/w');
    const d = JSON.parse(readFileSync(cj, 'utf8'));
    expect(d.projects['/w'].hasTrustDialogAccepted).toBe(true);
    expect(d.projects['/w'].projectOnboardingSeenCount).toBe(1);
    expect(d.projects['/other'].keep).toBe(true);
    expect(d.topLevel).toBe(1);
  });
});

describe('prepareSession', () => {
  it('writes overlay + env for plugins and mem_palace off', async () => {
    const a = makeClaudeCodeAdapter(okExec);
    const stateDir = join(dir, 'state'); mkdirSync(stateDir, { recursive: true });
    const prep = await a.prepareSession(
      role({ max_tokens: 500000, harness_options: { plugins: { 'x@m': true }, mem_palace: false } }),
      { stateDir, runCwd: stateDir });
    const overlay = join(stateDir, '.settings-overlay.json');
    expect(prep.argv).toEqual(['--settings', overlay]);
    const j = JSON.parse(readFileSync(overlay, 'utf8'));
    expect(j.enabledPlugins).toEqual({ 'x@m': true, 'mempalace@mempalace': false });
    expect(prep.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50');
    expect(prep.env.MEMPALACE_DISABLED).toBe('true');
    expect(prep.env.MEMPALACE_MIDSESSION_AUTOSAVE).toBe('false');
  });

  it('no overlay when nothing to override', async () => {
    const a = makeClaudeCodeAdapter(okExec);
    const stateDir = join(dir, 's2'); mkdirSync(stateDir, { recursive: true });
    const prep = await a.prepareSession(role(), { stateDir, runCwd: stateDir });
    expect(prep.argv).toEqual([]);
    expect(existsSync(join(stateDir, '.settings-overlay.json'))).toBe(false);
    expect(prep.env.MEMPALACE_DISABLED).toBeUndefined();
  });

  it('pre-trusts state dir and cwd', async () => {
    const a = makeClaudeCodeAdapter(okExec);
    const stateDir = join(dir, 's3'); mkdirSync(stateDir, { recursive: true });
    await a.prepareSession(role(), { stateDir, runCwd: '/repo' });
    const d = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'));
    expect(d.projects[stateDir].hasTrustDialogAccepted).toBe(true);
    expect(d.projects['/repo'].hasTrustDialogAccepted).toBe(true);
  });
});

describe('buildLaunch', () => {
  it('fresh + resume argv', () => {
    const a = makeClaudeCodeAdapter(okExec);
    const r = role();
    const prep = { argv: ['--settings', '/o.json'], env: {} };
    const fresh = a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep);
    expect(fresh.argv).toEqual([
      'claude', '--settings', '/o.json', '--remote-control', 'Alice',
      '--session-id', 'SID', `Read and follow ${agentDir('Alice')}/briefing.md now.`,
    ]);
    const resume = a.buildLaunch(r, 'resume', { sessionId: 'SID' }, prep);
    expect(resume.argv.slice(0, 7)).toEqual(
      ['claude', '--settings', '/o.json', '--remote-control', 'Alice', '--resume', 'SID']);
    expect(resume.argv[7]).toContain('choose_identity name "Alice Dev" force=true');
    expect(resume.argv[7]).toContain('ours-mcp watch "Alice Dev"');
    expect(resume.argv[7].toLowerCase()).not.toContain('a2adapt');
  });

  it('injects --model right after claude when role.model is set (fresh + resume)', () => {
    const a = makeClaudeCodeAdapter(okExec);
    const r = role({ model: 'claude-fable-5' });
    const prep = { argv: ['--settings', '/o.json'], env: {} };

    const fresh = a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep);
    expect(fresh.argv.slice(0, 5)).toEqual(
      ['claude', '--model', 'claude-fable-5', '--settings', '/o.json']);
    // trailing positional prompt is still last
    expect(fresh.argv[fresh.argv.length - 1]).toContain('briefing.md now.');

    const resume = a.buildLaunch(r, 'resume', { sessionId: 'SID' }, prep);
    expect(resume.argv.slice(0, 5)).toEqual(
      ['claude', '--model', 'claude-fable-5', '--settings', '/o.json']);
  });

  it('injects --model for a role whose model came from defaults.model', () => {
    writeFileSync(join(dir, 'fleet.yaml'),
      'defaults:\n  model: claude-fable-5\nroles:\n  Alice: {}\n');
    const r = findRole(loadConfig(), 'Alice');
    expect(r.model).toBe('claude-fable-5');
    const a = makeClaudeCodeAdapter(okExec);
    const prep = { argv: ['--settings', '/o.json'], env: {} };
    const fresh = a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep);
    expect(fresh.argv.slice(0, 3)).toEqual(['claude', '--model', 'claude-fable-5']);
  });

  it('injects --permission-mode when harness_options.permission_mode is set', () => {
    const a = makeClaudeCodeAdapter(okExec);
    const r = role({ harness_options: { permission_mode: 'dontAsk' } });
    const prep = { argv: ['--settings', '/o.json'], env: {} };
    const fresh = a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep);
    expect(fresh.argv).toEqual([
      'claude', '--permission-mode', 'dontAsk', '--settings', '/o.json',
      '--remote-control', 'Alice',
      '--session-id', 'SID', `Read and follow ${agentDir('Alice')}/briefing.md now.`,
    ]);
    const resume = a.buildLaunch(r, 'resume', { sessionId: 'SID' }, prep);
    expect(resume.argv.slice(0, 5)).toEqual(
      ['claude', '--permission-mode', 'dontAsk', '--settings', '/o.json']);
  });

  it('accepts every valid permission mode', () => {
    const a = makeClaudeCodeAdapter(okExec);
    const prep = { argv: [], env: {} };
    for (const pm of ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']) {
      const r = role({ harness_options: { permission_mode: pm } });
      const launch = a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep);
      expect(launch.argv.slice(0, 3)).toEqual(['claude', '--permission-mode', pm]);
    }
  });

  it('argv is byte-identical to before when permission_mode is unset (backward compat)', () => {
    const a = makeClaudeCodeAdapter(okExec);
    const prep = { argv: ['--settings', '/o.json'], env: {} };
    const without = a.buildLaunch(role(), 'fresh', { sessionId: 'SID' }, prep);
    const withEmpty = a.buildLaunch(
      role({ harness_options: {} }), 'fresh', { sessionId: 'SID' }, prep);
    expect(without.argv).toEqual([
      'claude', '--settings', '/o.json', '--remote-control', 'Alice',
      '--session-id', 'SID', `Read and follow ${agentDir('Alice')}/briefing.md now.`,
    ]);
    expect(withEmpty.argv).toEqual(without.argv);
  });

  it('throws a clear error naming allowed values on a bad permission_mode', () => {
    const a = makeClaudeCodeAdapter(okExec);
    const r = role({ harness_options: { permission_mode: 'yolo' } });
    const prep = { argv: [], env: {} };
    expect(() => a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep))
      .toThrow(/permission_mode/);
    expect(() => a.buildLaunch(r, 'fresh', { sessionId: 'SID' }, prep))
      .toThrow(/default, acceptEdits, plan, dontAsk, bypassPermissions/);
  });
});

describe('validateOptions / prereqs', () => {
  it('rejects unknown option keys', () => {
    const a = makeClaudeCodeAdapter(okExec);
    const errs = a.validateOptions({ plugin: {} });
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('allowed: plugins');
  });
  it('accepts permission_mode as a known option key', () => {
    const a = makeClaudeCodeAdapter(okExec);
    expect(a.validateOptions({ permission_mode: 'dontAsk' })).toEqual([]);
  });
  it('reports missing claude binary', async () => {
    const a = makeClaudeCodeAdapter(async () => ({ stdout: '', stderr: '', code: 127 }));
    const rep = await a.checkPrereqs();
    expect(rep.ok).toBe(false);
    expect(rep.checks[0].detail).toContain('not found');
  });
});
