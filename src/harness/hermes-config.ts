import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import YAML from 'yaml';
import type { ResolvedRole } from '../config.js';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { harnessRuntimeDir } from '../isolation/policy.js';
import { acpMcpServersFor, validateMcpServers, type McpServerSpec } from './acp-mcp.js';
import { translateHermesPermissions } from './hermes-permissions.js';
import type { AcpMcpServer, RoleDirs, SessionPrep, ValidationError } from './types.js';

export interface HermesOptions { mcp_servers?: Record<string, McpServerSpec> }

const mapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const reserved = (key: string): boolean => /^(?:_?HERMES_|OURS_|COPILOT_|CODEX_HOME$|TERMINAL_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|GOOGLE_|GEMINI_|GROQ_|OPENROUTER_|NOUS_|TOGETHER_|FIREWORKS_|DEEPSEEK_|XAI_|MISTRAL_|COHERE_|OLLAMA_|LM_STUDIO_|VLLM_)/i.test(key)
  || /(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|_BASE_URL|_KEY)$/i.test(key);
// Native providers may choose arbitrary credential variable names (key_env).
// An execution allowlist is therefore the inherited baseline, not a credential denylist.
const executionKey = (key: string): boolean => /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|COLORTERM|TMPDIR|TMP|TEMP|TZ|SystemRoot|SYSTEMROOT|WINDIR|COMSPEC|ComSpec|PATHEXT|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|ProgramFiles|NUMBER_OF_PROCESSORS|OS|PROCESSOR_ARCHITECTURE)$/i.test(key);

export function validateHermesOptions(options: unknown): ValidationError[] {
  if (options == null) return [];
  if (!mapping(options)) return [{ path: 'harness_options', message: 'must be a map' }];
  const errors = Object.keys(options).filter(key => key !== 'mcp_servers').map(key => ({ path: `harness_options.${key}`, message: 'unsupported Hermes option; allowed: mcp_servers (provider and credentials must be provisioned in the stopped native home)' }));
  errors.push(...validateMcpServers(options.mcp_servers));
  if (!errors.length && options.mcp_servers != null) {
    const servers = options.mcp_servers as Record<string, McpServerSpec>;
    for (const [name, server] of Object.entries(servers)) {
      const remote = server.type === 'http' || server.type === 'sse';
      const allowed = remote ? ['type', 'url', 'headers'] : ['type', 'command', 'args', 'env'];
      for (const key of Object.keys(server)) if (!allowed.includes(key)) errors.push({ path: `harness_options.mcp_servers.${name}.${key}`, message: 'unsupported field for this MCP transport' });
      for (const key of Object.keys(server.env ?? {})) if (/^(?:OURS_|_?HERMES_)/i.test(key)) errors.push({ path: `harness_options.mcp_servers.${name}.env.${key}`, message: 'reserved Fleet/Hermes environment variable' });
      if (remote) {
        try { if (!['http:', 'https:'].includes(new URL(server.url!).protocol)) throw new Error(); }
        catch { errors.push({ path: `harness_options.mcp_servers.${name}.url`, message: 'must be an absolute HTTP(S) URL' }); }
      }
    }
    if (servers.ours && !identicalOurs(servers.ours)) errors.push({ path: 'harness_options.mcp_servers.ours', message: 'reserved ours connector must be { command: ours-mcp, args: [proxy] } with no overrides' });
  }
  return errors;
}
function identicalOurs(server: McpServerSpec): boolean {
  return Object.keys(server).every(key => ['type', 'command', 'args', 'env'].includes(key))
    && (server.type == null || server.type === 'stdio') && server.command === 'ours-mcp'
    && JSON.stringify(server.args) === '["proxy"]' && Object.keys(server.env ?? {}).length === 0;
}
export function validateHermesRole(role: ResolvedRole): ValidationError[] {
  const errors = validateHermesOptions(role.harness_options);
  if (typeof role.model !== 'string' || !role.model.trim()) errors.push({ path: 'model', message: 'Hermes requires an explicit non-empty Brain model' });
  for (const key of ['effort', 'model_chain'] as const) if (role[key] != null) errors.push({ path: key, message: `Hermes does not support ${key}` });
  if (role.session !== 'acp') errors.push({ path: 'session', message: 'Hermes requires session: acp' });
  if (role.monitor?.mode === 'native') errors.push({ path: 'monitor.mode', message: 'Hermes requires Fleet-owned monitoring' });
  if (role.monitor?.interrupt === 'after_tool') errors.push({ path: 'monitor.interrupt', message: 'Hermes does not support after_tool' });
  const permissions = translateHermesPermissions(role.permissions);
  if (!permissions.supported) errors.push({ path: 'permissions', message: permissions.reason });
  for (const key of Object.keys(role.env ?? {})) if (reserved(key)) errors.push({ path: `env.${key}`, message: 'reserved Hermes/Fleet or provider variable; provision provider credentials in the stopped native home' });
  return errors;
}
function throwErrors(errors: ValidationError[]): void {
  if (errors.length) throw new Error(errors.map(e => `${e.path}: ${e.message}`).join('; '));
}

