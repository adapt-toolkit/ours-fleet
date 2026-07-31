import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TerminalBridgeManager } from '../../src/web/terminal/bridge.js';
import { AuditSink } from '../../src/web/audit.js';

class SocketStub extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  send(value: string | Uint8Array) { this.sent.push(value); }
  close(_code?: number, _reason?: string) { this.readyState = 3; this.emit('close'); }
  json() {
    return this.sent.filter(value => typeof value === 'string')
      .map(value => JSON.parse(value as string));
  }
}

describe('tmux terminal bridge', () => {
  it('shares one PTY, enforces one writer lease, and never kills the role', async () => {
    let onData = (_data: string) => {};
    let onExit = () => {};
    const writes: string[] = [];
    let ptyKills = 0;
    const pty = {
      pid: 9, process: 'tmux', cols: 120, rows: 36,
      onData(callback: (data: string) => void) { onData = callback; return { dispose() {} }; },
      onExit(callback: () => void) { onExit = callback; return { dispose() {} }; },
      write(value: string) { writes.push(value); },
      resize() {},
      clear() {},
      pause() {},
      resume() {},
      kill() { ptyKills++; },
    };
    let spawns = 0;
    let roleKills = 0;
    const tmux = {
      async has() { return true; },
      async captureHistory() { return 'seed\n'; },
      async kill() { roleKills++; return true; },
    };
    const repository = {
      async get() {
        return {
          id: 'Alpha', lifetime: 'permanent', configured: true, stateHealth: 'present',
          configuredBackend: 'tmux', detectedBackend: 'tmux',
          compatibility: { compatible: true }, problems: [],
        };
      },
    };
    const manager = new TerminalBridgeManager({
      repository: repository as any, tmux: tmux as any,
      audit: new AuditSink(join(mkdtempSync(join(tmpdir(), 'terminal-audit-')), 'audit')),
      loadPty: async () => ({ spawn() { spawns++; return pty; } }) as any,
      graceMs: 5,
    });
    const first = new SocketStub();
    const second = new SocketStub();
    await manager.connect(first as any, 'Alpha', {});
    await manager.connect(second as any, 'Alpha', {});
    expect(spawns).toBe(1);
    expect(first.json().some(message => message.type === 'snapshot')).toBe(true);
    first.emit('message', Buffer.from(JSON.stringify({ type: 'lease.request' })), false);
    const lease = first.json().find(message => message.type === 'lease.granted');
    expect(lease.leaseId).toBeTruthy();
    second.emit('message', Buffer.from(JSON.stringify({ type: 'lease.request' })), false);
    expect(second.json().some(message => message.code === 'lease_held')).toBe(true);
    const payload = Buffer.from('hello');
    const frame = Buffer.alloc(9 + payload.length); frame[0] = 2; payload.copy(frame, 9);
    second.emit('message', frame, true);
    expect(writes).toEqual([]);
    first.emit('message', frame, true);
    expect(writes).toEqual(['hello']);
    onData('world');
    expect(first.sent.some(value => value instanceof Uint8Array)).toBe(true);
    await manager.close();
    expect(ptyKills).toBe(1);
    expect(roleKills).toBe(0);
    void onExit;
  });
});
