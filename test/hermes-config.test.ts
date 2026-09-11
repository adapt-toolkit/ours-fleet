import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { ResolvedRole } from '../src/config.js';
import { prepareHermesConfig, hermesChildEnvironment, hermesMcpServers, validateHermesOptions, validateHermesRole } from '../src/harness/hermes-config.js';
let root: string;
const role = (extra: Partial<ResolvedRole> = {}): ResolvedRole => ({ name: 'Worker', identity: 'Worker', harness: 'hermes', session: 'acp', model: 'model-a', permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' }, permissionsDeclared: true, sourceFile: 'test', monitor: { mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 0, inject: 'notification', interrupt: false }, ...extra } as ResolvedRole);
const dirs = () => ({ stateDir: join(root, 'Worker'), runCwd: join(root, 'project') });
const home = () => join(dirs().stateDir, 'harness/hermes');
const provision = (config: unknown) => { mkdirSync(home(), { recursive: true }); writeFileSync(join(home(), 'config.yaml'), YAML.stringify(config)); };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-hermes-test-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('Hermes managed home', () => {
  it('creates a private home distinct from cwd and pins managed fields', async () => {
    const prep = await prepareHermesConfig(role(), dirs());
    expect(prep.env.HERMES_HOME).toBe(home());
    expect(prep.env.OURS_BIND_IDENTITY).toBe('Worker');
    expect(statSync(home()).mode & 0o777).toBe(0o700);
    expect(statSync(join(home(), 'config.yaml')).mode & 0o777).toBe(0o600);
    expect(YAML.parse(readFileSync(join(home(), 'config.yaml'), 'utf8'))).toEqual({ model: { default: 'model-a' }, approvals: { mode: 'manual' } });
  });
  it('updates A to B preserving native provider, credentials and opaque state', async () => {
    provision({ model: { default: 'old', provider: 'custom:test', base_url: 'http://localhost:9000' }, approvals: { mode: 'auto', custom: 42 }, memory: { enabled: true } });
    writeFileSync(join(home(), '.env'), 'OPENAI_API_KEY=local-secret\n');
    mkdirSync(join(home(), 'skills')); writeFileSync(join(home(), 'skills/keep'), 'skill');
    writeFileSync(join(home(), 'memories.json'), 'opaque memory');
    await prepareHermesConfig(role(), dirs());
    await prepareHermesConfig(role({ model: 'model-b' }), dirs());
    expect(YAML.parse(readFileSync(join(home(), 'config.yaml'), 'utf8'))).toEqual({ model: { default: 'model-b', provider: 'custom:test', base_url: 'http://localhost:9000' }, approvals: { mode: 'manual', custom: 42 }, memory: { enabled: true } });
    expect(readFileSync(join(home(), '.env'), 'utf8')).toBe('OPENAI_API_KEY=local-secret\n');
    expect(readFileSync(join(home(), 'skills/keep'), 'utf8')).toBe('skill');
    expect(readFileSync(join(home(), 'memories.json'), 'utf8')).toBe('opaque memory');
  });
  it('serializes concurrent preparations and separates role homes', async () => {
    await Promise.all(Array.from({ length: 5 }, () => prepareHermesConfig(role(), dirs())));
    const other = await prepareHermesConfig(role({ identity: 'Other', model: 'model-b' }), { ...dirs(), stateDir: join(root, 'Other') });
    expect(other.env.HERMES_HOME).not.toBe(home());
    expect(YAML.parse(readFileSync(join(home(), 'config.yaml'), 'utf8')).model.default).toBe('model-a');
  });
  it.each([undefined, null, '', '   '])('rejects missing or blank Brain model %s', async model => {
    await expect(prepareHermesConfig(role({ model } as Partial<ResolvedRole>), dirs())).rejects.toThrow(/model/);
  });
  it.each(['[broken', '- a\n- b', 'model: []', 'approvals: 1'])('refuses malformed YAML or non-mapping managed keys: %s', async raw => {
    provision({}); writeFileSync(join(home(), 'config.yaml'), raw);
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow();
    expect(readFileSync(join(home(), 'config.yaml'), 'utf8')).toBe(raw);
  });
  it.each(['config.yaml', 'config.yaml.lock', '.env'])('refuses symlink target %s', async target => {
    mkdirSync(home(), { recursive: true }); const victim = join(root, 'victim'); writeFileSync(victim, 'untouched');
    symlinkSync(victim, join(home(), target));
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow(/symlink|regular/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
  });
  it('refuses a symlink home and a nonregular config', async () => {
    mkdirSync(join(dirs().stateDir, 'harness'), { recursive: true }); mkdirSync(join(root, 'victim'));
    symlinkSync(join(root, 'victim'), home());
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow(/symlink/);
    rmSync(home()); mkdirSync(join(home(), 'config.yaml'), { recursive: true });
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow(/regular/);
  });
  it('rejects enabled home MCP without modifying configuration; permits disabled declarations', async () => {
    provision({ mcp_servers: { external: { command: 'server' } } });
    const raw = readFileSync(join(home(), 'config.yaml'), 'utf8');
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow(/MCP.*disable|disable.*MCP/i);
    expect(readFileSync(join(home(), 'config.yaml'), 'utf8')).toBe(raw);
    provision({ mcp_servers: { external: { command: 'server', enabled: false } } });
    await expect(prepareHermesConfig(role(), dirs())).resolves.toBeDefined();
  });
  it('refuses ambiguous plugin enablement with installed MCP and sanitizes parse failures', async () => {
    const plugin = join(home(), 'plugins/example'); mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'example' }));
    writeFileSync(join(plugin, 'mcp.json'), JSON.stringify({ mcpServers: { extra: { command: 'server' } } }));
    provision({});
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow(/plugin/);
    provision({ plugins: { enabled: ['example'] } });
    writeFileSync(join(plugin, 'plugin.json'), '{"sensitive-sentinel":');
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow(/invalid/i);
    try { await prepareHermesConfig(role(), dirs()); } catch (e) { expect(String(e)).not.toContain('sensitive-sentinel'); }
    writeFileSync(join(home(), 'config.yaml'), 'model: [sensitive-sentinel');
    try { await prepareHermesConfig(role(), dirs()); } catch (e) { expect(String(e)).not.toContain('sensitive-sentinel'); }
  });
  it('rejects enabled portable plugin MCP and permits disabled plugin state', async () => {
    const plugin = join(home(), 'plugins/group/example'); mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'example' }));
    writeFileSync(join(plugin, 'mcp.json'), JSON.stringify({ mcpServers: { extra: { type: 'stdio', command: 'server' } } }));
    provision({ plugins: { enabled: ['group/example'] } });
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow(/plugin.*MCP|MCP.*plugin/);
    provision({ plugins: { enabled: ['group/example'], disabled: ['example'] } });
    await expect(prepareHermesConfig(role(), dirs())).resolves.toBeDefined();
  });
});
describe('Hermes options and environment', () => {
  it.each(['provider', 'effort', 'model_chain', 'permission_mode', 'plugins', 'unknown'])('rejects unsupported option %s', key => {
    expect(validateHermesOptions({ [key]: 'x' })).toEqual(expect.arrayContaining([expect.objectContaining({ path: `harness_options.${key}` })]));
  });
  it.each([{ effort: 'high' }, { model_chain: ['a'] }, { session: 'tmux' }, { monitor: { mode: 'native' } }, { monitor: { mode: 'fleet', interrupt: 'after_tool' } }])('rejects unsupported role setting %j', extra => {
    expect(validateHermesRole(role(extra as Partial<ResolvedRole>)).length).toBeGreaterThan(0);
  });
  it('injects ours, merges an identical declaration once, and retains ACP wire shape', () => {
    const servers = hermesMcpServers(role({ harness_options: { mcp_servers: { ours: { command: 'ours-mcp', args: ['proxy'] }, web: { type: 'http', url: 'http://localhost/mcp', headers: { Authorization: 'fixture' } } } } }), { OURS_BIND_IDENTITY: 'Worker' });
    expect(servers).toEqual([{ name: 'ours', command: 'ours-mcp', args: ['proxy'], env: [{ name: 'OURS_BIND_IDENTITY', value: 'Worker' }] }, { name: 'web', type: 'http', url: 'http://localhost/mcp', headers: [{ name: 'Authorization', value: 'fixture' }] }]);
    expect(() => hermesMcpServers(role({ harness_options: { mcp_servers: { ours: { command: 'evil' } } } }))).toThrow(/reserved ours/);
  });
  it.each([{ x: { command: '' } }, { x: { type: 'http' } }, { x: { command: 'x', args: [1] } }, { x: { command: 'x', env: { a: 1 } } }])('validates MCP declarations %j', mcp_servers => {
    expect(validateHermesOptions({ mcp_servers }).length).toBeGreaterThan(0);
  });
  it.each(['OURS_BIND_IDENTITY', 'OURS_ROUTING_TOKEN', 'HERMES_HOME', 'HERMES_YOLO_MODE', 'HERMES_PROFILE', 'HERMES_SESSION_ID', 'HERMES_ACP_AUTO_APPROVE', 'HERMES_ENABLE_PROJECT_PLUGINS', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'])('rejects reserved role.env %s without echoing its value', key => {
    expect(() => hermesChildEnvironment(role({ env: { [key]: 'sensitive-value' } }), '/managed', {})).toThrow(/reserved|provision/);
    try { hermesChildEnvironment(role({ env: { [key]: 'sensitive-value' } }), '/managed', {}); } catch (e) { expect(String(e)).not.toContain('sensitive-value'); }
  });
  it.each(['.env', '.op.env'])('rejects selected-home %s bypass/routing overrides without exposing values', async name => {
    provision({});
    writeFileSync(join(home(), name), 'export HERMES_YOLO_MODE="sensitive-bypass"\n');
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow(/reserved/);
    writeFileSync(join(home(), name), "'OURS_BIND_IDENTITY'=sensitive-identity\n");
    await expect(prepareHermesConfig(role(), dirs())).rejects.toThrow(/reserved/);
  });
  it.each([{ x: { command: 'x', ignored: true } }, { x: { command: 'x', env: { OURS_BIND_IDENTITY: 'other' } } }, { x: { type: 'http', url: 'invalid url' } }, { x: { type: 'http', url: 'https://example.test', env: { ignored: 'x' } } }])('rejects dropped or reserved MCP options %j', mcp_servers => {
    expect(validateHermesOptions({ mcp_servers }).length).toBeGreaterThan(0);
  });
  it.each(['key_env', 'api_key_env'])('rejects role overrides of native dynamic %s credentials at the final boundary', async hint => {
    provision({ model: { provider: 'custom:test', [hint]: 'PROVIDER_ACCESS' } });
    await expect(prepareHermesConfig(role({ env: { PROVIDER_ACCESS: 'sensitive-value' } }), dirs())).rejects.toThrow(/provision/);
    expect(() => hermesChildEnvironment(role({ env: { PROVIDER_ACCESS: 'sensitive-value' } }), home(), {})).toThrow(/provision/);
    const env = hermesChildEnvironment(role(), home(), {}, { PATH: '/bin', PROVIDER_ACCESS: 'operator-secret' });
    expect(env).not.toHaveProperty('PROVIDER_ACCESS');
  });
  it('filters inherited secrets and bypasses while retaining execution and trusted routing', () => {
    const env = hermesChildEnvironment(role({ env: { CUSTOM_NORMAL: 'ok' } }), '/managed', { OURS_ROUTING_TOKEN: 'trusted' }, { PATH: '/bin', HOME: '/operator', LANG: 'en_US.UTF-8', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'secret', HERMES_YOLO_MODE: '1', HERMES_PROFILE: 'operator', OURS_ROUTING_TOKEN: 'untrusted', UNKNOWN_VENDOR_TOKEN: 'secret', COPILOT_CLI_PATH: '/operator/copilot' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/operator', LANG: 'en_US.UTF-8', SystemRoot: 'C:\\Windows', HERMES_HOME: '/managed', OURS_ROUTING_TOKEN: 'trusted', CUSTOM_NORMAL: 'ok' });
    for (const key of ['OPENAI_API_KEY', 'HERMES_YOLO_MODE', 'HERMES_PROFILE', 'UNKNOWN_VENDOR_TOKEN', 'COPILOT_CLI_PATH']) expect(env).not.toHaveProperty(key);
  });
});
