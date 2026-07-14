import { agentDir } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { ResolvedRole } from '../config.js';
import type {
  HarnessAdapter, RoleDirs, SessionPrep, SessionState, Launch, ValidationError,
} from './types.js';
import { registerAdapter } from './registry.js';

interface CodexOptions {
  sandbox?: string;
  approval?: string;
  search?: boolean;
}
const OPTION_KEYS = ['sandbox', 'approval', 'search'];

/** Codex CLI's accepted `--sandbox` values. */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
/** Codex CLI's accepted `--ask-for-approval` values. */
const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'];

/** Resolve & validate the per-role sandbox mode, throwing on an unknown value. */
function sandboxMode(role: ResolvedRole): string | undefined {
  const s = (role.harness_options as CodexOptions | undefined)?.sandbox;
  if (s == null) return undefined;
  if (!SANDBOX_MODES.includes(s))
    throw new Error(`invalid harness_options.sandbox "${s}"; allowed: ${SANDBOX_MODES.join(', ')}`);
  return s;
}

/** Resolve & validate the per-role approval policy, throwing on an unknown value. */
function approvalPolicy(role: ResolvedRole): string | undefined {
  const a = (role.harness_options as CodexOptions | undefined)?.approval;
  if (a == null) return undefined;
  if (!APPROVAL_POLICIES.includes(a))
    throw new Error(`invalid harness_options.approval "${a}"; allowed: ${APPROVAL_POLICIES.join(', ')}`);
  return a;
}

/** Flags shared by fresh launch and resume: model, sandbox, approval, search. */
function commonFlags(role: ResolvedRole): string[] {
  const search = (role.harness_options as CodexOptions | undefined)?.search === true;
  const sm = sandboxMode(role);
  const ap = approvalPolicy(role);
  return [
    ...(role.model ? ['--model', role.model] : []),
    ...(sm ? ['--sandbox', sm] : []),
    ...(ap ? ['--ask-for-approval', ap] : []),
    ...(search ? ['--search'] : []),
  ];
}

export function makeCodexAdapter(exec: Exec = realExec): HarnessAdapter {
  return {
    id: 'codex',
    supportsResume: true,

    async checkPrereqs() {
      const r = await exec('codex', ['--version']);
      const ok = r.code === 0;
      return {
        ok,
        checks: [{
          name: 'codex',
          ok,
          detail: ok ? r.stdout.trim() : 'codex CLI not found on PATH — install the Codex CLI and log in',
        }],
      };
    },

    validateOptions(opts: unknown): ValidationError[] {
      if (opts == null) return [];
      if (typeof opts !== 'object' || Array.isArray(opts))
        return [{ path: 'harness_options', message: 'must be a map' }];
      const errs: ValidationError[] = Object.keys(opts)
        .filter(k => !OPTION_KEYS.includes(k))
        .map(k => ({ path: `harness_options.${k}`, message: `unknown option; allowed: ${OPTION_KEYS.join(', ')}` }));
      const o = opts as CodexOptions;
      if (o.sandbox != null && !SANDBOX_MODES.includes(o.sandbox))
        errs.push({ path: 'harness_options.sandbox', message: `must be one of: ${SANDBOX_MODES.join(', ')}` });
      if (o.approval != null && !APPROVAL_POLICIES.includes(o.approval))
        errs.push({ path: 'harness_options.approval', message: `must be one of: ${APPROVAL_POLICIES.join(', ')}` });
      return errs;
    },

    async prepareSession(_role: ResolvedRole, _dirs: RoleDirs): Promise<SessionPrep> {
      // Codex has no "trust this folder" dialog to pre-seed and no plugin overlay
      // file to write — permissions are argv flags handled in buildLaunch.
      return { argv: [], env: {} };
    },

    buildLaunch(role: ResolvedRole, mode: 'fresh' | 'resume', _s: SessionState, prep: SessionPrep): Launch {
      const stateDir = roleStateDir(role);
      const flags = commonFlags(role);
      const argv = mode === 'fresh'
        ? ['codex', ...flags, ...prep.argv, `Read and follow ${join(stateDir, 'briefing.md')} now.`]
        : ['codex', 'resume', '--last', ...flags, ...prep.argv,
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
        `Codex has no persistent Monitor primitive, so arm mail-watch yourself: run ` +
        `\`${`ours-mcp watch "${id}"`}\` as a background shell command and check its output ` +
        `between turns (or poll **get_messages** at the top of each turn).`,
      launchNote: name => `You were launched as the fleet role \`${name}\` under a Codex session. Confirm you are running.`,
      restartPrompt: (id, worklog) =>
        `Session restarted. Re-bind your ours identity now (choose_identity name "${id}" force=true), ` +
        `re-arm mail-watch (\`ours-mcp watch "${id}"\` as a background shell command), then continue ` +
        `from ${worklog}. Do not re-run whatever crashed you.`,
    },

    exitPolicy: { cleanExitIsFresh: true, fastFailSecs: 20 },
  };
}

// The adapter needs the state dir for briefing/worklog paths in launch prompts.
// Roles' state dirs are canonical: agentDir(name) — temp roles carry their dir in cwd handling
// by the runner, which passes dirs to prepareSession; buildLaunch derives from the same rule.
import { join } from 'node:path';
function roleStateDir(role: ResolvedRole): string {
  // Temp roles are marked by the runner via a private field to keep the interface small.
  const temp = (role as ResolvedRole & { __temp?: boolean }).__temp === true;
  return agentDir(role.name, temp);
}

export const codexAdapter = makeCodexAdapter();
registerAdapter(codexAdapter);