function nativeCredentialKeys(config: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'key_env' || key === 'api_key_env') && typeof child === 'string' && child.trim()) keys.add(child.trim());
      else visit(child);
    }
  };
  visit(config);
  return keys;
}
function validateNativeCredentialOverrides(role: ResolvedRole, config: Record<string, unknown>): Set<string> {
  const keys = nativeCredentialKeys(config);
  for (const key of keys) if (Object.hasOwn(role.env ?? {}, key)) throw new Error('role.env overrides a native credential variable; provision credentials in the stopped Hermes home');
  return keys;
}

/** Complete environment: transport MUST use inheritEnvironment:false after this final merge. */
export function hermesChildEnvironment(role: ResolvedRole, home: string, trustedFleetEnv: Record<string, string>, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  for (const key of Object.keys(role.env ?? {})) if (reserved(key)) throw new Error(`env.${key} is reserved; provision native credentials in the stopped Hermes home`);
  const credentialKeys = validateNativeCredentialOverrides(role, readConfig(join(home, 'config.yaml')));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) if (value !== undefined && executionKey(key) && !credentialKeys.has(key)) env[key] = value;
  Object.assign(env, role.env);
  for (const [key, value] of Object.entries(trustedFleetEnv)) if (key.startsWith('OURS_')) env[key] = value;
  env.HERMES_HOME = home;
  env.HERMES_ACP_SKIP_CONFIGURED_MCP = '1';
  return env;
}

export function hermesMcpServers(role: ResolvedRole, trustedFleetEnv: Record<string, string> = {}): AcpMcpServer[] {
  throwErrors(validateHermesOptions(role.harness_options));
  const options = (role.harness_options ?? {}) as HermesOptions;
  const oursEnv = Object.fromEntries(Object.entries(trustedFleetEnv).filter(([key]) => key.startsWith('OURS_')));
  return acpMcpServersFor({ ours: { command: 'ours-mcp', args: ['proxy'], env: oursEnv }, ...Object.fromEntries(Object.entries(options.mcp_servers ?? {}).filter(([name]) => name !== 'ours')) })!;
}

