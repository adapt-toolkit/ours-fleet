import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlRequest, controlTokenPath } from '../src/session/control.js';

vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(), createConnection: vi.fn(),
}));
const dirs: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true,force:true}); });

describe('control socket connection diagnostics', () => {
  it('keeps managed CLI help fail-closed when audit cannot reach the socket', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-denial-')); dirs.push(dir);
    writeFileSync(controlTokenPath(dir), 'private-fixture-token', {mode:0o600});
    const preload = join(dir, 'deny.cjs');
    writeFileSync(preload, `const net=require('node:net');const {EventEmitter}=require('node:events');
      net.createConnection=()=>{const socket=Object.assign(new EventEmitter(),{setEncoding(){},destroy(){}});
        process.nextTick(()=>socket.emit('error',Object.assign(Error('connect '+process.env.FIXTURE_DENIAL),{code:process.env.FIXTURE_DENIAL})));return socket;};
      require('node:module').syncBuiltinESMExports();`);
    for (const code of ['EPERM','EACCES']) {
      const result=spawnSync(process.execPath,['--require',preload,resolve('dist/cli.js'),'--help'],{
        env:{PATH:process.env.PATH,HOME:dir,OURS_FLEET_HOME:dir,OURS_FLEET_PROXY_CALLER:'Fixture',
          OURS_FLEET_PROXY_STATE_DIR:dir,OURS_FLEET_SOCKET_ROOT:process.env.OURS_FLEET_SOCKET_ROOT,FIXTURE_DENIAL:code},
        encoding:'utf8',timeout:10000,
      });
      expect(result.error).toBeUndefined();expect(result.status).toBe(1);expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`connect ${code}`);
      expect(result.stderr).toContain("before 'fleet_audit_begin' reached the supervisor");
      expect(result.stderr).not.toContain('private-fixture-token');
    }
  });
  it.each(['EPERM', 'EACCES', 'ENOENT', 'ECONNREFUSED', 'EIO'])('preserves classification and fail-closed requests for %s', async code => {
    const dir = mkdtempSync(join(tmpdir(), 'control-denial-')); dirs.push(dir);
    writeFileSync(controlTokenPath(dir), 'private-fixture-token', {mode:0o600});
    const socket = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn(),
    });
    vi.mocked(createConnection).mockImplementation(() => {
      queueMicrotask(() => socket.emit('error', Object.assign(Error(`connect ${code}`), {code})));
      return socket as unknown as Socket;
    });
    const error = await controlRequest(dir, {command:'fleet_audit_begin',audit:{requestId:'fixture',argv:['--help']}}).catch(error => error);
    expect(error.kind).toBe(['ENOENT','ECONNREFUSED'].includes(code) ? 'control-unavailable' : 'backend');
    expect(error.message).toContain(`role control socket: connect ${code}`);
    expect(socket.write).not.toHaveBeenCalled();
    expect(createConnection).toHaveBeenCalledTimes(1);
    if (['EPERM','EACCES'].includes(code)) {
      expect(error.message).toContain("before 'fleet_audit_begin' reached the supervisor");
      expect(error.message).toContain('socket permissions and the command execution sandbox');
      expect(error.message).toContain('do not bypass Fleet audit');
      expect(error.message).toContain('docs/validation/managed-cli-permissions.md');
    } else expect(error.message).not.toContain('command execution sandbox');
    expect(error.message).not.toContain('private-fixture-token');
  });
});
