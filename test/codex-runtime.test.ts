import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, readlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCodexRuntime, codexVersionAtLeast } from '../src/harness/codex-runtime.js';
import { resolveBundledAcpAgent } from '../src/harness/acp-agent.js';
import { makeCodexAdapter, codexAcpLaunchForResolution } from '../src/harness/codex.js';
import { harnessChildEnv } from '../src/runner.js';
import type { ResolvedRole } from '../src/config.js';

const roots: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'fleet-codex-runtime-')); roots.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const adapter = () => resolveBundledAcpAgent('@agentclientprotocol/codex-acp', 'codex-acp', 'codex-acp');
function binary(version: string): string {
  const path = join(temp(), 'codex');
  writeFileSync(path, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`);
  chmodSync(path, 0o700);
  return path;
}
const role = (env: Record<string, string> = {}): ResolvedRole => ({
  name: 'Runtime', identity: 'Runtime', harness: 'codex', session: 'acp', sourceFile: 'fixture', env,
});

describe('Codex runtime provenance', () => {
  it('resolves the adapter dependency rather than shell Codex', async () => {
    const runtime = await probeCodexRuntime(adapter(), { ...process.env, CODEX_PATH: '' });
    expect(runtime.source).toBe('bundled');
    expect(runtime.executable).toMatch(/vendor\/.*\/bin\/codex$/);
    expect(codexVersionAtLeast(runtime.version, '0.153.3')).toBe(true);
    expect(adapter().version).toBe('1.10.0');
  });
  it('honors explicit CODEX_PATH and reports its executable version', async () => {
    const path = binary('0.145.0');
    expect(await probeCodexRuntime(adapter(), { CODEX_PATH: path })).toEqual({
      source: 'CODEX_PATH', entry: path, executable: path, version: '0.145.0',
    });
  });
  it('reports an invalid override instead of falling back', async () => {
    await expect(probeCodexRuntime(adapter(), { CODEX_PATH: '/nonexistent/codex' })).rejects.toThrow();
  });
  it('does not invent provenance for a PATH adapter', async () => {
    await expect(probeCodexRuntime({ argv: ['codex-acp'], bundled: false }, {}))
      .rejects.toThrow('runtime is unknown');
  });
  it.each(['1.1.7', '1.10.0'])('retains metadata provenance for verified adapter %s', version => {
    expect(codexAcpLaunchForResolution({ argv: ['node', '/adapter'], bundled: true,
      manifestPath: '/package.json', version }).permissionMetadataSource).toBe('codex-acp');
  });
  it.each(['1.1.8', '1.10.1', '2.0.0'])('does not trust unverified adapter %s', version => {
    expect(codexAcpLaunchForResolution({ argv: ['node', '/adapter'], bundled: true,
      manifestPath: '/package.json', version }).permissionMetadataSource).toBeUndefined();
  });
  it('refuses gpt-6-astra with an old override before launching ACP', async () => {
    const dir = temp();
    await expect(makeCodexAdapter().prepareSession({ ...role({ CODEX_PATH: binary('0.145.0') }),
      model: 'gpt-6-astra' }, { stateDir: dir, runCwd: dir })).rejects.toThrow('requires a newer Codex');
  });
  it('inherits the service override, with role override and explicit-empty taking precedence', async () => {
    const inherited = binary('0.153.4');
    vi.stubEnv('CODEX_PATH', inherited);
    const selected = binary('0.153.4');
    for (const [env, expected] of [[{}, inherited], [{ CODEX_PATH: selected }, selected], [{ CODEX_PATH: '' }, '']] as const) {
      const dir = temp();
      const r = role(env);
      const prep = await makeCodexAdapter().prepareSession(r, { stateDir: dir, runCwd: dir });
      const child = harnessChildEnv(r, prep.env, dir);
      expect(child.OURS_FLEET_REAL_CODEX_PATH).toBe(expected);
      expect(child.CODEX_PATH).toBe(prep.env.CODEX_PATH);
    }
  });
  it.each(['persistent', 'temporary'])('keeps role override behind proxy for %s state', async lifetime => {
    const dir = join(temp(), lifetime);
    const path = binary('0.153.4');
    const r = role({ CODEX_PATH: path });
    const prep = await makeCodexAdapter().prepareSession(r, { stateDir: dir, runCwd: dir });
    const launch = makeCodexAdapter().agentSession.prepareLaunch(r, prep);
    const env = harnessChildEnv(r, launch.env, dir);
    expect(env.CODEX_PATH).toBe(prep.env.CODEX_PATH);
    expect(env.CODEX_PATH).not.toBe(path);
    expect(env.OURS_FLEET_REAL_CODEX_PATH).toBe(path);
  });
});


// Real ACP -> Fleet proxy -> npm wrapper -> native binary, without a model turn.
// Isolated CODEX_HOME avoids loading the host's credentials, plugins or sessions.
describe.skipIf(process.platform !== 'linux')('actual ACP runtime process chain', () => {
  it.each(['persistent', 'temporary'])('initializes %s launch using the reported binary', async lifetime => {
    const root = temp();
    const r = role({ CODEX_HOME: root, CODEX_PATH: '' });
    const prep = await makeCodexAdapter().prepareSession(r, { stateDir: join(root, lifetime), runCwd: root });
    const launch = makeCodexAdapter().agentSession.prepareLaunch(r, prep);
    const env = { ...process.env, ...harnessChildEnv(r, launch.env, root) };
    const expected = await probeCodexRuntime(adapter(), { ...process.env, CODEX_PATH: '' });
    const child = spawn(launch.argv[0], launch.argv.slice(1), { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    try {
      const response = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ACP initialization timeout')), 5000);
        child.once('error', reject);
        lines.on('line', line => {
          const message = JSON.parse(line);
          if (message.id === 1) { clearTimeout(timer); resolve(message); }
        });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'fleet-runtime-test', version: '1' } } }) + '\n');
      expect((await response).error).toBeUndefined();
      const descendants = (pid: number): string[] => {
        const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
        return children ? children.split(/\s+/).flatMap(value => {
          const id = Number(value);
          return [readlinkSync(`/proc/${id}/exe`), ...descendants(id)];
        }) : [];
      };
      expect(descendants(child.pid!)).toContain(expected.executable);
    } finally {
      lines.close();
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
      await closed;
      clearTimeout(timer);
    }
  }, 12000);
});
