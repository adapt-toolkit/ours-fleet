import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import { SessionControlError, classifyChildExit } from './types.js';
import type { ExitRecord } from './types.js';

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

export interface CodexAppServerTransportOptions {
  name: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  log(line: string): void;
  requestTimeoutMs?: number;
  onNotification?(method: string, params: JsonObject): void;
  onRequest?(method: string, id: RequestId, params: JsonObject): void;
  onExit?(exit: ExitRecord): void;
}

export interface CodexAppServerConnection {
  readonly pid: number;
  readonly child: Pick<ChildProcessWithoutNullStreams, 'kill'>;
  isAlive(): boolean;
  exitResult(): ExitRecord | null;
  request<T = unknown>(method: string, params?: JsonObject, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: JsonObject): void;
  respond(id: RequestId, result: unknown): void;
  respondError(id: RequestId, code: number, message: string): void;
  close(): Promise<void>;
}

export type CodexAppServerTransportFactory =
  (options: CodexAppServerTransportOptions) => Promise<CodexAppServerConnection>;

interface PendingRequest {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function responseError(value: unknown): Error {
  if (!isObject(value)) return new Error('Codex app-server returned an unknown error');
  const message = typeof value.message === 'string' ? value.message : JSON.stringify(value);
  const error = new Error(message);
  error.name = 'CodexAppServerError';
  return error;
}

/** Minimal, version-tolerant JSONL client for Codex app-server's stdio transport. */
export class CodexAppServerTransport implements CodexAppServerConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;
  private closed = false;
  private exit: ExitRecord | null = null;

  private constructor(
    private readonly options: CodexAppServerTransportOptions,
    child: ChildProcessWithoutNullStreams,
  ) {
    this.child = child;
    this.pid = child.pid ?? -1;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
    child.stderr.on('data', chunk => {
      const text = String(chunk).trimEnd();
      if (text) options.log(`[${options.name}] codex app-server: ${text}`);
    });
    child.once('error', error => {
      this.options.log(`[${options.name}] codex app-server process error: ${error.message}`);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => this.receive(line));
    child.once('exit', (code, signal) => {
      this.exit = classifyChildExit(code, signal);
      const error = new SessionControlError(
        'offline', `Codex app-server ${this.exit.detail}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      options.onExit?.(this.exit);
      this.resolveExited();
    });
  }

  static async start(options: CodexAppServerTransportOptions): Promise<CodexAppServerTransport> {
    if (!options.argv.length) throw new Error('Codex app-server command is empty');
    const child = spawn(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // `pid` is assigned synchronously on a successful local spawn. Checking it
    // first avoids missing an exceptionally fast `spawn` event before the
    // listeners below are attached (observable with tiny test/app-server shims).
    if (child.pid === undefined) await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        child.off('spawn', spawned);
        child.off('error', failed);
        error ? reject(error) : resolve();
      };
      const spawned = () => finish();
      const failed = (error: Error) => finish(error);
      child.once('spawn', spawned);
      child.once('error', failed);
      setImmediate(() => { if (child.pid !== undefined) finish(); });
    });
    return new CodexAppServerTransport(options, child);
  }

  isAlive(): boolean {
    return this.child.exitCode === null && (this.child.signalCode ?? null) === null;
  }

  exitResult(): ExitRecord | null { return this.exit; }

  request<T = unknown>(method: string, params: JsonObject = {}, timeoutMs?: number): Promise<T> {
    if (this.closed || !this.isAlive())
      return Promise.reject(new SessionControlError('offline', 'Codex app-server is offline'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SessionControlError(
          'timeout', `Codex app-server ${method} timed out after ${timeoutMs ?? this.requestTimeoutMs}ms`));
      }, timeoutMs ?? this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method, timer,
        resolve: value => resolve(value as T), reject,
      });
      try { this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params?: JsonObject): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: RequestId, result: unknown): void { this.write({ id, result }); }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.isAlive()) return;
    this.child.kill('SIGTERM');
    if (await this.waitForExit(2_500)) return;
    this.child.kill('SIGKILL');
    await this.waitForExit(2_500);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const exited = await Promise.race([this.exited.then(() => true as const), timedOut]);
    if (timer) clearTimeout(timer);
    return exited;
  }

  private write(value: unknown): void {
    if (this.closed || this.child.stdin.destroyed)
      throw new SessionControlError('offline', 'Codex app-server input is closed');
    this.child.stdin.write(JSON.stringify(value) + '\n', error => {
      if (error) this.options.log(
        `[${this.options.name}] codex app-server write failed: ${error.message}`);
    });
  }

  private receive(line: string): void {
    let value: JsonObject;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) throw new Error('message is not an object');
      value = parsed;
    } catch (error) {
      this.options.log(
        `[${this.options.name}] codex app-server: ignored malformed JSONL (${(error as Error).message})`);
      return;
    }
    const method = typeof value.method === 'string' ? value.method : undefined;
    const hasId = typeof value.id === 'string' || typeof value.id === 'number';
    if (method && hasId) {
      this.options.onRequest?.(method, value.id as RequestId,
        isObject(value.params) ? value.params : {});
      return;
    }
    if (method) {
      this.options.onNotification?.(method, isObject(value.params) ? value.params : {});
      return;
    }
    if (!hasId) return;
    const pending = this.pending.get(value.id as RequestId);
    if (!pending) return;
    this.pending.delete(value.id as RequestId);
    clearTimeout(pending.timer);
    if (value.error !== undefined) pending.reject(responseError(value.error));
    else pending.resolve(value.result);
  }
}