function stat(path: string) {
  try { return lstatSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
function regular(path: string): boolean {
  const info = stat(path);
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error(`Hermes requires a regular, non-symlink, unshared file: ${path}`);
  return true;
}
function privateDirectory(path: string): void {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    const info = stat(current);
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error(`Hermes home path must contain directories without symlinks: ${current}`);
    if (!info) mkdirSync(current, { mode: 0o700 });
  }
  chmodSync(absolute, 0o700);
}
function parseNativeFile(path: string): unknown {
  try { return path.endsWith('.json') ? JSON.parse(readFileSync(path, 'utf8')) : YAML.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Invalid Hermes configuration file; repair it with the role stopped: ${path}`); }
}

function validateHomeDotenv(path: string): void {
  if (!regular(path)) return;
  // Native dotenv accepts export and single-quoted keys. Read keys only; never
  // return credential values or native parser diagnostics that may contain them.
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(?:'([^']+)'|([^\s=#]+))\s*=/.exec(line);
    if (!match) continue;
    const key = match[1] ?? match[2];
    if (/^OURS_/i.test(key) || /^(?:_?HERMES_(?:HOME|PROFILE|CONFIG(?:_PATH)?|ENV(?:_PATH)?|SHARED_AUTH_DIR|YOLO_MODE|INTERACTIVE|EXEC_ASK|GATEWAY_SESSION|CRON_SESSION|SINGLE_QUERY_SESSION|SESSION_.*|ACP_AUTO_APPROVE|ACP_SKIP_CONFIGURED_MCP|MODEL|ENABLE_PROJECT_PLUGINS|OPTIONAL_MCPS|SAFE_MODE|IGNORE_USER_CONFIG))$/i.test(key)) {
      throw new Error(`Hermes home dotenv contains a reserved Fleet/Hermes setting; remove it with the role stopped: ${path}`);
    }
  }
}
function readConfig(path: string): Record<string, unknown> {
  if (!regular(path)) return {};
  const doc = parseNativeFile(path);
  if (!mapping(doc)) throw new Error(`Hermes configuration must be a YAML mapping: ${path}`);
  return doc;
}
function managedMapping(config: Record<string, unknown>, key: string): Record<string, unknown> {
  if (config[key] === undefined) return {};
  if (!mapping(config[key])) throw new Error(`Hermes configuration ${key} must be a mapping`);
  return config[key];
}
function validateHomeMcp(config: Record<string, unknown>, home: string): void {
  if (config.mcp_servers != null) {
    if (!mapping(config.mcp_servers)) throw new Error('Hermes home mcp_servers must be a map');
    for (const server of Object.values(config.mcp_servers)) {
      if (!mapping(server) || server.enabled !== false) throw new Error(`Disable home-configured MCP servers in ${join(home, 'config.yaml')}; declare extras through Fleet harness_options.mcp_servers`);
    }
  }
  const plugins = config.plugins;
  if (plugins != null && !mapping(plugins)) throw new Error('Hermes home plugins must be a map');
  const enabled = mapping(plugins) && Array.isArray(plugins.enabled) && plugins.enabled.every(x => typeof x === 'string') ? plugins.enabled : undefined;
  const disabled = mapping(plugins) && Array.isArray(plugins.disabled) ? plugins.disabled : [];
  if (enabled?.length === 0) return;
  const scan = (directory: string, prefix = '', depth = 0): void => {
    const info = stat(directory);
    if (!info) return;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Hermes plugins directory must be a non-symlink directory: ${directory}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Hermes plugin paths must not be symlinks: ${join(directory, entry.name)}`);
      if (!entry.isDirectory()) continue;
      const root = join(directory, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      const manifests = ['plugin.yaml', 'plugin.yml', 'plugin.json'];
      const manifest = manifests.find(name => stat(join(root, name)));
      if (!manifest) { if (depth === 0) scan(root, key, 1); continue; }
      regular(join(root, manifest));
      const value = parseNativeFile(join(root, manifest));
      const name = mapping(value) && typeof value.name === 'string' ? value.name : entry.name;
      if (disabled.includes(key) || disabled.includes(name) || (enabled && !enabled.includes(key) && !enabled.includes(name))) continue;
      const mcpPath = join(root, 'mcp.json');
      if (manifest === 'plugin.json' && regular(mcpPath)) {
        const mcp = parseNativeFile(mcpPath);
        if (!mapping(mcp) || !mapping(mcp.mcpServers) || Object.keys(mcp.mcpServers).length) throw new Error(`Disable MCP-providing agent plugin ${key} in ${join(home, 'config.yaml')}; declare MCP extras through Fleet`);
      }
    }
  };
  scan(join(home, 'plugins'));
}

export async function prepareHermesConfig(role: ResolvedRole, dirs: RoleDirs): Promise<SessionPrep> {
  throwErrors(validateHermesRole(role));
  const home = harnessRuntimeDir(dirs.stateDir, 'hermes');
  privateDirectory(home);
  const file = join(home, 'config.yaml');
  const lock = `${file}.lock`;
  const lockStat = stat(lock);
  if (lockStat?.isSymbolicLink() || (lockStat && !lockStat.isDirectory())) throw new Error(`Hermes configuration lock must be a non-symlink directory: ${lock}`);
  await withFileLock(lock, () => {
    const config = readConfig(file);
    const model = managedMapping(config, 'model');
    const approvals = managedMapping(config, 'approvals');
    validateNativeCredentialOverrides(role, config);
    validateHomeMcp(config, home);
    // Inspect only selected-home metadata; opaque credential values remain native-owned.
    for (const name of ['.env', '.op.env']) validateHomeDotenv(join(home, name));
    config.model = { ...model, default: role.model };
    config.approvals = { ...approvals, mode: 'manual' };
    replaceFileAtomically(file, YAML.stringify(config), 0o600);
  });
  return { env: hermesChildEnvironment(role, home, { OURS_BIND_IDENTITY: role.identity }) };
}
