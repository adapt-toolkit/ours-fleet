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

describe('Codex app-server permission proxy', () => {
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
    const proxy = join(dirname(fileURLToPath(import.meta.url)), '../dist/harness',
      'codex-app-server-proxy.js');
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
});
