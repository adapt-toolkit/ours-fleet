import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Tmux } from '../../src/tmux.js';
import { TerminalBridgeManager } from '../../src/web/terminal/bridge.js';
import { AuditSink } from '../../src/web/audit.js';

class SocketStub extends EventEmitter {
  OPEN = 1; readyState = 1; bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  send(value: string | Uint8Array) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit('close'); }
}

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
  && process.env.OURS_FLEET_REAL_TMUX === '1';

describe.skipIf(!hasTmux)('real isolated tmux PTY bridge', () => {
  it('detaches the server-owned PTY without killing the role session', async () => {
    const roleId = `WebMvp${process.pid}${Date.now()}`;
    const dir = mkdtempSync(join(tmpdir(), 'web-terminal-real-'));
    const tmux = new Tmux();
    await tmux.newSession(roleId, dir, 'sh');
    try {
      await tmux.sendText(roleId, `printf '\\033[1;31mHISTORY┌─█\\033[0m\\n'`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const history = await tmux.captureHistory(roleId);
      expect(history).toMatch(/\u001b\[[0-9;]*m/);
      expect(history).toContain('HISTORY┌─█');
      const repository = {
        async get() {
          return {
            id: roleId, lifetime: 'permanent', configured: true, stateHealth: 'present',
            configuredBackend: 'tmux', detectedBackend: 'tmux',
            compatibility: { compatible: true }, problems: [],
          };
        },
      };
      const manager = new TerminalBridgeManager({
        repository: repository as any, tmux,
        audit: new AuditSink(join(dir, 'audit')), graceMs: 5,
      });
      if (!await manager.available()) return;
      const socket = new SocketStub();
      await manager.connect(socket as any, roleId, {});
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(socket.sent.some(value => typeof value === 'string'
        && JSON.parse(value).type === 'ready')).toBe(true);
      const snapshot = socket.sent.filter(value => typeof value === 'string')
        .map(value => JSON.parse(value as string)).find(value => value.type === 'snapshot');
      expect(snapshot.data).toMatch(/\u001b\[[0-9;]*m/);
      expect(snapshot.data).toContain('HISTORY┌─█');
      await tmux.sendText(roleId, `printf '\\033[3;4;38;2;12;200;99mLIVE└─▄\\033[0m\\n'`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const raw = Buffer.concat(socket.sent.filter(value => value instanceof Uint8Array)
        .map(value => Buffer.from((value as Uint8Array).slice(9)))).toString();
      expect(raw).toMatch(/\u001b\[[0-9;]*m/);
      expect(raw).toContain('LIVE└─▄');
      await manager.close();
      expect(await tmux.has(roleId)).toBe(true);
    } finally {
      await tmux.kill(roleId);
    }
  });
});
