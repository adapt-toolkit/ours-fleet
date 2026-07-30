import { describe, it, expect } from 'vitest';
import { Tmux, tmuxArgs, tmuxSocket } from '../src/tmux.js';
import { shq, type Exec, type ExecResult } from '../src/exec.js';

function recorder(responses: Partial<Record<string, ExecResult>> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    // args[0..1] are the `-L <socket>` this fleet puts in front of every tmux
    // command, so the tmux subcommand starts at index 2.
    const key = args.slice(2, 4).join(' ');
    return responses[key] ?? { stdout: '', stderr: '', code: 0 };
  };
  return { calls, exec };
}

describe('Tmux', () => {
  it('newSession issues the right argv', async () => {
    const { calls, exec } = recorder();
    await new Tmux(exec).newSession('A', '/w', 'echo hi');
    expect(calls[0]).toEqual(
      ['tmux', '-L', 'ours-fleet-A', 'new-session', '-d', '-s', 'A', '-c', '/w', 'echo hi']);
  });

  it('newSession failure throws with stderr', async () => {
    const { exec } = recorder({ 'new-session -d': { stdout: '', stderr: 'boom', code: 1 } });
    await expect(new Tmux(exec).newSession('A', '/w', 'x')).rejects.toThrowError(/boom/);
  });

  it('sendText sends literal text then Enter', async () => {
    const { calls, exec } = recorder();
    await new Tmux(exec).sendText('A', 'hello world');
    expect(calls[0]).toEqual(['tmux', '-L', 'ours-fleet-A', 'send-keys', '-t', 'A', '-l', 'hello world']);
    expect(calls[1]).toEqual(['tmux', '-L', 'ours-fleet-A', 'send-keys', '-t', 'A', 'Enter']);
  });

  it('sendKey sends a raw key', async () => {
    const { calls, exec } = recorder();
    await new Tmux(exec).sendKey('A', 'Escape');
    expect(calls[0]).toEqual(['tmux', '-L', 'ours-fleet-A', 'send-keys', '-t', 'A', 'Escape']);
  });

  it('capture returns the last N lines', async () => {
    const { exec } = recorder({ 'capture-pane -t': { stdout: 'l1\nl2\nl3\nl4\n', stderr: '', code: 0 } });
    expect(await new Tmux(exec).capture('A', 2)).toBe('l3\nl4');
  });

  it('panePid parses the first line', async () => {
    const { exec } = recorder({ 'list-panes -t': { stdout: '4242\n', stderr: '', code: 0 } });
    expect(await new Tmux(exec).panePid('A')).toBe(4242);
  });

  it('panePid returns null when session is gone', async () => {
    const { exec } = recorder({ 'list-panes -t': { stdout: '', stderr: 'no session', code: 1 } });
    expect(await new Tmux(exec).panePid('A')).toBeNull();
  });
});

/**
 * #32 — every role's pane used to land on the ONE default tmux server, which
 * lives in the cgroup of whichever role started it first. Stopping that role's
 * unit killed every role's pane. The fix is a socket per session.
 */
describe('one tmux server per session (#32)', () => {
  it('every tmux command this class runs is addressed at the session own socket', async () => {
    const { calls, exec } = recorder({ 'list-panes -t': { stdout: '7\n', stderr: '', code: 0 } });
    const tmux = new Tmux(exec);

    // Drive the WHOLE surface: a single command that forgets `-L` is enough to
    // put a pane back on the shared server.
    await tmux.has('A');
    await tmux.newSession('A', '/w', 'run');
    await tmux.kill('A');
    await tmux.capture('A');
    await tmux.panePid('A');
    await tmux.list(['A']);
    await tmux.sendText('A', 'hi');
    await tmux.sendKey('A', 'Enter');

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.slice(0, 3)).toEqual(['tmux', '-L', 'ours-fleet-A']);
  });

  it('two roles never share a server, so one stop cannot reach the other', async () => {
    const { calls, exec } = recorder();
    const tmux = new Tmux(exec);
    await tmux.newSession('Alpha', '/w', 'run');
    await tmux.kill('Beta');

    const sockets = calls.map(c => c[2]);
    expect(sockets).toEqual(['ours-fleet-Alpha', 'ours-fleet-Beta']);
    expect(new Set(sockets).size).toBe(2);
    // Beta's kill is aimed at Beta's server only — nothing it can do reaches Alpha's.
    expect(calls.find(c => c.includes('kill-session'))).not.toContain(tmuxSocket('Alpha'));
  });

  it('tmuxArgs and tmuxSocket are the single source of the socket name', () => {
    expect(tmuxSocket('A')).toBe('ours-fleet-A');
    expect(tmuxArgs('A', ['ls'])).toEqual(['-L', 'ours-fleet-A', 'ls']);
  });

  it('list asks each named server and skips the ones that are not running', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return args[1] === 'ours-fleet-Beta'
        ? { stdout: '', stderr: 'no server running on /tmp/tmux-1000/ours-fleet-Beta', code: 1 }
        : { stdout: `${args[1].replace('ours-fleet-', '')}: 1 windows\n`, stderr: '', code: 0 };
    };
    expect(await new Tmux(exec).list(['Alpha', 'Beta', 'Gamma'])).toBe('Alpha: 1 windows\nGamma: 1 windows');
    expect(calls.map(c => c[2])).toEqual(['ours-fleet-Alpha', 'ours-fleet-Beta', 'ours-fleet-Gamma']);
  });
});

describe('shq', () => {
  it('escapes single quotes POSIX-style', () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`);
    expect(shq('plain')).toBe(`'plain'`);
  });
});
