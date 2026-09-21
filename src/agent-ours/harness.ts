import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    if (value === undefined || (/^OURS_/i.test(key) && !key.startsWith('OURS_FLEET_'))) continue;
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
  const bridge = fileURLToPath(new URL('./bridge.js', import.meta.url));
  const server: AcpMcpServer = {
    name: 'ours',
    command: process.execPath,
    args: [bridge],
    env: [{ name: 'FLEET_OURS_BRIDGE_DESCRIPTOR', value: descriptor }],
  };
  const native = {
    mcp_servers: {
      ours: {
        command: process.execPath,
        args: [bridge],
        env: { FLEET_OURS_BRIDGE_DESCRIPTOR: descriptor },
      },
    },
    plugins: { 'ours@ours-codex-marketplace': { enabled: false } },
  };
  const child = managedChildEnvironment({ ...process.env, ...env });
  if (role.harness === 'codex') {
    const config = child.CODEX_CONFIG ? JSON.parse(child.CODEX_CONFIG) : {};
    child.CODEX_CONFIG = JSON.stringify({
      ...config,
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
