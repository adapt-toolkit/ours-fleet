#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const APPROVAL_ENV = 'OURS_FLEET_CODEX_APPROVAL';
const SANDBOX_ENV = 'OURS_FLEET_CODEX_SANDBOX';
const REAL_CODEX_ENV = 'OURS_FLEET_REAL_CODEX_PATH';
const ACP_MANIFEST_ENV = 'OURS_FLEET_CODEX_ACP_MANIFEST';

const APPROVAL_POLICIES = new Set(['untrusted', 'on-request', 'never']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function sandboxMode(policy: unknown): string | undefined {
  if (!isObject(policy)) return undefined;
  if (policy.type === 'readOnly') return 'read-only';
  if (policy.type === 'workspaceWrite') return 'workspace-write';
  if (policy.type === 'dangerFullAccess') return 'danger-full-access';
  return undefined;
}

/**
 * codex-acp 1.1.x couples approval and sandboxing in three ACP mode presets.
 * Fleet keeps the preset's sandbox policy, but restores the independently
 * configured approval policy on the request Codex actually executes.
 */
function rewriteMessage(
  value: unknown, approval: string, expectedSandbox: string,
): unknown {
  if (Array.isArray(value))
    return value.map(candidate => rewriteMessage(candidate, approval, expectedSandbox));
  if (!isObject(value) || value.method !== 'turn/start' || !isObject(value.params)) return value;
  if (sandboxMode(value.params.sandboxPolicy) !== expectedSandbox) return value;
  return { ...value, params: { ...value.params, approvalPolicy: approval } };
}

/** Transform one app-server NDJSON request; malformed input passes through. */
export function rewriteCodexAppServerRequest(
  line: string, approval: string, expectedSandbox: string,
): string {
  try {
    return JSON.stringify(rewriteMessage(JSON.parse(line), approval, expectedSandbox));
  } catch {
    return line;
  }
}

function requiredChoice(name: string, allowed: Set<string>): string {
  const value = process.env[name];
  if (value && allowed.has(value)) return value;
  throw new Error(`${name} must be one of: ${[...allowed].join(', ')}`);
}

function realCodexLaunch(): { command: string; args: string[]; shell?: boolean } {
  const configured = process.env[REAL_CODEX_ENV];
  if (configured) return {
    command: configured,
    args: ['app-server'],
    ...(process.platform === 'win32' ? { shell: true } : {}),
  };
  const manifest = process.env[ACP_MANIFEST_ENV];
  if (!manifest)
    throw new Error(`${ACP_MANIFEST_ENV} is required when ${REAL_CODEX_ENV} is unset`);
  const entry = createRequire(manifest).resolve('@openai/codex/bin/codex.js');
  return { command: process.execPath, args: [entry, 'app-server'] };
}

export function runCodexAppServerProxy(): void {
  if (process.argv[2] !== 'app-server')
    throw new Error('the fleet Codex proxy may only be launched as CODEX_PATH app-server');
  const approval = requiredChoice(APPROVAL_ENV, APPROVAL_POLICIES);
  const expectedSandbox = requiredChoice(SANDBOX_ENV, SANDBOX_MODES);
  const launch = realCodexLaunch();
  const env = { ...process.env };
  delete env.CODEX_PATH;
  delete env[APPROVAL_ENV];
  delete env[SANDBOX_ENV];
  delete env[REAL_CODEX_ENV];
  delete env[ACP_MANIFEST_ENV];

  const child = spawn(launch.command, launch.args, {
    env, shell: launch.shell, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const input = createInterface({ input: process.stdin });
  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    process.exitCode = code;
    input.close();
  };
  child.once('error', error => {
    process.stderr.write(`ours-fleet Codex app-server proxy: ${error.message}\n`);
    finish(1);
  });
  child.once('exit', (code, signal) => {
    finish(code ?? (signal ? 1 : 0));
  });

  // A child can close its input before Node delivers its exit event. Its exit
  // status is the authoritative failure; do not let the resulting EPIPE race it.
  child.stdin.on('error', () => {});
  input.on('line', line => {
    if (finished) return;
    const output = rewriteCodexAppServerRequest(line, approval, expectedSandbox) + '\n';
    if (!child.stdin.write(output)) {
      input.pause();
      child.stdin.once('drain', () => {
        if (!finished) input.resume();
      });
    }
  });
  input.once('close', () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => child.kill(signal));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { runCodexAppServerProxy(); }
  catch (error) {
    process.stderr.write(`ours-fleet Codex app-server proxy: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
