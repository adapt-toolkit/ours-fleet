import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveBundledAcpAgent } from '../harness/acp-agent.js';
import type { AcpMcpServer } from '../harness/types.js';
import type { ResolvedRole } from '../config.js';

export interface ManagedHarnessOurs {
  server: AcpMcpServer;
  native: Record<string, unknown>;
}
/** Do not pass the supervisor's ours connection credentials to harness children. */
export function managedChildEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'FLEET_CURRENT_CHAT_FILES' || value === undefined || (/^OURS_/i.test(key) && !key.startsWith('OURS_FLEET_'))) continue;
    out[key] = value;
  }
  out.FLEET_OURS_MANAGED = '1';
  return out;
}
/** Replace ours only; retain the user's ordinary harness configuration and plugins. */
export function prepareManagedHarness(
  role: ResolvedRole,
  stateDir: string,
  cwd: string,
  descriptor: string,
  env: Record<string, string>,
): { ours: ManagedHarnessOurs; env: Record<string, string> } {
  const child = managedChildEnvironment({ ...process.env, ...env });
  if (role.file_delivery?.enabled) qualifyFileHarness(role, cwd, child);
  const bridge = fileURLToPath(new URL('./bridge.js', import.meta.url));
  const server: AcpMcpServer = {
    name: 'ours',
    command: process.execPath,
    args: [bridge],
    env: [{ name: 'FLEET_OURS_BRIDGE_DESCRIPTOR', value: descriptor }],
  };
  // Portable allow covers bound identity messaging, not all tools on the server.
  const tools = role.harness === 'codex' && role.permissions?.approval === 'allow'
    ? Object.fromEntries([
      'current_identity', 'get_messages', 'list_history', 'list_contacts', 'send_message',
    ].map(name => [name, { approval_mode: 'approve' }]))
    : undefined;
  const native = {
    mcp_servers: {
      ours: {
        command: process.execPath,
        args: [bridge],
        env: { FLEET_OURS_BRIDGE_DESCRIPTOR: descriptor },
        ...(tools ? { tools } : {}),
      },
    },
    plugins: { 'ours@ours-codex-marketplace': { enabled: false } },
  };
  if (role.harness === 'codex') {
    const config = child.CODEX_CONFIG ? JSON.parse(child.CODEX_CONFIG) : {};
    child.CODEX_CONFIG = JSON.stringify({
      ...config,
      mcp_servers: { ...config.mcp_servers, ...native.mcp_servers },
      plugins: { ...config.plugins, ...native.plugins },
    });
    // codex-acp otherwise prefers a same-name connector from the user's config.
    child.DISABLE_MCP_CONFIG_FILTERING = 'true';
  }
  return { ours: { server, native }, env: child };
}
export function managedClaudeMeta(
  base: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const meta = base ?? {},
    claude = (meta.claudeCode ?? {}) as Record<string, unknown>;
  const options = (claude.options ?? {}) as Record<string, unknown>;
  const settings =
    typeof options.settings === 'string'
      ? JSON.parse(readFileSync(options.settings, 'utf8'))
      : ((options.settings ?? {}) as Record<string, unknown>);
  return {
    ...meta,
    claudeCode: {
      ...claude,
      options: {
        ...options,
        settings: {
          ...settings,
          enabledPlugins: { ...settings.enabledPlugins, 'ours@ours.network': false },
        },
      },
    },
  };
}

/** Bounded stock-adapter support; opt-in never silently erases unrelated tools. */
function qualifyFileHarness(role: ResolvedRole, cwd: string, child: Record<string,string>): void {
  if (process.platform !== 'linux') throw Error('CURRENT_CHAT_DELIVERY_UNAVAILABLE: Linux required');
  if (role.session !== 'acp' || role.session_options?.acp?.command) throw Error('CURRENT_CHAT_DELIVERY_UNAVAILABLE: stock ACP adapter required');
  if (role.harness === 'claude-code') {
    if (resolveBundledAcpAgent('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp', 'claude-agent-acp').version !== '0.63.0')
      throw Error('CURRENT_CHAT_DELIVERY_UNAVAILABLE: qualified Claude ACP 0.63.0 required');
    const options = role.harness_options ?? {}, servers = options.mcp_servers as Record<string,unknown> | undefined;
    if (options.mcp_servers_only !== true || !servers || Object.keys(servers).length !== 1 || !servers.ours)
      throw Error('CURRENT_CHAT_DELIVERY_UNAVAILABLE: Claude requires explicit mcp_servers_only and a single ours connector');
    return;
  }
  if (role.harness !== 'codex' || !child.OURS_FLEET_CODEX_ACP_MANIFEST || child.OURS_FLEET_CODEX_DISABLE_INHERITED_MCP === '1')
    throw Error('CURRENT_CHAT_DELIVERY_UNAVAILABLE: managed Codex inventory proxy required');
  const config = JSON.parse(child.CODEX_CONFIG ?? '{}');
  if (config.mcp_servers?.ours?.enabled === false) throw Error('CURRENT_CHAT_DELIVERY_UNAVAILABLE: ours MCP disabled');
  // Public inventory sees effective injected config. Before replacing ours, refuse
  // inherited TOML connector configuration, including disabled/project/profile
  // entries. No TOML guessing or override of an operator's explicit disable.
  const home = child.CODEX_HOME ?? join(child.HOME ?? homedir(), '.codex');
  const paths = [join(home,'config.toml')];
  const profile = role.harness_options?.profile;
  if (typeof profile === 'string') paths.push(join(home,profile+'.config.toml'));
  for (let p = resolve(cwd); p !== resolve(child.HOME ?? homedir());) { paths.push(join(p,'.codex/config.toml')); const next=dirname(p); if(next===p)break;p=next; }
  for (const path of new Set(paths)) if (existsSync(path) && /mcp_servers|mcpServers/.test(readFileSync(path,'utf8')))
    throw Error('CURRENT_CHAT_DELIVERY_UNAVAILABLE: inherited Codex MCP configuration requires inventory support before replacement');
  child.FLEET_CURRENT_CHAT_FILES = '1';
}
