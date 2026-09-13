import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import { realExec, type Exec } from '../exec.js';

export const TESTED_HERMES_ARTIFACT = {
  commit: 'd15ed4445207dda418b984e8bda0f68f48b8c6f3', hermesVersion: '0.21.1', acpVersion: '0.9.0', protocolVersion: 1,
} as const;
export const TESTED_HERMES_COMPACTION_ARTIFACT = {
  commit: '89c309efb8feb95dfb7d0898a35a76a6faa659f4', hermesVersion: '0.21.1',
  acpVersion: '0.9.0+ours.compaction1', protocolVersion: 1,
  acpSourceDigest: '945a8c8c26e214e1fad043fc308026e54b5ade5c3ce636f9bb82255c44998866',
} as const;
type TestedHermesArtifact = typeof TESTED_HERMES_ARTIFACT | typeof TESTED_HERMES_COMPACTION_ARTIFACT;
export interface HermesCompatibilityReport {
  artifact: TestedHermesArtifact & { sourceRoot: string; executable: string };
  /** Scoped prerequisite only: ACP connection/tool availability and other launch checks remain separate. */
  pluginMcp: 'absent-in-validated-sources';
}
export interface HermesCompatibilityRequest { argv: string[]; env: Record<string, string>; home: string }
const fail = (detail: string): never => { throw new Error(`Hermes compatibility: ${detail}. Use the tested Hermes source/build and a supported hermes-acp launcher, or validate the new artifact before launch`); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function stat(path: string) {
  try { return lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return fail('cannot inspect a required artifact or plugin file'); }
}
function read(path: string): string | undefined {
  const info = stat(path);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) return fail('artifact and plugin inputs must be regular non-symlink files');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); }
  catch { return fail('cannot read a required UTF-8 artifact or plugin file'); }
}
function document(path: string): Record<string, unknown> {
  const text = read(path);
  if (text === undefined) return {};
  try { const value: unknown = path.endsWith('.json') ? JSON.parse(text) : YAML.parse(text); if (object(value)) return value; }
  catch { /* parser diagnostics may contain secrets */ }
  return fail('invalid artifact or plugin configuration');
}
const CONSOLE_BODY = '# -*- coding: utf-8 -*-\nimport sys\nfrom acp_adapter.entry import main\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(main())\n';
function launcher(request: HermesCompatibilityRequest): { executable: string; sourceRoot: string; interpreter: string } {
  if (request.argv.length !== 1 || !request.argv[0]) return fail('only the original hermes-acp executable without shell commands or extra flags has been tested');
  const command = request.argv[0];
  const candidates = isAbsolute(command) ? [command] : command.includes('/') ? [resolve(command)] : (request.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, command));
  let executable: string | undefined;
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); executable = realpathSync(path); break; } catch { /* next PATH entry */ }
  }
  if (!executable) return fail('hermes-acp executable was not found');
  const text = read(executable);
  if (!text || text.length > 4096) return fail('unrecognized hermes-acp launcher');
  const sourceRoot = dirname(dirname(dirname(executable)));
  const interpreter = join(sourceRoot, 'venv/bin/python3');
  if (basename(executable) === 'hermes-acp' && text === `#!${interpreter}\n${CONSOLE_BODY}`) return { executable, sourceRoot, interpreter };
  const shim = /^#!\/usr\/bin\/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "([^"\n]+)\/venv\/bin\/python" "\1\/hermes" acp "\$@"\n$/.exec(text);
  if (shim && isAbsolute(shim[1])) return { executable, sourceRoot: shim[1], interpreter: join(shim[1], 'venv/bin/python') };
  return fail('unrecognized hermes-acp launcher; a version string alone does not identify tested code');
}
// Standard-library metadata only. No Hermes config, dotenv, plugin module, or credential loader is imported.
const METADATA_PROBE = `import importlib.metadata as m, importlib.util as u, json, hashlib
from pathlib import Path
s=u.find_spec('acp_adapter')
a=u.find_spec('acp')
digest=None
if a and a.origin:
    root=Path(a.origin).parent
    files={}
    for p in sorted(root.rglob('*')):
        if p.is_symlink(): raise ValueError('unverified SDK symlink')
        if p.is_file() and '__pycache__' not in p.relative_to(root).parts:
            files[p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
    digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()
e=m.entry_points()
e=e.select(group='hermes_agent.plugins') if hasattr(e,'select') else e.get('hermes_agent.plugins',[])
print(json.dumps({'hermesVersion':m.version('hermes-agent'),'acpVersion':m.version('agent-client-protocol'),'acpSourceDigest':digest,'adapterOrigin':s.origin if s else None,'entryPoints':[{'name':x.name,'value':x.value} for x in e]}))`;
interface Metadata { acpSourceDigest?: string; hermesVersion: string; acpVersion: string; adapterOrigin: string; entryPoints: { name: string; value: string }[] }
interface Plugin { key: string; name: string; source: 'bundled' | 'home' | 'entrypoint'; portable: boolean; path?: string }
function collectPlugins(directory: string, source: Plugin['source'], skip: Set<string> = new Set(), prefix = '', depth = 0): Plugin[] {
  const info = stat(directory);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) return fail('plugin source must be a non-symlink directory');
  const found: Plugin[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (depth === 0 && skip.has(entry.name)) continue;
    if (entry.isSymbolicLink()) return fail('unverified symlink in plugin discovery');
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    const filename = ['plugin.yaml', 'plugin.yml', 'plugin.json'].find(name => stat(join(path, name)));
    if (!filename) { if (depth === 0) found.push(...collectPlugins(path, source, new Set(), entry.name, 1)); continue; }
    const data = document(join(path, filename));
    const name = typeof data.name === 'string' && data.name ? data.name : entry.name;
    found.push({ name, key: prefix ? `${prefix}/${entry.name}` : name, source, portable: filename === 'plugin.json', path });
  }
  return found;
}
function names(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) return fail(`plugins.${field} must contain literal names`);
  if (value.some(name => /\$\{/.test(name))) return fail(`plugins.${field} interpolation is unsupported; use literal names`);
  return value as string[];
}
function validatePluginSources(request: HermesCompatibilityRequest, sourceRoot: string, metadata: Metadata): void {
  for (const name of ['HERMES_BUNDLED_PLUGINS', 'HERMES_ENABLE_PROJECT_PLUGINS']) if (request.env[name] !== undefined) return fail('plugin discovery environment overrides are unsupported');
  for (const filename of ['.env', '.op.env']) {
    const content = read(join(request.home, filename));
    if (content === undefined) continue;
    if (/[\0\u001c-\u001f\u0085]/.test(content)) return fail('unsupported plugin dotenv encoding');
    for (const line of content.split(/\r\n?|\n/)) {
      const match = /^\s*(?:export\s+)?(?:'([^']+)'|([^\s=#]+))\s*=/.exec(line);
      if (match && ['HERMES_BUNDLED_PLUGINS', 'HERMES_ENABLE_PROJECT_PLUGINS'].includes(match[1] ?? match[2])) return fail('plugin discovery redirection in selected-home dotenv is unsupported; remove it with the role stopped');
    }
  }
  const config = document(join(request.home, 'config.yaml'));
  if (config.plugins !== undefined && !object(config.plugins)) return fail('plugins configuration must be a map');
  const plugins = object(config.plugins) ? config.plugins : {};
  const enabled = names(plugins.enabled, 'enabled');
  const disabled = names(plugins.disabled, 'disabled') ?? [];
  const bundled = join(sourceRoot, 'plugins');
  // Match native precedence: bundled, bundled/platforms, home, then entry points. Project plugins are refused above.
  const all: Plugin[] = [...collectPlugins(bundled, 'bundled', new Set(['memory', 'context_engine', 'platforms', 'model-providers'])), ...collectPlugins(join(bundled, 'platforms'), 'bundled'), ...collectPlugins(join(request.home, 'plugins'), 'home'), ...metadata.entryPoints.map(entry => ({ name: entry.name, key: entry.name, source: 'entrypoint' as const, portable: false }))];
  const winners = new Map(all.map(plugin => [plugin.key, plugin]));
  for (const plugin of winners.values()) {
    if ([plugin.key, plugin.name].some(name => disabled.includes(name))) continue;
    // Known bundled code includes native auto-loaded backends. It is part of the pinned clean source.
    if (plugin.source !== 'bundled' && enabled && ![plugin.key, plugin.name].some(name => enabled.includes(name))) continue;
    if (!plugin.portable && plugin.source !== 'bundled') return fail('enabled unreviewed home/entry-point plugin code cannot be verified MCP-free; disable that plugin or validate its artifact');
    if (plugin.portable && plugin.path && stat(join(plugin.path, 'mcp.json'))) {
      const mcp = document(join(plugin.path, 'mcp.json'));
      if (!object(mcp.mcpServers) || Object.keys(mcp.mcpServers).length) return fail('enabled plugin provides MCP; disable the plugin and declare extras through ACP mcpServers');
    }
  }
}

