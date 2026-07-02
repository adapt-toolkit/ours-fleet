import { describe, it, expect } from 'vitest';
import { Tmux } from '../src/tmux.js';
import { shq, type Exec, type ExecResult } from '../src/exec.js';

function recorder(responses: Partial<Record<string, ExecResult>> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args.slice(0, 2).join(' ');
    return responses[key] ?? { stdout: '', stderr: '', code: 0 };
  };
  return { calls, exec };
}

describe('Tmux', () => {
  it('newSession issues the right argv', async () => {
    const { calls, exec } = recorder();
    await new Tmux(exec).newSession('A', '/w', 'echo hi');
    expect(calls[0]).toEqual(['tmux', 'new-session', '-d', '-s', 'A', '-c', '/w', 'echo hi']);
  });

  it('newSession failure throws with stderr', async () => {
    const { exec } = recorder({ 'new-session -d': { stdout: '', stderr: 'boom', code: 1 } });
    await expect(new Tmux(exec).newSession('A', '/w', 'x')).rejects.toThrowError(/boom/);
  });

  it('sendText sends literal text then Enter', async () => {
    const { calls, exec } = recorder();
    await new Tmux(exec).sendText('A', 'hello world');
    expect(calls[0]).toEqual(['tmux', 'send-keys', '-t', 'A', '-l', 'hello world']);
    expect(calls[1]).toEqual(['tmux', 'send-keys', '-t', 'A', 'Enter']);
  });

  it('sendKey sends a raw key', async () => {
    const { calls, exec } = recorder();
    await new Tmux(exec).sendKey('A', 'Escape');
    expect(calls[0]).toEqual(['tmux', 'send-keys', '-t', 'A', 'Escape']);
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

describe('shq', () => {
  it('escapes single quotes POSIX-style', () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`);
    expect(shq('plain')).toBe(`'plain'`);
  });
});
