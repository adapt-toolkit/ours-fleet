import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { FleetError, safeLine } from '../application/errors.js';
import { stateRoot } from '../paths.js';

export type WebControlCommand = 'open' | 'revoke-all';

export const webControlPath = (dir = join(stateRoot(), 'web')) => join(dir, 'control.sock');

export interface WebControlServer {
  path: string;
  close(): Promise<void>;
}

export async function startWebControlServer(options: {
  dir?: string;
  onOpen(): void | Promise<void>;
  onRevokeAll(): void | Promise<void>;
  now?: () => number;
  rateLimit?: number;
}): Promise<WebControlServer> {
  const dir = options.dir ?? join(stateRoot(), 'web');
  const path = webControlPath(dir);
  const now = options.now ?? Date.now;
  const rateLimit = options.rateLimit ?? 10;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  rmSync(path, { force: true });
  let windowStart = now();
  let used = 0;
  const server = createServer(socket => {
    let body = '';
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on('data', chunk => {
      body += chunk.toString('utf8');
      if (body.length > 4_096) return socket.destroy();
      if (!body.includes('\n')) return;
      socket.pause();
      void (async () => {
        try {
          if (now() - windowStart >= 60_000) { windowStart = now(); used = 0; }
          used++;
          if (used > rateLimit) throw new FleetError('rate_limited', 'local web control rate limit exceeded');
          const parsed = JSON.parse(body.slice(0, body.indexOf('\n'))) as { command?: unknown };
          if (parsed.command === 'open') await options.onOpen();
          else if (parsed.command === 'revoke-all') await options.onRevokeAll();
          else throw new FleetError('invalid_request', 'unknown local web control command');
          socket.end(JSON.stringify({ ok: true }) + '\n');
        } catch (error) {
          const code = error instanceof FleetError ? error.code : 'internal';
          const message = safeLine(error instanceof Error ? error.message : String(error));
          socket.end(JSON.stringify({ ok: false, error: { code, message } }) + '\n');
        }
      })();
    });
  });
  await listen(server, path);
  chmodSync(path, 0o600);
  let closed = false;
  return {
    path,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(path, { force: true });
    },
  };
}

export async function requestWebControl(
  command: WebControlCommand,
  path = webControlPath(),
  timeoutMs = 5_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    let response = '';
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new FleetError('timeout', 'local web control request timed out'));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    socket.once('connect', () => socket.write(JSON.stringify({ command }) + '\n'));
    socket.on('data', chunk => { response += chunk.toString('utf8'); });
    socket.once('error', error => finish(new FleetError(
      'control_unavailable', `running web console control is unavailable: ${safeLine(error.message)}`,
    )));
    socket.once('end', () => {
      try {
        const parsed = JSON.parse(response) as { ok?: boolean; error?: { code?: string; message?: string } };
        if (!parsed.ok) throw new FleetError(
          parsed.error?.code === 'rate_limited' ? 'rate_limited' : 'rejected',
          parsed.error?.message ?? 'local web control request was rejected',
        );
        finish();
      } catch (error) { finish(error as Error); }
    });
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