/** Check original, unwrapped argv. This does not certify an isolation wrapper or claim MCP tool readiness. */
export async function inspectHermesCompatibility(request: HermesCompatibilityRequest, exec: Exec = realExec): Promise<HermesCompatibilityReport> {
  const chain = launcher(request);
  // Use ordinary supervisor execution state, not role overrides, for inspection subprocesses.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: request.env.HOME, HERMES_HOME: request.home };
  const opts = { env, timeout: 10_000 };
  const [head, status] = await Promise.all([
    exec('git', ['-C', chain.sourceRoot, 'rev-parse', 'HEAD'], opts),
    exec('git', ['-C', chain.sourceRoot, 'status', '--porcelain', '--untracked-files=all'], opts),
  ]);
  const artifact = [TESTED_HERMES_ARTIFACT, TESTED_HERMES_COMPACTION_ARTIFACT].find(candidate => candidate.commit === head.stdout.trim());
  if (head.code || status.code || !artifact || status.stdout.trim()) return fail('source checkout is not the tested clean Git artifact');
  const result = await exec(chain.interpreter, ['-I', '-B', '-c', METADATA_PROBE], opts);
  if (result.code) return fail('could not inspect the tested Python package metadata');
  let metadata: Metadata;
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!object(value) || typeof value.adapterOrigin !== 'string' || !Array.isArray(value.entryPoints) || value.entryPoints.some(entry => !object(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string')) return fail('invalid Python package metadata');
    metadata = value as unknown as Metadata;
  } catch { return fail('invalid Python package metadata'); }
  if (metadata.hermesVersion !== artifact.hermesVersion || metadata.acpVersion !== artifact.acpVersion || resolve(metadata.adapterOrigin) !== join(chain.sourceRoot, 'acp_adapter/__init__.py')) return fail('Python packages or ACP source origin differ from the tested build');
  if ('acpSourceDigest' in artifact && metadata.acpSourceDigest !== artifact.acpSourceDigest) return fail('SDK source digest differs from the reviewed packaged artifact');
  validatePluginSources(request, chain.sourceRoot, metadata);
  return { artifact: { ...artifact, sourceRoot: chain.sourceRoot, executable: chain.executable }, pluginMcp: 'absent-in-validated-sources' };
}

/** Native identity check, separate from session model/provider validation and first actual MCP use. */
export function validateHermesInitialize(response: unknown): void {
  if (!object(response) || response.protocolVersion !== TESTED_HERMES_ARTIFACT.protocolVersion || !object(response.agentInfo) || response.agentInfo.name !== 'hermes-agent' || response.agentInfo.version !== TESTED_HERMES_ARTIFACT.hermesVersion) fail('ACP initialize identity/protocol does not match the tested Hermes artifact');
}
