import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CodexTerminalRecovery, rewriteCodexAppServerRequest,
} from '../src/harness/codex-app-server-proxy.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const request = (sandboxPolicy: Record<string, unknown>, approvalPolicy = 'on-request') => ({
  jsonrpc: '2.0', id: 7, method: 'turn/start',
  params: { threadId: 'T', approvalPolicy, sandboxPolicy },
});

const PROXY_EXIT_TIMEOUT_MS = 2_000;
const proxy = join(dirname(fileURLToPath(import.meta.url)), '../dist/harness',
  'codex-app-server-proxy.js');

const notification = (method: string, params: Record<string, unknown>): string =>
  JSON.stringify({ method, params });

function terminalRecovery(quietMs = 25) {
  const sent: string[] = [];
  const emitted: string[] = [];
  const logs: string[] = [];
  const recovery = new CodexTerminalRecovery({
    quietMs,
    sendToCodex: line => sent.push(line),
    emitToClient: line => emitted.push(line),
    log: line => logs.push(line),
  });
  return { recovery, sent, emitted, logs };
}

function startTurn(recovery: CodexTerminalRecovery, threadId = 'thread-1', turnId = 'turn-1') {
  recovery.observeServerLine(notification('turn/started', {
    threadId,
    turn: { id: turnId, status: 'inProgress', items: [] },
  }));
}

function itemEvent(
  recovery: CodexTerminalRecovery, method: 'item/started' | 'item/completed',
  item: Record<string, unknown>, threadId = 'thread-1', turnId = 'turn-1',
) {
  recovery.observeServerLine(notification(method, { threadId, turnId, item }));
}

function answerReconciliation(
  recovery: CodexTerminalRecovery, requestLine: string,
  { threadStatus = 'idle', turnStatus = 'inProgress' } = {},
): boolean {
  const request = JSON.parse(requestLine);
  return recovery.observeServerLine(JSON.stringify({
    id: request.id,
    result: {
      thread: {
        id: 'thread-1', status: { type: threadStatus },
        turns: [{ id: 'turn-1', status: turnStatus, items: [], error: null }],
      },
    },
  }));
}

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
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`proxy exited ${code}`)));
      child.once('error', reject);
    });
    child.stdin.end(JSON.stringify(request({ type: 'workspaceWrite', writableRoots: [] })) + '\n');
    const output = JSON.parse(await received);
    expect(output.params).toMatchObject({
      approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' },
    });
    expect(output.params.sandboxPolicy.type).not.toBe('dangerFullAccess');
    await exited;
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

describe('Codex app-server missing terminal recovery', () => {
  it('infers the exact missing completion after final output, no live work, and idle reconciliation', () => {
    vi.useFakeTimers();
    const { recovery, sent, emitted, logs } = terminalRecovery();
    startTurn(recovery);
    itemEvent(recovery, 'item/started', {
      id: 'tool-1', type: 'commandExecution', status: 'inProgress',
    });
    itemEvent(recovery, 'item/completed', {
      id: 'tool-1', type: 'commandExecution', status: 'completed',
    });
    itemEvent(recovery, 'item/completed', {
      id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: 'Done.',
    });

    vi.advanceTimersByTime(25);

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({
      method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true },
    });
    expect(answerReconciliation(recovery, sent[0])).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0])).toMatchObject({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
      _meta: { oursFleet: { terminalSource: 'inferred_missing_notification' } },
    });
    expect(logs.join('\n')).toContain('inferred missing turn/completed');
  });

  it('does not reconcile while an item or server request remains open', () => {
    vi.useFakeTimers();
    const { recovery, sent } = terminalRecovery();
    startTurn(recovery);
    itemEvent(recovery, 'item/started', {
      id: 'tool-1', type: 'commandExecution', status: 'inProgress',
    });
    itemEvent(recovery, 'item/completed', {
      id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: 'Done.',
    });
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([]);

    itemEvent(recovery, 'item/completed', {
      id: 'tool-1', type: 'commandExecution', status: 'completed',
    });
    recovery.observeServerLine(JSON.stringify({
      id: 91, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }));
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([]);

    recovery.observeClientLine(JSON.stringify({ id: 91, result: { decision: 'accept' } }));
    vi.advanceTimersByTime(25);
    expect(sent).toHaveLength(1);
  });

  it('does not infer from commentary, an empty final item, or an active thread snapshot', () => {
    vi.useFakeTimers();
    const { recovery, sent, emitted } = terminalRecovery();
    startTurn(recovery);
    itemEvent(recovery, 'item/completed', {
      id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: 'Working.',
    });
    itemEvent(recovery, 'item/completed', {
      id: 'answer-empty', type: 'agentMessage', phase: 'final_answer', text: '',
    });
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([]);

    itemEvent(recovery, 'item/completed', {
      id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: 'Done.',
    });
    vi.advanceTimersByTime(25);
    expect(answerReconciliation(recovery, sent[0], { threadStatus: 'active' })).toBe(false);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(25);
    expect(sent).toHaveLength(2);
  });

  it('prefers the real terminal event and cancels pending inference', () => {
    vi.useFakeTimers();
    const { recovery, sent, emitted } = terminalRecovery();
    startTurn(recovery);
    itemEvent(recovery, 'item/completed', {
      id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: 'Done.',
    });
    expect(recovery.observeServerLine(notification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    }))).toBe(true);

    vi.advanceTimersByTime(100);
    expect(sent).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('suppresses a late real terminal event after an inferred completion', () => {
    vi.useFakeTimers();
    const { recovery, sent, emitted, logs } = terminalRecovery();
    startTurn(recovery);
    itemEvent(recovery, 'item/completed', {
      id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: 'Done.',
    });
    vi.advanceTimersByTime(25);
    answerReconciliation(recovery, sent[0]);
    expect(emitted).toHaveLength(1);

    expect(recovery.observeServerLine(notification('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    }))).toBe(false);
    expect(logs.join('\n')).toContain('suppressed late turn/completed');
  });
});
