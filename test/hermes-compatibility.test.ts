import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Exec } from '../src/exec.js';
import { inspectHermesCompatibility, validateHermesInitialize } from '../src/harness/hermes-compatibility.js';
const commit = 'd15ed4445207dda418b984e8bda0f68f48b8c6f3';
const consoleBody = '# -*- coding: utf-8 -*-\nimport sys\nfrom acp_adapter.entry import main\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(main())\n';
let root: string, source: string, home: string, executable: string;
let metadata: { hermesVersion: string; acpVersion: string; adapterOrigin: string; entryPoints: { name: string; value: string }[]; acpSourceDigest?: string };
let head: string, status: string;
let exec: Exec;
const request = () => ({ argv: [executable], env: { PATH: join(source, 'venv/bin'), HOME: root, HERMES_HOME: home }, home });
const provision = (config: unknown) => writeFileSync(join(home, 'config.yaml'), YAML.stringify(config));
function plugin(base: string, directory: string, manifest: Record<string, unknown>, portable = false, mcp?: unknown) {
  const path = join(base, directory); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, portable ? 'plugin.json' : 'plugin.yaml'), portable ? JSON.stringify(manifest) : YAML.stringify(manifest));
  if (mcp !== undefined) writeFileSync(join(path, 'mcp.json'), JSON.stringify(mcp));
  return path;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-hermes-compat-'));
  source = join(root, 'native'); home = join(root, 'home'); executable = join(source, 'venv/bin/hermes-acp');
  mkdirSync(join(source, 'venv/bin'), { recursive: true }); mkdirSync(join(source, 'acp_adapter')); mkdirSync(home);
  writeFileSync(executable, `#!${join(source, 'venv/bin/python3')}\n${consoleBody}`); chmodSync(executable, 0o700);
  writeFileSync(join(source, 'venv/bin/python3'), 'fixture-interpreter'); chmodSync(join(source, 'venv/bin/python3'), 0o700);
  writeFileSync(join(source, 'venv/bin/python'), 'fixture-interpreter'); chmodSync(join(source, 'venv/bin/python'), 0o700);
  writeFileSync(join(source, 'hermes'), 'fixture-source-launcher');
  metadata = { hermesVersion: '0.21.1', acpVersion: '0.9.0', adapterOrigin: join(source, 'acp_adapter/__init__.py'), entryPoints: [] };
  head = commit; status = '';
  exec = vi.fn(async (command, args) => ({ code: 0, stderr: '', stdout: command === 'git' ? args.includes('status') ? status : head : JSON.stringify(metadata) }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('Hermes tested artifact compatibility', () => {
  it('validates exact launcher, pinned clean source, package metadata and adapter origin', async () => {
    const report = await inspectHermesCompatibility(request(), exec);
    expect(report).toMatchObject({ artifact: { commit, hermesVersion: '0.21.1', acpVersion: '0.9.0', protocolVersion: 1, sourceRoot: source, executable }, pluginMcp: 'absent-in-validated-sources' });
    expect(exec).not.toHaveBeenCalledWith(executable, expect.anything(), expect.anything());
    const call = vi.mocked(exec).mock.calls.find(([command]) => command !== 'git')!;
    expect(call[1]).toEqual(expect.arrayContaining(['-I', '-B', '-c']));
    expect(call[1].join(' ')).not.toMatch(/import.*hermes_cli|import.*plugins|load_config/);
    expect(call[2]?.env).not.toHaveProperty('OPENAI_API_KEY');
  });
  it('accepts the exact packaged source and verified SDK source digest', async () => {
    head = '89c309efb8feb95dfb7d0898a35a76a6faa659f4';
    metadata.acpVersion = '0.9.0+ours.compaction1';
    metadata.acpSourceDigest = '945a8c8c26e214e1fad043fc308026e54b5ade5c3ce636f9bb82255c44998866';
    await expect(inspectHermesCompatibility(request(), exec)).resolves.toMatchObject({
      artifact: { commit: head, acpVersion: metadata.acpVersion },
    });
  });
  it.each(['missing-digest', 'tampered-sdk', 'wrong-sdk', 'dirty-source', 'mixed-baseline'])(
    'rejects a mismatched packaged artifact: %s', async dimension => {
      head = '89c309efb8feb95dfb7d0898a35a76a6faa659f4';
      metadata.acpVersion = '0.9.0+ours.compaction1';
      metadata.acpSourceDigest = '945a8c8c26e214e1fad043fc308026e54b5ade5c3ce636f9bb82255c44998866';
      if (dimension === 'missing-digest') delete metadata.acpSourceDigest;
      if (dimension === 'tampered-sdk') metadata.acpSourceDigest = '0'.repeat(64);
      if (dimension === 'wrong-sdk') metadata.acpVersion = '0.9.0';
      if (dimension === 'dirty-source') status = ' M acp_adapter/server.py';
      if (dimension === 'mixed-baseline') head = commit;
      await expect(inspectHermesCompatibility(request(), exec)).rejects.toThrow(/compatibility|tested/i);
    },
  );
  it('resolves the default executable on final PATH and follows a launcher symlink', async () => {
    const alias = join(root, 'bin'); mkdirSync(alias); symlinkSync(executable, join(alias, 'hermes-acp'));
    const report = await inspectHermesCompatibility({ ...request(), argv: ['hermes-acp'], env: { ...request().env, PATH: alias } }, exec);
    expect(report.artifact.executable).toBe(executable);
  });
  it('recognizes only the tested bash shim execution chain', async () => {
    const wrapper = join(root, 'hermes-acp');
    writeFileSync(wrapper, `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${source}/venv/bin/python" "${source}/hermes" acp "$@"\n`); chmodSync(wrapper, 0o700);
    const report = await inspectHermesCompatibility({ ...request(), argv: [wrapper] }, exec);
    expect(report.artifact.sourceRoot).toBe(source);
    expect(vi.mocked(exec).mock.calls.some(([command]) => command === join(source, 'venv/bin/python'))).toBe(true);
  });
  it.each(['shell', 'flags', 'changed-console'])('refuses an unverified execution chain: %s', async kind => {
    const input = request();
    if (kind === 'shell') input.argv = ['sh', '-c', 'hermes-acp'];
    if (kind === 'flags') input.argv.push('--setup');
    if (kind === 'changed-console') writeFileSync(executable, `#!${join(source, 'venv/bin/python3')}\nprint('0.21.1')\n`);
    await expect(inspectHermesCompatibility(input, exec)).rejects.toThrow(/compatibility|tested/i);
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(['head', 'dirty', 'untracked', 'version', 'acp', 'origin'])('rejects an untested artifact dimension: %s', async field => {
    if (field === 'head') head = '0'.repeat(40);
    if (field === 'dirty') status = ' M acp_adapter/server.py';
    if (field === 'untracked') status = '?? plugins/hidden/plugin.yaml';
    if (field === 'version') metadata.hermesVersion = '0.21.2';
    if (field === 'acp') metadata.acpVersion = '0.10.0';
    if (field === 'origin') metadata.adapterOrigin = '/different/acp_adapter/__init__.py';
    await expect(inspectHermesCompatibility(request(), exec)).rejects.toThrow(/compatibility|tested/i);
  });
  it('sanitizes failed metadata and git diagnostics', async () => {
    const bad: Exec = async () => ({ code: 1, stdout: 'secret-sentinel', stderr: 'secret-sentinel' });
    const error = await inspectHermesCompatibility(request(), bad).then(() => undefined, e => e);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('secret-sentinel');
  });
  it('checks native initialize identity separately from tool readiness', () => {
    expect(() => validateHermesInitialize({ protocolVersion: 1, agentInfo: { name: 'hermes-agent', version: '0.21.1' } })).not.toThrow();
    for (const response of [{ protocolVersion: 2, agentInfo: { name: 'hermes-agent', version: '0.21.1' } }, { protocolVersion: 1, agentInfo: { name: 'fake', version: '0.21.1' } }, {}]) expect(() => validateHermesInitialize(response)).toThrow(/compatibility/i);
  });
});
describe('Hermes effective plugin MCP sources', () => {
  it('accepts pinned bundled backends even with empty plugins.enabled', async () => {
    provision({ plugins: { enabled: [] } });
    plugin(join(source, 'plugins'), 'terminal/local', { name: 'local', kind: 'backend' });
    plugin(join(source, 'plugins'), 'platforms/local', { name: 'local', kind: 'platform' });
    await expect(inspectHermesCompatibility(request(), exec)).resolves.toMatchObject({ pluginMcp: 'absent-in-validated-sources' });
  });
  it('allows an MCP-free enabled portable home plugin and preserves its files', async () => {
    provision({ plugins: { enabled: ['example'] } });
    const path = plugin(join(home, 'plugins'), 'different-directory', { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'example' }, true);
    const before = readFileSync(join(path, 'plugin.json'));
    await expect(inspectHermesCompatibility(request(), exec)).resolves.toBeDefined();
    expect(readFileSync(join(path, 'plugin.json'))).toEqual(before);
  });
  it('rejects enabled portable MCP without removing declarations', async () => {
    provision({ plugins: { enabled: ['group/example'] } });
    const path = plugin(join(home, 'plugins'), 'group/example', { name: 'example' }, true, { mcpServers: { extra: { command: 'fixture-not-executed' } } });
    const before = readFileSync(join(path, 'mcp.json'));
    await expect(inspectHermesCompatibility(request(), exec)).rejects.toThrow(/MCP/);
    expect(readFileSync(join(path, 'mcp.json'))).toEqual(before);
  });
  it('respects disabled names and refuses enabled unreviewed home code', async () => {
    const path = plugin(join(home, 'plugins'), 'unknown', { name: 'unknown' });
    writeFileSync(join(path, '__init__.py'), "raise RuntimeError('must-not-execute')");
    provision({ plugins: { enabled: ['unknown'] } });
    await expect(inspectHermesCompatibility(request(), exec)).rejects.toThrow(/unreviewed|unverified/i);
    provision({ plugins: { enabled: ['unknown'], disabled: ['unknown'] } });
    await expect(inspectHermesCompatibility(request(), exec)).resolves.toBeDefined();
  });
  it('rejects effective entrypoints without importing them and respects native winner precedence', async () => {
    plugin(join(source, 'plugins'), 'example', { name: 'example', kind: 'backend' });
    provision({ plugins: { enabled: ['example'] } });
    metadata.entryPoints = [{ name: 'example', value: 'fixture_never_import:register' }];
    await expect(inspectHermesCompatibility(request(), exec)).rejects.toThrow(/entry.point|unreviewed/i);
    provision({ plugins: { enabled: ['example'], disabled: ['example'] } });
    await expect(inspectHermesCompatibility(request(), exec)).resolves.toBeDefined();
  });
  it('lets the user-source winner override a bundled key before evaluating safety', async () => {
    plugin(join(source, 'plugins'), 'example', { name: 'example', kind: 'backend' });
    plugin(join(home, 'plugins'), 'different', { name: 'example' });
    provision({ plugins: { enabled: ['example'] } });
    await expect(inspectHermesCompatibility(request(), exec)).rejects.toThrow(/unreviewed|unverified/i);
  });
  it.each(['HERMES_BUNDLED_PLUGINS', 'HERMES_ENABLE_PROJECT_PLUGINS'])('refuses redirected plugin discovery from selected-home dotenv: %s', async key => {
    const bytes = Buffer.from(`${key}=secret-path-sentinel\n`); writeFileSync(join(home, '.env'), bytes);
    const error = await inspectHermesCompatibility(request(), exec).then(() => undefined, e => e);
    expect(error).toBeInstanceOf(Error); expect(String(error)).toMatch(/plugin/i); expect(String(error)).not.toContain('secret-path-sentinel');
    expect(readFileSync(join(home, '.env'))).toEqual(bytes);
  });
  it('rejects plugin environment expansion and unreadable manifest structure without leaking content', async () => {
    provision({ plugins: { enabled: ['${SECRET_PLUGIN_NAME}'] } });
    await expect(inspectHermesCompatibility(request(), exec)).rejects.toThrow(/interpolation|literal/i);
    provision({ plugins: { enabled: ['example'] } });
    const path = plugin(join(home, 'plugins'), 'example', { name: 'example' });
    writeFileSync(join(path, 'plugin.yaml'), 'name: [secret-sentinel');
    const error = await inspectHermesCompatibility(request(), exec).then(() => undefined, e => e);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('secret-sentinel');
  });
});
