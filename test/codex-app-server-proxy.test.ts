import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { rewriteCodexAppServerRequest } from '../src/harness/codex-app-server-proxy.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const request = (sandboxPolicy: Record<string, unknown>, approvalPolicy = 'on-request') => ({
  jsonrpc: '2.0', id: 7, method: 'turn/start',
  params: { threadId: 'T', approvalPolicy, sandboxPolicy },
});

const PROXY_EXIT_TIMEOUT_MS = 2_000;
const proxy = join(dirname(fileURLToPath(import.meta.url)), '../dist/harness',
  'codex-app-server-proxy.js');

async function runProxy(realCodexPath: string, pendingInput?: string): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  elapsedMs: number;
}> {
  const started = Date.now();
  const child = spawn(process.execPath, [proxy, 'app-server'], {
    env: {
      ...process.env,
      OURS_FLEET_CODEX_APPROVAL: 'never',
      OURS_FLEET_CODEX_SANDBOX: 'workspace-write',
      OURS_FLEET_REAL_CODEX_PATH: realCodexPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  if (pendingInput !== undefined) child.stdin.write(pendingInput);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.stdin.destroy();
      child.kill('SIGKILL');
      reject(new Error(`proxy did not exit within ${PROXY_EXIT_TIMEOUT_MS}ms`));
    }, PROXY_EXIT_TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr, elapsedMs: Date.now() - started });
    });
  });
}

describe('Codex app-server permission proxy', () => {
  it.each(['thread/start', 'thread/resume'])
  ('turns an authenticated explicit-empty marker into config.mcp_servers={} for %s', method => {
    const input = JSON.stringify({
      jsonrpc: '2.0', id: 3, method,
      params: { threadId: 'T', config: { model: 'gpt-5.6', feature: { enabled: true } } },
    });
    const output = JSON.parse(rewriteCodexAppServerRequest(
      input, 'never', 'workspace-write', true));
    expect(output.params.config).toEqual({
      model: 'gpt-5.6', feature: { enabled: true }, mcp_servers: {},
    });
  });

  it('does not infer explicit empty from an ordinary Codex session request', () => {
    const input = JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'thread/start',
      params: { config: { model: 'gpt-5.6' } },
    });
    expect(rewriteCodexAppServerRequest(input, 'never', 'workspace-write')).toBe(input);
  });

  it.each([
    ['untrusted', 'read-only', { type: 'readOnly', networkAccess: false }],
    ['never', 'workspace-write', { type: 'workspaceWrite', writableRoots: [] }],
    ['on-request', 'danger-full-access', { type: 'dangerFullAccess' }],
  ])('sets approval=%s while retaining sandbox=%s', (approval, sandbox, policy) => {
    const output = JSON.parse(rewriteCodexAppServerRequest(
      JSON.stringify(request(policy)), approval, sandbox));
    expect(output.params).toMatchObject({ approvalPolicy: approval, sandboxPolicy: policy });
  });

  it('does not rewrite another sandbox or a non-turn request', () => {
    const wrongSandbox = JSON.stringify(request({ type: 'dangerFullAccess' }, 'never'));
    expect(rewriteCodexAppServerRequest(wrongSandbox, 'never', 'workspace-write'))
      .toBe(wrongSandbox);
    const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(rewriteCodexAppServerRequest(initialize, 'never', 'workspace-write'))
      .toBe(initialize);
  });

  it('rewrites the real child-process stream used by CODEX_PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-codex-proxy-'));
    dirs.push(dir);
    const echo = join(dir, 'fake-codex');
    const echoAgent = join(dir, 'echo-app-server.mjs');
    writeFileSync(echoAgent,
      "import { createInterface } from 'node:readline';\n" +
      "createInterface({ input: process.stdin }).on('line', line => process.stdout.write(line + '\\n'));\n");
    writeFileSync(echo,
      `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' ` +
      `'${echoAgent.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    chmodSync(echo, 0o700);
    const child = spawn(process.execPath, [proxy, 'app-server'], {
      env: {
        ...process.env,
        OURS_FLEET_CODEX_APPROVAL: 'never',
        OURS_FLEET_CODEX_SANDBOX: 'workspace-write',
        OURS_FLEET_REAL_CODEX_PATH: echo,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    const received = new Promise<string>(resolve => lines.once('line', resolve));
    child.stdin.end(JSON.stringify(request({ type: 'workspaceWrite', writableRoots: [] })) + '\n');
    const output = JSON.parse(await received);
    expect(output.params).toMatchObject({
      approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' },
    });
    expect(output.params.sandboxPolicy.type).not.toBe('dangerFullAccess');
    await new Promise<void>((resolve, reject) => {
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`proxy exited ${code}`)));
      child.once('error', reject);
    });
  });

  it('exits promptly with a real child nonzero status after forwarding its error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-codex-proxy-crash-'));
    dirs.push(dir);
    const failingCodex = join(dir, 'failing-codex');
    writeFileSync(failingCodex,
      '#!/usr/bin/env node\n' +
      "process.stderr.write('fixture Codex child failed\\n', () => process.exit(23));\n",
      { mode: 0o700 });

    // Keep stdin open: the proxy must stop reading when its child exits.
    const result = await runProxy(failingCodex);

    expect(result).toMatchObject({ code: 23, signal: null });
    expect(result.stderr).toContain('fixture Codex child failed');
    expect(result.elapsedMs).toBeLessThan(PROXY_EXIT_TIMEOUT_MS);
  });

  it('exits after child death while a 512 KiB input line is backpressured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-codex-proxy-backpressure-'));
    dirs.push(dir);
    const failingCodex = join(dir, 'failing-codex');
    writeFileSync(failingCodex,
      '#!/usr/bin/env node\n' +
      "setTimeout(() => process.stderr.write('fixture Codex child failed under backpressure\\n', " +
      '() => process.exit(23)), 250);\n',
      { mode: 0o700 });

    // The child never reads stdin. One complete line larger than the pipe capacity
    // makes the proxy pause its readline input before the child exits.
    const result = await runProxy(failingCodex, 'x'.repeat(512 * 1024) + '\n');

    expect(result).toMatchObject({ code: 23, signal: null });
    expect(result.stderr).toContain('fixture Codex child failed under backpressure');
    expect(result.elapsedMs).toBeLessThan(PROXY_EXIT_TIMEOUT_MS);
  });

  it('exits promptly and reports ENOENT when the configured child is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-codex-proxy-missing-'));
    dirs.push(dir);
    const missingCodex = join(dir, 'missing-codex');

    // Keep stdin open: a spawn failure must also release the proxy input loop.
    const result = await runProxy(missingCodex);

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.stderr).toContain('ours-fleet Codex app-server proxy:');
    expect(result.stderr).toContain(missingCodex);
    expect(result.stderr).toContain('ENOENT');
    expect(result.elapsedMs).toBeLessThan(PROXY_EXIT_TIMEOUT_MS);
  });
});
