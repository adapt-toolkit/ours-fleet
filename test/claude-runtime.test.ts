import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledClaudeVersion, hostClaude } from '../src/harness/claude-runtime.js';
import { resolveBundledAcpAgent } from '../src/harness/acp-agent.js';
import { makeClaudeCodeAdapter } from '../src/harness/claude-code.js';
import type { ResolvedRole } from '../src/config.js';

const roots: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'fleet-claude-runtime-')); roots.push(dir); return dir; };
beforeEach(() => {
  vi.stubEnv('CLAUDE_CODE_EXECUTABLE', undefined);
  vi.stubEnv('OURS_FLEET_HOME', temp()); vi.stubEnv('HOME', temp());
});
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const manifest = () => resolveBundledAcpAgent('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp', 'claude-agent-acp').manifestPath;
const role = (env?: Record<string, string>, over: Partial<ResolvedRole> = {}): ResolvedRole => ({
  name: 'Runtime', identity: 'Runtime', harness: 'claude-code', session: 'acp', sourceFile: 'fixture', ...(env ? { env } : {}), ...over,
});

/** A PATH holding only a `claude` that answers `--version` with `output`. */
function hostPath(output: string): string {
  const dir = temp();
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${output}\n`);
  chmodSync(join(dir, 'claude'), 0o700);
  return dir;
}
const reports = (version: string) => `printf '${version} (Claude Code)\\n'`;
const prepared = async (path: string, given = role()) => {
  vi.stubEnv('PATH', `${path}:${process.env.PATH}`);
  const state = temp();
  return (await makeClaudeCodeAdapter().prepareSession(given, { stateDir: state, runCwd: state })).env;
};

describe('host Claude Code selection', () => {
  it('knows the Claude Code version shipped with the adapter', () => {
    expect(bundledClaudeVersion(manifest()!)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bundledClaudeVersion(join(temp(), 'package.json'))).toBeUndefined();
  });
  it('runs a host Claude Code that is at least as new as the bundled one', async () => {
    const dir = hostPath(reports('99.0.0'));
    expect(hostClaude(manifest(), { PATH: dir })).toEqual({ path: join(dir, 'claude'), version: '99.0.0' });
    const same = hostPath(reports(bundledClaudeVersion(manifest()!)!));
    expect(hostClaude(manifest(), { PATH: same })?.path).toBe(join(same, 'claude'));
    expect((await prepared(dir)).CLAUDE_CODE_EXECUTABLE).toBe(join(dir, 'claude'));
  });
  it('reports missing, old and unreadable host CLI without silently selecting another', async () => {
    expect(() => hostClaude(manifest(), { PATH: hostPath(reports('0.1.0')) })).toThrow(/qualified/);
    expect(() => hostClaude(manifest(), { PATH: temp() })).toThrow(/missing from PATH/);
    expect(() => hostClaude(manifest(), { PATH: hostPath('exit 3') })).toThrow(/unreadable/);
    expect(hostClaude(undefined, { PATH: hostPath(reports('99.0.0')) })).toBeUndefined();
    await expect(prepared(hostPath(reports('0.1.0')))).rejects.toThrow(/No bundled fallback/);
  });
  it('lets an explicit CLAUDE_CODE_EXECUTABLE decide, in the role or the service environment', async () => {
    const dir = hostPath(reports('99.0.0'));
    expect(hostClaude(manifest(), { PATH: dir, CLAUDE_CODE_EXECUTABLE: '/chosen/claude' })).toBeUndefined();
    expect(hostClaude(manifest(), { PATH: dir, CLAUDE_CODE_EXECUTABLE: '' })).toBeUndefined();
    expect((await prepared(dir, role({ CLAUDE_CODE_EXECUTABLE: '/chosen/claude' }))).CLAUDE_CODE_EXECUTABLE).toBeUndefined();
    vi.stubEnv('CLAUDE_CODE_EXECUTABLE', '/service/claude');
    expect((await prepared(dir)).CLAUDE_CODE_EXECUTABLE).toBeUndefined();
  });
  it('leaves a custom ACP command to choose its own Claude Code', async () => {
    const custom = role(undefined, { session_options: { acp: { command: ['custom-claude-acp'] } } });
    expect((await prepared(hostPath(reports('99.0.0')), custom)).CLAUDE_CODE_EXECUTABLE).toBeUndefined();
  });
});
it('supports a PATH directory containing spaces and refuses non-executable or hung --version', () => {
 const dir=join(temp(),'CLI with spaces'); mkdirSync(dir);
 const path=join(dir,'claude');writeFileSync(path,`#!/bin/sh\nprintf '99.0.0\\n'\n`);chmodSync(path,0o700);
 expect(hostClaude(manifest(),{PATH:dir})?.path).toBe(path);
 chmodSync(path,0o600);expect(()=>hostClaude(manifest(),{PATH:dir})).toThrow(/missing from PATH/);
 chmodSync(path,0o700);writeFileSync(path,'#!/bin/sh\n/bin/sleep 20\n');
 expect(()=>hostClaude(manifest(),{PATH:dir})).toThrow(/unreadable/);
},10000);
