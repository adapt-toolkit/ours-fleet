import type { AcpMcpServer, ValidationError } from './types.js';

/** One entry of `harness_options.mcp_servers`, in `.mcp.json`'s own shape. */
export interface McpServerSpec {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const MCP_SERVER_TYPES = ['stdio', 'http', 'sse'];

/** Shape-check `harness_options.mcp_servers` against `.mcp.json`'s own rules. */
export function validateMcpServers(servers: unknown): ValidationError[] {
  if (servers == null) return [];
  const at = (k = '') => ({ path: `harness_options.mcp_servers${k}` });
  if (typeof servers !== 'object' || Array.isArray(servers))
    return [{ ...at(), message: 'must be a map of server name to server definition' }];
  const entries = Object.entries(servers as Record<string, unknown>);
  if (!entries.length)
    return [{ ...at(), message: 'must declare at least one server, or be omitted' }];
  const errors: ValidationError[] = [];
  for (const [name, raw] of entries) {
    const p = `.${name}`;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      errors.push({ ...at(p), message: 'server name must be [A-Za-z0-9_-]' });
      continue;
    }
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ ...at(p), message: 'must be a map' });
      continue;
    }
    const s = raw as McpServerSpec;
    if (s.type != null && !MCP_SERVER_TYPES.includes(s.type))
      errors.push({ ...at(`${p}.type`), message: `must be one of: ${MCP_SERVER_TYPES.join(', ')}` });
    const remote = s.type === 'http' || s.type === 'sse';
    if (remote) {
      if (typeof s.url !== 'string' || !s.url.trim())
        errors.push({ ...at(`${p}.url`), message: `must be a non-empty URL for a ${s.type} server` });
      if (s.command != null)
        errors.push({ ...at(`${p}.command`), message: `must not be set for a ${s.type} server` });
    } else {
      if (typeof s.command !== 'string' || !s.command.trim())
        errors.push({ ...at(`${p}.command`), message: 'must be a non-empty command for a stdio server' });
      if (s.args != null && (!Array.isArray(s.args) || s.args.some(a => typeof a !== 'string')))
        errors.push({ ...at(`${p}.args`), message: 'must be an array of strings' });
      if (s.url != null)
        errors.push({ ...at(`${p}.url`), message: 'must not be set for a stdio server' });
    }
    for (const key of ['env', 'headers'] as const) {
      const v = s[key];
      if (v == null) continue;
      if (typeof v !== 'object' || Array.isArray(v)
          || Object.values(v).some(x => typeof x !== 'string'))
        errors.push({ ...at(`${p}.${key}`), message: 'must be a map of string to string' });
    }
  }
  return errors;
}

/** `harness_options.mcp_servers` in ACP's `session/new` array shape. */
export function acpMcpServersFor(
  servers: Record<string, McpServerSpec> | undefined,
): AcpMcpServer[] | undefined {
  if (!servers) return undefined;
  // `env` and `headers` are REQUIRED arrays in the protocol, so they are always
  // sent — empty when the role declared none.
  const pairs = (r: Record<string, string> | undefined) =>
    Object.entries(r ?? {}).map(([name, value]) => ({ name, value }));
  return Object.entries(servers).map(([name, s]) => {
    if (s.type === 'http' || s.type === 'sse')
      return { name, type: s.type, url: s.url!, headers: pairs(s.headers) };
    // Stdio carries NO `type` field: ACP's stdio variant is the one without it,
    // and the bundled agent keys on exactly that (claude-agent-acp
    // acp-agent.js:4058, `!("type" in server)`), so sending `type: 'stdio'`
    // would drop the server on the floor.
    return { name, command: s.command!, args: s.args ?? [], env: pairs(s.env) };
  });
}
