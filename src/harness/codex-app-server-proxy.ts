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
const DISABLE_INHERITED_MCP_ENV = 'OURS_FLEET_CODEX_DISABLE_INHERITED_MCP';

/**
 * Codex 0.145 can finish a tool-enabled turn without emitting the documented
 * `turn/completed` notification. Keep this short: the authoritative
 * `thread/read` reconciliation below, rather than elapsed time, is what makes
 * inference safe.
 */
const TERMINAL_RECONCILE_QUIET_MS = 2_000;
const MAX_LATE_TERMINAL_DEDUPLICATIONS = 1_024;

const APPROVAL_POLICIES = new Set(['untrusted', 'on-request', 'never']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;

interface RecoverableTurn {
  threadId: string;
  turnId: string;
  turn: JsonObject;
  openItems: Set<string>;
  openServerRequests: Set<JsonRpcId>;
  finalAssistantItem?: JsonObject;
  idleObserved: boolean;
  reconcileTimer?: ReturnType<typeof setTimeout>;
  reconcileRequestId?: JsonRpcId;
}

interface TerminalRecoveryOptions {
  sendToCodex(line: string): void;
  emitToClient(line: string): void;
  log(line: string): void;
  quietMs?: number;
}

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const jsonRpcId = (value: unknown): JsonRpcId | undefined =>
  typeof value === 'string' || typeof value === 'number' ? value : undefined;

const stringField = (value: unknown, field: string): string | undefined =>
  isObject(value) && typeof value[field] === 'string' ? value[field] as string : undefined;

const turnKey = (threadId: string, turnId: string): string => `${threadId}\0${turnId}`;

/**
 * Reconcile Codex's missing terminal notification without guessing from a
 * wall-clock timeout. A candidate needs the exact turn's authoritative final
 * assistant item, no live items or server requests, and a quiet period. The
 * proxy then asks app-server for the current thread snapshot. Only a terminal
 * stored turn, or an idle thread containing that exact turn, may synthesize the
 * missing notification.
 *
 * This lives in the authenticated bundled-Codex proxy, not the generic ACP
 * session: only here are App Server thread/turn IDs and item lifecycles visible.
 */
export class CodexTerminalRecovery {
  private readonly turns = new Map<string, RecoverableTurn>();
  private readonly pendingTurnStarts = new Map<JsonRpcId, string>();
  private readonly serverRequests = new Map<JsonRpcId, string>();
  private readonly reconcileRequests = new Map<JsonRpcId, string>();
  private readonly inferredTurns = new Set<string>();
  private reconcileSequence = 0;

  constructor(private readonly options: TerminalRecoveryOptions) {}

  observeClientLine(line: string): void {
    const message = this.parse(line);
    if (!message) return;
    const id = jsonRpcId(message.id);
    if (message.method === 'turn/start' && id !== undefined) {
      const threadId = stringField(message.params, 'threadId');
      if (threadId) this.pendingTurnStarts.set(id, threadId);
      return;
    }
    if (id === undefined || message.method !== undefined) return;
    const key = this.serverRequests.get(id);
    if (!key) return;
    this.serverRequests.delete(id);
    const turn = this.turns.get(key);
    turn?.openServerRequests.delete(id);
    if (turn) this.scheduleReconciliation(turn);
  }

  /** Return false when an internal response or late duplicate was consumed. */
  observeServerLine(line: string): boolean {
    const message = this.parse(line);
    if (!message) return true;
    const id = jsonRpcId(message.id);
    if (id !== undefined && message.method === undefined) {
      const reconcileKey = this.reconcileRequests.get(id);
      if (reconcileKey) {
        this.reconcileRequests.delete(id);
        this.handleReconcileResponse(reconcileKey, message);
        return false;
      }
      const threadId = this.pendingTurnStarts.get(id);
      if (threadId) {
        this.pendingTurnStarts.delete(id);
        const turn = isObject(message.result) && isObject(message.result.turn)
          ? message.result.turn : undefined;
        const turnId = stringField(turn, 'id');
        if (turn && turnId) this.ensureTurn(threadId, turnId, turn);
      }
      return true;
    }

    if (message.method === 'turn/started') {
      const threadId = stringField(message.params, 'threadId');
      const turn = isObject(message.params) && isObject(message.params.turn)
        ? message.params.turn : undefined;
      const turnId = stringField(turn, 'id');
      if (threadId && turn && turnId) this.ensureTurn(threadId, turnId, turn);
      return true;
    }

    if (message.method === 'turn/completed') {
      const threadId = stringField(message.params, 'threadId');
      const turn = isObject(message.params) && isObject(message.params.turn)
        ? message.params.turn : undefined;
      const turnId = stringField(turn, 'id');
      if (!threadId || !turnId) return true;
      const key = turnKey(threadId, turnId);
      if (this.inferredTurns.delete(key)) {
        this.options.log(
          `suppressed late turn/completed after inferred terminal (${threadId}/${turnId})`);
        return false;
      }
      this.finishTurn(key);
      return true;
    }

    if (message.method === 'thread/status/changed') {
      const threadId = stringField(message.params, 'threadId');
      const status = isObject(message.params) && isObject(message.params.status)
        ? message.params.status : undefined;
      if (threadId && status?.type === 'idle') {
        for (const turn of this.turns.values()) {
          if (turn.threadId !== threadId) continue;
          turn.idleObserved = true;
          this.scheduleReconciliation(turn);
        }
      }
      return true;
    }

    const params = isObject(message.params) ? message.params : undefined;
    const threadId = stringField(params, 'threadId');
    const routedTurnId = stringField(params, 'turnId');
    const routed = threadId && routedTurnId
      ? this.turns.get(turnKey(threadId, routedTurnId)) : undefined;

    if (routed && message.method === 'item/started') {
      const item = isObject(params?.item) ? params.item : undefined;
      const itemId = stringField(item, 'id');
      if (itemId) routed.openItems.add(itemId);
      // Work after a final answer invalidates that candidate. A later exact
      // final answer can establish a new one.
      if (item?.type !== 'agentMessage' || item?.phase !== 'final_answer')
        routed.finalAssistantItem = undefined;
      this.cancelReconciliation(routed);
    } else if (routed && message.method === 'item/completed') {
      const item = isObject(params?.item) ? params.item : undefined;
      const itemId = stringField(item, 'id');
      if (itemId) routed.openItems.delete(itemId);
      if (item?.type === 'agentMessage' && item.phase === 'final_answer'
          && typeof item.text === 'string' && item.text.length > 0)
        routed.finalAssistantItem = item;
      this.scheduleReconciliation(routed);
    }

    // App-server requests (approvals, elicitation, user input) are obligations
    // the client still owes. Never infer while one for this turn is unresolved.
    if (routed && id !== undefined && typeof message.method === 'string') {
      this.serverRequests.set(id, turnKey(routed.threadId, routed.turnId));
      routed.openServerRequests.add(id);
      this.cancelReconciliation(routed);
    }
    return true;
  }

  close(): void {
    for (const turn of this.turns.values()) this.cancelReconciliation(turn);
    this.turns.clear();
    this.pendingTurnStarts.clear();
    this.serverRequests.clear();
    this.reconcileRequests.clear();
    this.inferredTurns.clear();
  }

  private parse(line: string): JsonObject | undefined {
    try {
      const parsed: unknown = JSON.parse(line);
      return isObject(parsed) ? parsed : undefined;
    } catch { return undefined; }
  }

  private ensureTurn(threadId: string, turnId: string, turn: JsonObject): RecoverableTurn {
    const key = turnKey(threadId, turnId);
    const existing = this.turns.get(key);
    if (existing) {
      existing.turn = turn;
      return existing;
    }
    const created: RecoverableTurn = {
      threadId, turnId, turn, openItems: new Set(), openServerRequests: new Set(),
      idleObserved: false,
    };
    this.turns.set(key, created);
    return created;
  }

  private candidate(turn: RecoverableTurn): boolean {
    return turn.finalAssistantItem !== undefined
      && turn.openItems.size === 0 && turn.openServerRequests.size === 0
      && turn.reconcileRequestId === undefined;
  }

  private cancelReconciliation(turn: RecoverableTurn): void {
    if (turn.reconcileTimer) clearTimeout(turn.reconcileTimer);
    turn.reconcileTimer = undefined;
  }

  private scheduleReconciliation(turn: RecoverableTurn): void {
    this.cancelReconciliation(turn);
    if (!this.candidate(turn)) return;
    turn.reconcileTimer = setTimeout(
      () => this.reconcile(turn), this.options.quietMs ?? TERMINAL_RECONCILE_QUIET_MS);
    turn.reconcileTimer.unref?.();
  }

  private reconcile(turn: RecoverableTurn): void {
    turn.reconcileTimer = undefined;
    if (!this.candidate(turn)) return;
    const id = `ours-fleet-terminal-reconcile-${++this.reconcileSequence}`;
    const key = turnKey(turn.threadId, turn.turnId);
    turn.reconcileRequestId = id;
    this.reconcileRequests.set(id, key);
    this.options.sendToCodex(JSON.stringify({
      id, method: 'thread/read', params: { threadId: turn.threadId, includeTurns: true },
    }));
  }

  private handleReconcileResponse(key: string, message: JsonObject): void {
    const tracked = this.turns.get(key);
    if (!tracked) return;
    tracked.reconcileRequestId = undefined;
    if (!this.candidate(tracked)) return;
    const thread = isObject(message.result) && isObject(message.result.thread)
      ? message.result.thread : undefined;
    const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
    const snapshot = turns.find(candidate =>
      isObject(candidate) && candidate.id === tracked.turnId) as JsonObject | undefined;
    if (!snapshot) {
      this.scheduleReconciliation(tracked);
      return;
    }
    const status = typeof snapshot.status === 'string' ? snapshot.status : undefined;
    const threadStatus = thread && isObject(thread.status) ? thread.status.type : undefined;
    const storedTerminal = status === 'completed' || status === 'failed' || status === 'interrupted';
    if (!storedTerminal && threadStatus !== 'idle' && !tracked.idleObserved) {
      // A final answer can precede stop hooks or other short-lived runtime
      // effects. Keep reconciling while the exact thread still reports active;
      // never convert elapsed time alone into success.
      this.scheduleReconciliation(tracked);
      return;
    }

    const inferredTurn: JsonObject = storedTerminal ? snapshot : {
      ...snapshot,
      status: 'completed',
      error: null,
      completedAt: snapshot.completedAt ?? new Date().toISOString(),
    };
    this.inferredTurns.add(key);
    if (this.inferredTurns.size > MAX_LATE_TERMINAL_DEDUPLICATIONS) {
      const oldest = this.inferredTurns.values().next().value as string | undefined;
      if (oldest) this.inferredTurns.delete(oldest);
    }
    this.options.log(
      `inferred missing turn/completed after authoritative reconciliation (${tracked.threadId}/${tracked.turnId})`);
    this.options.emitToClient(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: tracked.threadId, turn: inferredTurn },
      _meta: { oursFleet: { terminalSource: 'inferred_missing_notification' } },
    }));
    this.finishTurn(key);
  }

  private finishTurn(key: string): void {
    const turn = this.turns.get(key);
    if (!turn) return;
    this.cancelReconciliation(turn);
    if (turn.reconcileRequestId !== undefined) {
      this.reconcileRequests.delete(turn.reconcileRequestId);
      turn.reconcileRequestId = undefined;
    }
    for (const id of turn.openServerRequests) this.serverRequests.delete(id);
    this.turns.delete(key);
  }
}

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
  value: unknown, approval: string, expectedSandbox: string, disableInheritedMcp: boolean,
): unknown {
  if (Array.isArray(value))
    return value.map(candidate =>
      rewriteMessage(candidate, approval, expectedSandbox, disableInheritedMcp));
  if (!isObject(value) || !isObject(value.params)) return value;
  if (value.method === 'turn/start') {
    if (sandboxMode(value.params.sandboxPolicy) !== expectedSandbox) return value;
    return { ...value, params: { ...value.params, approvalPolicy: approval } };
  }
  if (disableInheritedMcp
      && (value.method === 'thread/start' || value.method === 'thread/resume')) {
    const config = isObject(value.params.config) ? value.params.config : {};
    return {
      ...value,
      params: { ...value.params, config: { ...config, mcp_servers: {} } },
    };
  }
  return value;
}

