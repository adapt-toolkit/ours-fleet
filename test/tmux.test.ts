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

    // Drive the complete containment surface.
    await tmux.has('A');
    await tmux.newSession('A', '/w', 'run');
    await tmux.kill('A');

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

});

describe('shq', () => {
  it('escapes single quotes POSIX-style', () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`);
    expect(shq('plain')).toBe(`'plain'`);
  });
});
