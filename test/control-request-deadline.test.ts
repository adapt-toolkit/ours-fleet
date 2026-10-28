import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { controlRequest, controlSocketPath, controlTokenPath } from '../src/session/control.js';
import { SessionControlError } from '../src/session/types.js';

const clean: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

/** A control plane that runs `answer` for each request line. */
async function plane(answer: (socket: Socket, request: { id: string }) => void) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-deadline-'));
  clean.push(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(controlTokenPath(stateDir), 'token\n');
  const live = new Set<Socket>();
  const server: Server = createServer(socket => {
    live.add(socket); socket.on('close', () => live.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline >= 0) answer(socket, JSON.parse(buffer.slice(0, newline)));
    });
  });
  await new Promise<void>(r => { server.listen(controlSocketPath(stateDir), r); });
  clean.push(() => new Promise<void>(r => { for (const s of live) s.destroy(); server.close(() => r()); }));
  return stateDir;
}
const busy = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* this process is busy */ } };

it('accepts a reply that arrived while this process was busy past the deadline', async () => {
  // The answer is written promptly, then this process stays busy beyond the deadline, as a
  // saturated web console does: the reply is waiting unread when the deadline timer runs.
  const stateDir = await plane((socket, request) => {
    socket.write(JSON.stringify({ version: 1, id: request.id, ok: true, result: { readiness: 'running' } }) + '\n');
    busy(400);
  });
  const response = await controlRequest(stateDir, { command: 'snapshot' }, 150);
  expect(response).toMatchObject({ ok: true, result: { readiness: 'running' } });
});

it('still times out a supervisor that never answers, without extra delay', async () => {
  const stateDir = await plane(() => { /* accept, then say nothing */ });
  const started = Date.now();
  const error = await controlRequest(stateDir, { command: 'snapshot' }, 150).then(() => null, e => e as SessionControlError);
  expect(error).toBeInstanceOf(SessionControlError);
  expect(error!.kind).toBe('timeout');
  expect(error!.message).toContain("did not answer 'snapshot' within 150ms");
  expect(Date.now() - started).toBeLessThan(1000);
});

it('times out a supervisor that answers only after the deadline', async () => {
  const stateDir = await plane((socket, request) => {
    setTimeout(() => socket.write(JSON.stringify({ version: 1, id: request.id, ok: true }) + '\n'), 600);
  });
  const error = await controlRequest(stateDir, { command: 'snapshot' }, 150).then(() => null, e => e as SessionControlError);
  expect(error!.kind).toBe('timeout');
});

it('accepts every reply of a concurrent batch while this process was busy past the deadline', async () => {
  let pending = 0;
  const stateDirs = await Promise.all([0, 1, 2].map(() => plane((socket, request) => {
    socket.write(JSON.stringify({ version: 1, id: request.id, ok: true, result: { readiness: 'running' } }) + '\n');
    // The last of the three answers keeps the process busy, as one long capture would.
    if (++pending === 3) busy(400);
  })));
  const responses = await Promise.all(stateDirs.map(dir => controlRequest(dir, { command: 'snapshot' }, 150)));
  expect(responses.map(r => r.ok)).toEqual([true, true, true]);
});

it('times out an incomplete reply and rejects a malformed one', async () => {
  const partial = await plane(socket => { socket.write('{"version":1,"ok":tr'); });
  const error = await controlRequest(partial, { command: 'snapshot' }, 150).then(() => null, e => e as SessionControlError);
  expect(error!.kind).toBe('timeout');
  const malformed = await plane(socket => { socket.write('not json\n'); busy(300); });
  const bad = await controlRequest(malformed, { command: 'snapshot' }, 150).then(() => null, e => e as SessionControlError);
  expect(bad!.kind).toBe('backend');
  expect(bad!.message).toContain('malformed control response');
});

it('does not accept a reply that arrives after a busy deadline turn', async () => {
  // Busy past the deadline with nothing written yet: the expiry turn finds no reply.
  const stateDir = await plane((socket, request) => {
    busy(400);
    setTimeout(() => socket.write(JSON.stringify({ version: 1, id: request.id, ok: true }) + '\n'), 300);
  });
  const error = await controlRequest(stateDir, { command: 'snapshot' }, 150).then(() => null, e => e as SessionControlError);
  expect(error!.kind).toBe('timeout');
});