/** Transform one app-server NDJSON request; malformed input passes through. */
export function rewriteCodexAppServerRequest(
  line: string, approval: string, expectedSandbox: string, disableInheritedMcp = false,
): string {
  try {
    return JSON.stringify(
      rewriteMessage(JSON.parse(line), approval, expectedSandbox, disableInheritedMcp));
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
  const disableInheritedMcp = process.env[DISABLE_INHERITED_MCP_ENV] === '1';
  const launch = realCodexLaunch();
  const env = { ...process.env };
  delete env.CODEX_PATH;
  delete env[APPROVAL_ENV];
  delete env[SANDBOX_ENV];
  delete env[REAL_CODEX_ENV];
  delete env[ACP_MANIFEST_ENV];
  delete env[DISABLE_INHERITED_MCP_ENV];

  const child = spawn(launch.command, launch.args, {
    env, shell: launch.shell, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.pipe(process.stderr, { end: false });
  const input = createInterface({ input: process.stdin });
  const output = createInterface({ input: child.stdout });
  let finished = false;
  let clientBackpressured = false;
  const writeToClient = (line: string) => {
    if (finished) return;
    if (!process.stdout.write(line + '\n')) {
      if (!clientBackpressured) {
        clientBackpressured = true;
        output.pause();
        process.stdout.once('drain', () => {
          clientBackpressured = false;
          if (!finished) output.resume();
        });
      }
    }
  };
  let childBackpressured = false;
  const pendingChildLines: string[] = [];
  const writeToChild = (line: string) => {
    if (finished || child.stdin.destroyed) return;
    if (childBackpressured) {
      pendingChildLines.push(line);
      return;
    }
    if (!child.stdin.write(line + '\n')) {
      childBackpressured = true;
      input.pause();
      child.stdin.once('drain', () => {
        childBackpressured = false;
        while (!childBackpressured && pendingChildLines.length > 0) {
          const pending = pendingChildLines.shift()!;
          if (!child.stdin.write(pending + '\n')) childBackpressured = true;
        }
        if (!finished && !childBackpressured) input.resume();
      });
    }
  };
  const recovery = new CodexTerminalRecovery({
    sendToCodex: writeToChild,
    emitToClient: writeToClient,
    log: line => process.stderr.write(`ours-fleet Codex terminal recovery: ${line}\n`),
  });
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    recovery.close();
    input.close();
    process.stdin.destroy();
    // stdout/stderr are often pipes under Fleet and tests. Setting exitCode
    // before their pending writes flush can drop the child's last diagnostic
    // or protocol line. Empty writes provide ordered flush barriers.
    // Let readable `data`/`line` callbacks queued with the child's `close`
    // notification run before placing the barriers.
    setImmediate(() => {
      process.stdout.write('', () => {
        process.stderr.write('', () => { process.exitCode = code; });
      });
    });
  };
  let spawnFailed = false;
  child.once('error', error => {
    spawnFailed = true;
    process.stderr.write(`ours-fleet Codex app-server proxy: ${error.message}\n`);
  });
  // `exit` can precede the final stdout/stderr chunks. Wait for `close`, which
  // is emitted only after the child's stdio streams have closed, so a fast
  // failure cannot lose its diagnostic or the last protocol envelope.
  child.once('close', (code, signal) => {
    finish(spawnFailed ? 1 : code ?? (signal ? 1 : 0));
  });

  // A child can close its input before Node delivers its exit event. Its exit
  // status is the authoritative failure; do not let the resulting EPIPE race it.
  child.stdin.on('error', () => {});
  input.on('line', line => {
    if (finished) return;
    const rewritten = rewriteCodexAppServerRequest(
      line, approval, expectedSandbox, disableInheritedMcp);
    recovery.observeClientLine(rewritten);
    writeToChild(rewritten);
  });
  output.on('line', line => {
    if (!finished && recovery.observeServerLine(line)) writeToClient(line);
  });
  input.once('close', () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });
  process.stdin.once('end', () => {
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
