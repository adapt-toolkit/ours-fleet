import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveModuleConstructor, TerminalBridgeManager } from '../../src/web/terminal/bridge.js';
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
  it('resolves xterm constructors from Node CommonJS default interop', () => {
    class TerminalFixture {}
    expect(resolveModuleConstructor({ default: { Terminal: TerminalFixture } }, 'Terminal'))
      .toBe(TerminalFixture);
    expect(() => resolveModuleConstructor({ default: {} }, 'Terminal'))
      .toThrow(/constructor is unavailable/);
  });

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
      async captureHistory() { return '\u001b[1;31mseed ┌─ █ \u001b[0m\n'; },
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
    const snapshot = first.json().find(message => message.type === 'snapshot');
    expect(snapshot.data).toMatch(/\u001b\[[0-9;]*m/);
    expect(snapshot.data).toContain('┌─ █ ');
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
    onData('\u001b[38;2;12;200;99mworld └─ ▄ \u001b[0m');
    const output = first.sent.find(value => value instanceof Uint8Array) as Uint8Array;
    expect(new TextDecoder().decode(output.slice(9))).toContain('\u001b[38;2;12;200;99m');
    expect(new TextDecoder().decode(output.slice(9))).toContain('└─ ▄ ');
    await manager.close();
    expect(ptyKills).toBe(1);
    expect(roleKills).toBe(0);
    void onExit;
  });
});
