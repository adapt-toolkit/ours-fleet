import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeClaudeCodeAdapter, autocompactPct, pretrust, claudeCapabilities,
} from '../src/harness/claude-code.js';
import { checkUnattendedFloor } from '../src/permissions.js';
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

describe('Brain session configuration', () => {
  it('maps explicit Brain effort to the required ACP effort option only', () => {
    const session = makeClaudeCodeAdapter(okExec).agentSession;
    expect(session.sessionConfigSelections(role({ effort: 'high' })))
      .toEqual([{ configId: 'effort', value: 'high' }]);
    expect(session.sessionConfigSelections(role())).toEqual([]);
  });
});

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

describe('vocabulary — supervised monitor migration', () => {
  const v = makeClaudeCodeAdapter(okExec).vocabulary;
  const mon = (mode: 'fleet' | 'native') => ({
    mode, enabled: mode === 'fleet', wake_sources: [], batch_ms: 2000, inject: 'notification' as const,
  });

  it('supervisedWakeNote steers the agent off its own Monitor', () => {
    const note = v.supervisedWakeNote('Alice Dev');
    expect(note).toContain('[fleet-monitor]');
    expect(note).toContain('do NOT arm');
    expect(note).toContain('get_messages');
  });

  it('restartPrompt drops the re-arm line when the monitor is supervised', () => {
    const p = v.restartPrompt('Alice Dev', '/w/WORKLOG.md', role({ monitor: mon('fleet') }));
    expect(p).not.toContain('re-arm');
    expect(p).not.toContain('ours api watch-notifications');
    expect(p).toContain('choose_identity name "Alice Dev"');
  });

  it('restartPrompt keeps the re-arm line for a native-monitor role', () => {
    const p = v.restartPrompt('Alice Dev', '/w/WORKLOG.md', role({ monitor: mon('native') }));
    expect(p).toContain('ours api watch-notifications');
  });

  // ── issue #16: mandate the Monitor TOOL, not a background Bash command ──
  it('monitorInstruction forbids a background Bash task and names the watch command', () => {
    const m = v.monitorInstruction('Alice Dev');
    expect(m).toContain('persistent Monitor');
    expect(m).toContain('NOT a background Bash');
    expect(m).toContain('ours api watch-notifications');
  });

  it('non-supervised restartPrompt mandates the Monitor TOOL, not background Bash', () => {
    const p = v.restartPrompt('Alice Dev', '/w/WORKLOG.md', role({ monitor: mon('native') }));
    expect(p).toContain('persistent Monitor');
    expect(p).toContain('NOT a background Bash');
    expect(p).toContain('ours api watch-notifications');
  });

  it('non-supervised restartPrompt (no monitor field at all) also mandates the Monitor TOOL', () => {
    const p = v.restartPrompt('Alice Dev', '/w/WORKLOG.md', role());
    expect(p).toContain('persistent Monitor');
    expect(p).toContain('NOT a background Bash');
    expect(p).toContain('ours api watch-notifications');
  });

  it('supervised restartPrompt states mail arrives as [fleet-monitor] and forbids an in-session Monitor', () => {
    const p = v.restartPrompt('Alice Dev', '/w/WORKLOG.md', role({ monitor: mon('fleet') }));
    expect(p).toContain('[fleet-monitor]');
    expect(p).toContain('do NOT arm an in-session Monitor');
    expect(p).not.toContain('ours api watch-notifications');
  });

  it('monitorInstruction and non-supervised restartPrompt share the same mandate wording', () => {
    const mi = v.monitorInstruction('Alice Dev');
    const rp = v.restartPrompt('Alice Dev', '/w/WORKLOG.md', role({ monitor: mon('native') }));
    for (const frag of ['persistent Monitor', 'NOT a background Bash', 'ours api watch-notifications']) {
      expect(mi).toContain(frag);
      expect(rp).toContain(frag);
    }
  });
});

