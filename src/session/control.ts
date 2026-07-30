import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { SessionControlError } from './types.js';
import type { ControlFailureKind, SessionHandle } from './types.js';

const MAX_LINE_BYTES = 64 * 1024;

export interface ControlRequest {
  version: 1;
  id: string;
  token: string;
  command: 'status' | 'snapshot' | 'submit_prompt' | 'respond_permission' | 'interrupt' | 'follow';
  text?: string;
  permissionId?: string;
  optionId?: string;
  since?: number;
}

export interface ControlResponse {
  version: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Why it failed, so the caller does not have to guess from the text. */
  kind?: ControlFailureKind;
}

/**
 * One line saying what a control failure does — and does not — prove about the
 * agent. Only `offline` is evidence that it is gone; every other kind used to
 * be rendered as "is not running", which is how a busy agent got restarted.
 */
export function livenessNote(kind: ControlFailureKind, name: string): string {
  switch (kind) {
    case 'offline':
      return `'${name}' is confirmed offline.`;
    case 'control-unavailable':
      return `this says nothing about whether '${name}' is alive — its control plane did not answer; ` +
        `check: ours-fleet status ${name}`;
    case 'timeout':
      return `'${name}' did not answer in time; a busy agent looks exactly like this. ` +
        `Check: ours-fleet status ${name}`;
    case 'rejected':
      return `'${name}' is running and refused the request.`;
    case 'backend':
      return `this is a transport failure, not evidence that '${name}' is gone; ` +
        `check: ours-fleet status ${name}`;
  }
}

export const controlSocketPath = (stateDir: string) => join(stateDir, '.control.sock');
export const controlTokenPath = (stateDir: string) => join(stateDir, '.control-token');

