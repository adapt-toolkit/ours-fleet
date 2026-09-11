import { realExec, type Exec } from '../exec.js';
import type { AcpSessionTransport } from './acp-session-transport.js';
import { HermesAgentSessionAdapter } from './hermes-session.js';
import { inspectHermesCompatibility } from './hermes-compatibility.js';
import { hermesConfiguredProvider, validateHermesHandshake } from './hermes-startup.js';
import { prepareHermesConfig, validateHermesOptions, validateHermesRole } from './hermes-config.js';
import { hermesPermissionMode, translateHermesPermissions } from './hermes-permissions.js';
import { registerAdapter } from './registry.js';
import type { HarnessAdapter } from './types.js';

const wakeNote = 'Your mail wake-ups are delivered by the fleet supervisor as `[fleet-monitor]` lines. '
  + 'Call **get_messages**, handle the mail, and reply with send_message. '
  + 'Do NOT arm arm_monitor, foreground_monitor or a native Hermes monitor.';

export function makeHermesAdapter(exec: Exec = realExec, transport?: AcpSessionTransport): HarnessAdapter {
  return {
    id: 'hermes',
    agentSession: new HermesAgentSessionAdapter(transport, {
      expectedProvider: (_role, prep) => hermesConfiguredProvider(prep.env.HERMES_HOME),
      validateArtifact: validateHermesHandshake,
      async preflight(options, env) {
        const original = new HermesAgentSessionAdapter().prepareLaunch(options.role, options.prep);
        const report = await inspectHermesCompatibility({ argv: original.argv, env, home: options.prep.env.HERMES_HOME }, exec);
        options.log(`Hermes ${report.artifact.hermesVersion}, ACP ${report.artifact.acpVersion}; fresh conversation, MCP availability unverified until actual use`);
      },
    }),
    supportsResume: false,
    async checkPrereqs() {
      const result = await exec('hermes-acp', ['--help'], { timeout: 10_000 });
      const ok = result.code === 0;
      return { ok, checks: [{ name: 'hermes-acp', ok, detail: ok
        ? 'Hermes ACP executable found; launch still requires a tested compatible artifact, an explicit Brain model and provider/credentials provisioned in the exact stopped role home. Home/plugin MCP providers must be disabled.'
        : 'hermes-acp unavailable; install the tested Hermes artifact and provision provider/credentials in the exact stopped role home.' }] };
    },
    validateOptions(options, role) {
      return role ? validateHermesRole({ ...role, harness_options: options as Record<string, unknown> })
        : validateHermesOptions(options);
    },
    prepareSession: prepareHermesConfig,
    // The selected home is already beneath the role state directory, which
    // Fleet mounts writable. No operator home or credential path is shared.
    isolationPaths: () => ({ shared: [] }),
    nativePermissionOverrides: () => ({}),
    translatePermissions: translateHermesPermissions,
    effectivePermissions: role => translateHermesPermissions(role.permissions),
    effectivePermissionMode(role) {
      const nativeMode = hermesPermissionMode(role.permissions);
      return { fleetMode: role.permissions.approval as 'ask' | 'auto' | 'allow', nativeMode };
    },
    vocabulary: {
      bindTool: 'choose_identity', createTool: 'create_identity',
      temporaryCreateTool: 'create_temporary_identity', setBioTool: 'set_bio',
      setPersonaTool: 'set_persona', currentIdentityTool: 'current_identity',
      sendTool: 'send_message', getMessagesTool: 'get_messages',
      listHistoryTool: 'list_history', getHistoryItemTool: 'get_history_item',
      monitorInstruction: () => wakeNote,
      supervisedWakeNote: () => wakeNote,
      launchNote: name => `You were launched as Fleet role ${name} in a fresh Hermes ACP conversation. Confirm you are running.`,
      restartPrompt: (identity, worklog) =>
        `This is a fresh Hermes conversation. Follow the full role briefing, bind identity "${identity}" without force, `
        + `and continue from ${worklog}. Native memory and skills persist; the previous conversation is not restored. ${wakeNote}`,
    },
    exitPolicy: { cleanExitIsFresh: true, fastFailSecs: 20 },
  };
}
export const hermesAdapter = makeHermesAdapter();
registerAdapter(hermesAdapter);