describe('pretrust', () => {
  const cj = () => join(dir, '.claude.json');

  it('merges trust flags without clobbering other projects', async () => {
    writeFileSync(cj(), JSON.stringify({ projects: { '/other': { keep: true } }, topLevel: 1 }));
    await pretrust('/w');
    const d = JSON.parse(readFileSync(cj(), 'utf8'));
    expect(d.projects['/w'].hasTrustDialogAccepted).toBe(true);
    expect(d.projects['/w'].projectOnboardingSeenCount).toBe(1);
    expect(d.projects['/other'].keep).toBe(true);
    expect(d.topLevel).toBe(1);
  });

  it('creates the file when absent', async () => {
    await pretrust('/w');
    expect(JSON.parse(readFileSync(cj(), 'utf8')).projects['/w'].hasTrustDialogAccepted).toBe(true);
  });

  it('on malformed JSON: warns, skips, and NEVER overwrites the file', async () => {
    const corrupt = '{ "projects": { broken';
    writeFileSync(cj(), corrupt);
    const logs: string[] = [];
    await expect(pretrust('/w', { log: l => logs.push(l) })).resolves.toBeUndefined();
    // The operator's file is left exactly as found — we cannot read it, so we
    // have no right to replace it.
    expect(readFileSync(cj(), 'utf8')).toBe(corrupt);
    expect(logs.join('\n')).toContain('not valid JSON');
    expect(logs.join('\n')).toContain('skipping pre-trust');
  });

  it('a non-object JSON document is skipped just as safely', async () => {
    writeFileSync(cj(), '["not", "an", "object"]');
    const logs: string[] = [];
    await pretrust('/w', { log: l => logs.push(l) });
    expect(readFileSync(cj(), 'utf8')).toBe('["not", "an", "object"]');
    expect(logs.join('\n')).toContain('does not contain a JSON object');
  });

  it('leaves no temp file behind', async () => {
    await pretrust('/w');
    expect(readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([]);
    expect(readdirSync(dir).filter(f => f.endsWith('.lock'))).toEqual([]);
  });

  it('a role launch is never failed by pre-trust, whatever goes wrong', async () => {
    // A realistic mess: something has left a DIRECTORY where the file belongs.
    mkdirSync(cj(), { recursive: true });
    const logs: string[] = [];
    await expect(pretrust('/w', { log: l => logs.push(l) })).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('continuing without pre-trust');
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
    expect(prep.settingsOverlay).toBe(overlay);
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
    expect(prep.settingsOverlay).toBeUndefined();
    expect(existsSync(join(stateDir, '.settings-overlay.json'))).toBe(false);
    expect(prep.env.MEMPALACE_DISABLED).toBeUndefined();
  });

  it('seeds OURS_BIND_IDENTITY so the connector binds without the model doing it', async () => {
    const a = makeClaudeCodeAdapter(okExec);
    const stateDir = join(dir, 'bind'); mkdirSync(stateDir, { recursive: true });
    const prep = await a.prepareSession(
      role({ identity: 'Alice Dev' }), { stateDir, runCwd: stateDir });
    expect(prep.env.OURS_BIND_IDENTITY).toBe('Alice Dev');
  });

  it('carries the bind seed onto the agent-session launch', async () => {
    const a = makeClaudeCodeAdapter(okExec);
    const stateDir = join(dir, 'bind2'); mkdirSync(stateDir, { recursive: true });
    const r = role({ identity: 'Alice Dev' });
    const prep = await a.prepareSession(r, { stateDir, runCwd: stateDir });
    expect(a.agentSession.prepareLaunch(r, prep).env.OURS_BIND_IDENTITY).toBe('Alice Dev');
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

describe('neutral permission mapping and the unattended floor', () => {
  const a = makeClaudeCodeAdapter(okExec);
  const APPROVALS = ['ask', 'auto', 'allow', 'deny'] as const;
  const FILESYSTEMS = ['read-only', 'workspace', 'unrestricted'] as const;
  const UNATTENDED = ['deny', 'wait'] as const;

  it('maps approval: allow to bypassPermissions, the mode that actually allows', () => {
    const t = a.translatePermissions(
      { approval: 'allow', filesystem: 'workspace', unattended: 'deny' });
    expect(t.supported).toBe(true);
    // dontAsk suppresses the prompt but still refuses the action.
    expect((t as { native: Record<string, unknown> }).native.permission_mode).toBe('bypassPermissions');
  });

  it('elevates nothing but an explicit allow', () => {
    const mode = (approval: 'ask' | 'auto' | 'allow' | 'deny') => {
      const t = a.translatePermissions({ approval, filesystem: 'workspace', unattended: 'deny' });
      return (t as { native: Record<string, unknown> }).native.permission_mode;
    };
    expect(mode('ask')).toBe('default');
    expect(mode('auto')).toBe('acceptEdits');
    expect(mode('deny')).toBe('plan');
  });

  it('every neutral combination resolves, and only allow clears the floor', () => {
    for (const approval of APPROVALS)
      for (const filesystem of FILESYSTEMS)
        for (const unattended of UNATTENDED) {
          const label = `${approval}/${filesystem}/${unattended}`;
          const t = a.translatePermissions({ approval, filesystem, unattended });
          expect(t.supported, label).toBe(true);
          const { capabilities } = t as { capabilities: string[] };
          const meets = checkUnattendedFloor(capabilities as never).meets;
          // Only an explicit allow that can also write clears the whole floor.
          expect(meets, label).toBe(approval === 'allow' && filesystem !== 'read-only');
          expect(capabilities, label).toContain('read-state');
        }
  });

  it('a read-only allow role is missing exactly the write capabilities', () => {
    const t = a.translatePermissions(
      { approval: 'allow', filesystem: 'read-only', unattended: 'deny' });
    const { missing } = checkUnattendedFloor((t as { capabilities: never }).capabilities);
    expect(missing).toEqual(['write-state', 'workspace-edit']);
  });

  it('an explicit dontAsk override is judged on what it really grants', () => {
    // The operator may still write dontAsk by hand; the floor must not be fooled
    // by it just because it looks permissive.
    const caps = claudeCapabilities('dontAsk', 'workspace');
    expect(checkUnattendedFloor(caps).meets).toBe(false);
    expect(checkUnattendedFloor(claudeCapabilities('bypassPermissions', 'workspace')).meets).toBe(true);
    expect(checkUnattendedFloor(claudeCapabilities('plan', 'workspace')).missing.length).toBeGreaterThan(0);
  });

  it('effective analysis applies the direct native override that launch uses', () => {
    const r = role({
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      harness_options: { permission_mode: 'dontAsk' },
    });
    const effective = a.effectivePermissions!(r);
    expect(effective.supported).toBe(true);
    expect((effective as { native: Record<string, unknown> }).native)
      .toEqual({ permission_mode: 'dontAsk' });
    expect(checkUnattendedFloor(
      (effective as { capabilities: never[] }).capabilities,
      ['read-state', 'write-state', 'messaging', 'workspace-edit', 'status-commands'],
    ).meets).toBe(false);
  });
});

// ── defect 3: harness_options that used to be silently dropped on ACP ────────
//
// The agent-session adapter builds its own argv and cannot carry prep argv, so the
// `--settings` overlay `plugins` writes was produced and then thrown away for
// every `session: acp` role, with no warning. The mem-palace toggle rode
// `prep.env` and survived, which is what made the failure silent AND selective.