function sameToken(actual: string, supplied: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Private, versioned JSONL control plane for CLI and future console frontends. */
export class RoleControlServer {
  private readonly server: Server;
  private readonly socketPath: string;
  private readonly token: string;
  private readonly sockets = new Set<Socket>();

  constructor(
    stateDir: string,
    private readonly session: SessionHandle,
    private readonly log: (line: string) => void,
  ) {
    this.socketPath = controlSocketPath(stateDir);
    const tokenPath = controlTokenPath(stateDir);
    this.token = existsSync(tokenPath)
      ? readFileSync(tokenPath, 'utf8').trim()
      : randomBytes(32).toString('hex');
    writeFileSync(tokenPath, this.token + '\n', { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    rmSync(this.socketPath, { force: true });
    this.server = createServer(socket => this.accept(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        try { chmodSync(this.socketPath, 0o600); } catch { /* platform dependent */ }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    rmSync(this.socketPath, { force: true });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let unsubscribe: (() => void) | undefined;
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        socket.destroy(new Error('control request too large'));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        void this.handle(line, socket).then(stop => {
          if (stop) {
            if (unsubscribe) {
              unsubscribe();
              this.session.setControllerAttached(false);
            }
            unsubscribe = stop;
          }
        });
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (unsubscribe) {
        unsubscribe();
        this.session.setControllerAttached(false);
      }
    });
    socket.on('error', error => this.log(`control socket: ${error.message}`));
  }

  private async handle(line: string, socket: Socket): Promise<(() => void) | undefined> {
    let request: ControlRequest;
    try { request = JSON.parse(line) as ControlRequest; }
    catch {
      this.write(socket, { version: 1, id: '?', ok: false, error: 'invalid JSON' });
      return;
    }
    if (request.version !== 1 || typeof request.id !== 'string'
        || !sameToken(this.token, request.token ?? '')) {
      this.write(socket, { version: 1, id: request.id ?? '?', ok: false, error: 'unauthorized' });
      return;
    }
    try {
      switch (request.command) {
        case 'status':
        case 'snapshot':
          this.write(socket, { version: 1, id: request.id, ok: true, result: this.session.snapshot() });
          return;
        case 'submit_prompt': {
          if (!request.text?.trim())
            throw new SessionControlError('rejected', 'text is required');
          // Answer on QUEUE ACCEPTANCE, not on turn completion. A turn can run
          // for minutes; blocking here made every `send` into a busy agent time
          // out, and the timeout was then reported as a dead agent.
          const queued = await this.session.queuePrompt(request.text);
          this.write(socket, {
            version: 1, id: request.id, ok: true,
            result: {
              state: 'queued', promptId: queued.promptId, queuedBehind: queued.queuedBehind,
            },
          });
          return;
        }
        case 'respond_permission': {
          if (!request.permissionId || !request.optionId)
            throw new SessionControlError('rejected', 'permissionId and optionId are required');
          const accepted = this.session.respondPermission(request.permissionId, request.optionId);
          this.write(socket, {
            version: 1, id: request.id, ok: accepted,
            result: { accepted },
            error: accepted ? undefined : 'stale or invalid permission response',
            kind: accepted ? undefined : 'rejected',
          });
          return;
        }
        case 'interrupt':
          await this.session.interrupt();
          this.write(socket, { version: 1, id: request.id, ok: true });
          return;
        case 'follow': {
          const since = Number.isFinite(request.since) ? Number(request.since) : 0;
          this.write(socket, {
            version: 1, id: request.id, ok: true,
            result: { events: this.session.eventsSince(since), snapshot: this.session.snapshot() },
          });
          this.session.setControllerAttached(true);
          return this.session.subscribe(event => {
            if (!socket.destroyed) socket.write(JSON.stringify({ version: 1, event }) + '\n');
          });
        }
      }
    } catch (error) {
      // Carry the session's own classification to the caller. Losing it here is
      // what forced the CLI to invent one.
      this.write(socket, {
        version: 1,
        id: request.id,
        ok: false,
        error: (error as Error)?.message ?? String(error),
        kind: error instanceof SessionControlError ? error.kind : 'backend',
      });
    }
  }

  private write(socket: Socket, response: ControlResponse): void {
    if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
  }
}

/**
 * Send one control request. Every failure mode is classified: a missing token
 * or socket is `control-unavailable`, a silent server is `timeout`, and a
 * response that is not parseable JSON is `backend`. The caller never has to
 * infer liveness from an exception message.
 */
export async function controlRequest(
  stateDir: string,
  request: Omit<ControlRequest, 'version' | 'id' | 'token'>,
  timeoutMs = 120_000,
): Promise<ControlResponse> {
  let token: string;
  try { token = readFileSync(controlTokenPath(stateDir), 'utf8').trim(); }
  catch (error) {
    throw new SessionControlError('control-unavailable',
      `cannot read the role control token: ${(error as Error)?.message ?? String(error)}`);
  }
  const id = randomUUID();
  const socket = createConnection(controlSocketPath(stateDir));
  socket.setEncoding('utf8');
  return new Promise<ControlResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SessionControlError('timeout',
        `the role control plane did not answer '${request.command}' within ${timeoutMs}ms`));
    }, timeoutMs);
    let buffer = '';
    socket.once('error', error => {
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      reject(new SessionControlError(
        code === 'ENOENT' || code === 'ECONNREFUSED' ? 'control-unavailable' : 'backend',
        `role control socket: ${error.message}`));
    });
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.slice(0, newline)) as ControlResponse); }
      catch (error) {
        reject(new SessionControlError('backend',
          `malformed control response: ${(error as Error)?.message ?? String(error)}`));
      }
      socket.end();
    });
    socket.once('connect', () => socket.write(JSON.stringify({
      version: 1, id, token, ...request,
    }) + '\n'));
  });
}

export async function followControl(
  stateDir: string,
  onMessage: (message: Record<string, unknown>) => void,
): Promise<{ socket: Socket; send(request: Omit<ControlRequest, 'version' | 'id' | 'token'>): void }> {
  const token = readFileSync(controlTokenPath(stateDir), 'utf8').trim();
  const socket = createConnection(controlSocketPath(stateDir));
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onMessage(JSON.parse(line) as Record<string, unknown>);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const send = (request: Omit<ControlRequest, 'version' | 'id' | 'token'>) =>
    socket.write(JSON.stringify({ version: 1, id: randomUUID(), token, ...request }) + '\n');
  send({ command: 'follow', since: 0 });
  return { socket, send };
}
