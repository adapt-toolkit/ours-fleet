import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import type { SessionHandle } from './types.js';

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
          if (!request.text?.trim()) throw new Error('text is required');
          const result = await this.session.submitPrompt(request.text);
          this.write(socket, { version: 1, id: request.id, ok: result.accepted, result,
            error: result.accepted ? undefined : result.detail });
          return;
        }
        case 'respond_permission': {
          if (!request.permissionId || !request.optionId)
            throw new Error('permissionId and optionId are required');
          const accepted = this.session.respondPermission(request.permissionId, request.optionId);
          this.write(socket, {
            version: 1, id: request.id, ok: accepted,
            result: { accepted }, error: accepted ? undefined : 'stale or invalid permission response',
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
      this.write(socket, {
        version: 1,
        id: request.id,
        ok: false,
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  private write(socket: Socket, response: ControlResponse): void {
    if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
  }
}

export async function controlRequest(
  stateDir: string,
  request: Omit<ControlRequest, 'version' | 'id' | 'token'>,
  timeoutMs = 120_000,
): Promise<ControlResponse> {
  const token = readFileSync(controlTokenPath(stateDir), 'utf8').trim();
  const id = randomUUID();
  const socket = createConnection(controlSocketPath(stateDir));
  socket.setEncoding('utf8');
  const response = await new Promise<ControlResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('role control request timed out'));
    }, timeoutMs);
    let buffer = '';
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.slice(0, newline)) as ControlResponse); }
      catch (error) { reject(error); }
      socket.end();
    });
    socket.once('connect', () => socket.write(JSON.stringify({
      version: 1, id, token, ...request,
    }) + '\n'));
  });
  return response;
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
