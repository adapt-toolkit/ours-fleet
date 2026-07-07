import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/doctor.js';
import { registerAdapter } from '../src/harness/registry.js';
import { fakeAdapter } from './registry.test.js';
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

describe('doctor isolation reporting', () => {
  const green = (over: Record<string, ExecResult> = {}): Exec => execWith({
    'tmux -V': { stdout: 'tmux 3.6', stderr: '', code: 0 },
    'ours-mcp --version': { stdout: '0.1.2', stderr: '', code: 0 },
    'ours-mcp status': { stdout: 'running', stderr: '', code: 0 },
    'loginctl show-user': { stdout: 'Linger=yes', stderr: '', code: 0 },
    'bwrap --version': { stdout: 'bubblewrap 0.11.1', stderr: '', code: 0 },
    'bwrap --ro-bind': { stdout: '', stderr: '', code: 0 },
    ...over,
  });

  it('reports bubblewrap availability (advisory; does not fail doctor)', async () => {
    const rep = await doctor({}, green(), 'linux');
    const bw = rep.checks.find(c => c.name === 'isolation: bubblewrap')!;
    expect(bw).toBeTruthy();
    expect(bw.ok).toBe(true);
    expect(bw.detail).toMatch(/available/i);
  });

  it('reports bubblewrap NOT available without failing doctor when no role needs it', async () => {
    const rep = await doctor({}, green({ 'bwrap --version': { stdout: '', stderr: '', code: 127 } }), 'linux');
    const bw = rep.checks.find(c => c.name === 'isolation: bubblewrap')!;
    expect(bw.ok).toBe(true);
    expect(bw.detail).toMatch(/not available|unavailable|not found/i);
  });

  it('reports per-role effective isolation (backend, net, caps)', async () => {
    registerAdapter(fakeAdapter);
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  Sec:\n    harness: fake\n    isolation:\n      network: deny\n      resources:\n        mem: 2G\n        cpu: "1"\n');
    const rep = await doctor({}, green(), 'linux');
    const r = rep.checks.find(c => c.name === 'isolation: Sec')!;
    expect(r).toBeTruthy();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/bubblewrap/);
    expect(r.detail).toMatch(/deny/);
    expect(r.detail).toMatch(/mem=2G/);
  });

  it('flags a strict role that cannot be sandboxed as a failed check', async () => {
    registerAdapter(fakeAdapter);
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  Sec:\n    harness: fake\n    isolation:\n      on_unavailable: strict\n');
    const rep = await doctor({}, green({ 'bwrap --version': { stdout: '', stderr: '', code: 127 } }), 'linux');
    const r = rep.checks.find(c => c.name === 'isolation: Sec')!;
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/strict|refuse/i);
    expect(rep.ok).toBe(false);
  });
});
