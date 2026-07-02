import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/doctor.js';
import type { Exec, ExecResult } from '../src/exec.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-doc-'));
  process.env.OURS_FLEET_HOME = dir;   // empty config → no harness checks unless --harness
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const execWith = (table: Record<string, ExecResult>): Exec =>
  async (cmd, args) => table[[cmd, args[0] ?? ''].join(' ')] ?? { stdout: '', stderr: '', code: 0 };

describe('doctor', () => {
  it('flags missing tmux with an install hint', async () => {
    const rep = await doctor({}, execWith({
      'tmux -V': { stdout: '', stderr: '', code: 127 },
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    }), 'linux');
    const t = rep.checks.find(c => c.name === 'tmux')!;
    expect(t.ok).toBe(false);
    expect(t.detail).toContain('apt install tmux');
    expect(rep.ok).toBe(false);
  });

  it('flags a stopped ours-mcp daemon', async () => {
    const rep = await doctor({}, execWith({
      'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: '', stderr: 'stopped', code: 1 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    }), 'linux');
    const d = rep.checks.find(c => c.name === 'ours-mcp daemon')!;
    expect(d.ok).toBe(false);
    expect(d.detail).toContain('ours-mcp start');
  });

  it('reports linger only on linux and passes when all green', async () => {
    const green = execWith({
      'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
      'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    });
    const linux = await doctor({}, green, 'linux');
    expect(linux.checks.some(c => c.name === 'linger')).toBe(true);
    expect(linux.ok).toBe(true);
    const mac = await doctor({}, green, 'darwin');
    expect(mac.checks.some(c => c.name === 'linger')).toBe(false);
  });

  it('unknown --harness surfaces as a failed check, not a crash', async () => {
    const rep = await doctor({ harness: 'nope' }, execWith({
      'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
      'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
      'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
    }), 'darwin');
    const h = rep.checks.find(c => c.name === 'nope')!;
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('unknown harness');
  });
});
