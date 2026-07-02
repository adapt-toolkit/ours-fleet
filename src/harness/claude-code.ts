import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { ResolvedRole } from '../config.js';
import type {
  HarnessAdapter, RoleDirs, SessionPrep, SessionState, Launch, ValidationError,
} from './types.js';
import { registerAdapter } from './registry.js';

interface ClaudeOptions {
  plugins?: Record<string, boolean>;
  mem_palace?: boolean;
  mem_palace_midsession_autosave?: boolean;
}
const OPTION_KEYS = ['plugins', 'mem_palace', 'mem_palace_midsession_autosave'];

/** Context window of the fleet model (1M); max_tokens → % of this. */
const WINDOW = 1_000_000;

export function autocompactPct(role: ResolvedRole): number {
  let pct: number;
  if (role.autocompact_pct != null) pct = Math.round(role.autocompact_pct);
  else if (role.max_tokens != null) pct = Math.round((role.max_tokens / WINDOW) * 100);
  else return 50;
  return Math.max(1, Math.min(100, pct));
}

/** Pre-trust a dir in ~/.claude.json so the first launch never blocks on the trust dialog. */
export function pretrust(dir: string): void {
  const p = join(home(), '.claude.json');
  const d = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  const projects = (d.projects ??= {});
  const e = (projects[dir] ??= {});
  e.hasTrustDialogAccepted = true;
  e.hasCompletedProjectOnboarding = true;
  e.projectOnboardingSeenCount = Math.max(e.projectOnboardingSeenCount ?? 0, 1);
  writeFileSync(p, JSON.stringify(d, null, 2));
}

export function makeClaudeCodeAdapter(exec: Exec = realExec): HarnessAdapter {
  return {
    id: 'claude-code',
    supportsResume: true,

    async checkPrereqs() {
      const r = await exec('claude', ['--version']);
      const ok = r.code === 0;
      return {
        ok,
        checks: [{
          name: 'claude',
          ok,
          detail: ok ? r.stdout.trim() : 'claude CLI not found on PATH — install Claude Code and log in',
        }],
      };
    },

    validateOptions(opts: unknown): ValidationError[] {
      if (opts == null) return [];
      if (typeof opts !== 'object' || Array.isArray(opts))
        return [{ path: 'harness_options', message: 'must be a map' }];
      return Object.keys(opts)
        .filter(k => !OPTION_KEYS.includes(k))
        .map(k => ({ path: `harness_options.${k}`, message: `unknown option; allowed: ${OPTION_KEYS.join(', ')}` }));
    },

    async prepareSession(role: ResolvedRole, dirs: RoleDirs): Promise<SessionPrep> {
      pretrust(dirs.stateDir);
      if (dirs.runCwd && dirs.runCwd !== dirs.stateDir) pretrust(dirs.runCwd);
      const o = (role.harness_options ?? {}) as ClaudeOptions;
      const memPalace = o.mem_palace !== false;
      const enabledPlugins: Record<string, boolean> = { ...(o.plugins ?? {}) };
      if (!memPalace) enabledPlugins['mempalace@mempalace'] = false;

      const env: Record<string, string> = {
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(autocompactPct(role)),
        MEMPALACE_HOOKS_AUTO_SAVE: 'false',
        MEMPALACE_MIDSESSION_AUTOSAVE: o.mem_palace_midsession_autosave ? 'true' : 'false',
      };
      if (!memPalace) env.MEMPALACE_DISABLED = 'true';

      const argv: string[] = [];
      if (Object.keys(enabledPlugins).length) {
        const overlay = join(dirs.stateDir, '.settings-overlay.json');
        writeFileSync(overlay, JSON.stringify({ enabledPlugins }, null, 2));
        argv.push('--settings', overlay);
      }
      return { argv, env };
    },

    buildLaunch(role: ResolvedRole, mode: 'fresh' | 'resume', s: SessionState, prep: SessionPrep): Launch {
      const stateDir = roleStateDir(role);
      const base = ['claude', ...prep.argv, '--remote-control', role.name];
      const argv = mode === 'fresh'
        ? [...base, '--session-id', s.sessionId, `Read and follow ${join(stateDir, 'briefing.md')} now.`]
        : [...base, '--resume', s.sessionId,
            this.vocabulary.restartPrompt(role.identity, join(stateDir, 'WORKLOG.md'))];
      return { argv, env: prep.env };
    },

    vocabulary: {
      bindTool: 'choose_identity',
      createTool: 'create_identity',
      setBioTool: 'set_bio',
      setPersonaTool: 'set_persona',
      currentIdentityTool: 'current_identity',
      sendTool: 'send_message',
      getMessagesTool: 'get_messages',
      watchCommand: id => `ours-mcp watch "${id}"`,
      monitorInstruction: id =>
        `Arm a **persistent Monitor** running the shell command \`ours-mcp watch "${id}"\` so inbound ours mail wakes you.`,
      launchNote: name => `You were launched with \`--remote-control ${name}\`. Confirm you are running.`,
      restartPrompt: (id, worklog) =>
        `Session restarted. Re-bind your ours identity now (choose_identity name "${id}" force=true), ` +
        `re-arm your monitor (ours-mcp watch "${id}"), then continue from ${worklog}. ` +
        'Do not re-run whatever crashed you.',
    },

    exitPolicy: { cleanExitIsFresh: true, fastFailSecs: 20 },
  };
}

// The adapter needs the state dir for briefing/worklog paths in launch prompts.
// Roles' state dirs are canonical: agentDir(name) — temp roles carry their dir in cwd handling
// by the runner, which passes dirs to prepareSession; buildLaunch derives from the same rule.
import { agentDir } from '../paths.js';
function roleStateDir(role: ResolvedRole): string {
  // Temp roles are marked by the runner via a private field to keep the interface small.
  const temp = (role as ResolvedRole & { __temp?: boolean }).__temp === true;
  return agentDir(role.name, temp);
}

export const claudeCodeAdapter = makeClaudeCodeAdapter();
registerAdapter(claudeCodeAdapter);
