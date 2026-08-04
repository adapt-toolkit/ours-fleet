import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScheduledLoopManagerHandle } from '../src/loops/manager.js';
import { RoleControlServer } from '../src/session/control.js';
import type { SessionHandle } from '../src/session/types.js';

const CLI = resolve('dist/cli.js');
let homeDir: string;
let control: RoleControlServer | undefined;

beforeAll(() => { if (!existsSync(CLI)) throw new Error('dist/cli.js missing'); });
beforeEach(() => { homeDir = mkdtempSync(join(tmpdir(), 'ours-loops-cli-')); });
afterEach(async () => {
  await control?.close();
  control = undefined;
  rmSync(homeDir, { recursive: true, force: true });
});

const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolveRun => {
  execFile(process.execPath, [CLI, ...args], { env: { ...process.env, OURS_FLEET_HOME: homeDir } },
    (error, stdout, stderr) => resolveRun({
      code: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
        ? (error as NodeJS.ErrnoException).code as number : error ? 1 : 0,
      stdout: String(stdout), stderr: String(stderr),
    }));
});

function config(enabled = true) {
  writeFileSync(join(homeDir, 'fleet.yaml'), [
    'roles:', '  Coordinator: { session: acp }', 'loops:', '  health:',
    '    roles: [Coordinator]', '    interval: 10m', `    enabled: ${enabled}`,
    '    prompt: CANARY_CLI_PROMPT', '',
  ].join('\n'), { mode: 0o600 });
}

function state() {
  return {
    version: 1 as const, role: 'Coordinator', generation: 'a'.repeat(64),
    clock: { lastWallMs: 1 }, health: 'healthy' as const, anomaly: null,
    loops: { health: {
      definitionHash: 'b'.repeat(64), promptHash: 'c'.repeat(64), enabled: true,
      operatorDisabled: false, nextScheduledAt: '2026-08-03T20:00:00.000Z',
      nextDueAt: '2026-08-03T20:00:00.000Z', lastScheduledAt: null,
      lastStartedAt: null, lastFinishedAt: null, lastOutcome: 'skipped_busy',
      lastCancellationSource: null, lastRunId: null, activeRunId: null,
      counts: { started: 1, completed: 1, failed: 0, cancelled: 0,
        skipped: 1, skippedBusy: 1, skippedMissed: 0 }, lastError: null,
    } },
  };
}

async function startControl(manager: ScheduledLoopManagerHandle): Promise<void> {
  const dir = join(homeDir, '.ours-fleet', 'agents', 'Coordinator');
  mkdirSync(dir, { recursive: true });
  const session = {
    backend: 'acp', pid: process.pid, isAlive: () => true,
    snapshot: () => ({ backend: 'acp', alive: true, readiness: 'idle' }),
    queuePrompt: vi.fn(), interrupt: vi.fn(), eventsSince: () => [],
    setControllerAttached: vi.fn(), subscribe: () => () => {},
  } as unknown as SessionHandle;
  control = new RoleControlServer(dir, session, () => undefined);
  control.setLoopManager(manager);
  await control.start();
}

describe('scheduled loops CLI', () => {
  it('validates and lists redacted definitions without exposing prompt text', async () => {
    config();
    expect((await run(['loops', 'validate', '--json'])).stdout).toContain('"ok":true');
    const listed = await run(['loops', 'list', '--json']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toContain('CANARY_CLI_PROMPT');
    expect(JSON.parse(listed.stdout).loops[0].prompt).toMatchObject({ bytes: 17 });
  });

  it('uses versioned private control for status, run-now, persistent disable, and enable', async () => {
    config();
    const calls: string[] = [];
    const manager: ScheduledLoopManagerHandle = {
      start: () => undefined, stop: async () => undefined, status: () => state(),
      runNow: async name => { calls.push(`run:${name}`); return { state: 'started', runId: 'sl_test' }; },
      disable: name => { calls.push(`disable:${name}`); return { state: 'disabled' }; },
      enable: name => { calls.push(`enable:${name}`); return { state: 'started' }; },
      reconcile: () => undefined,
    };
    await startControl(manager);
    const status = await run(['loops', 'status', 'Coordinator', 'health']);
    expect(status.stdout).toContain('evidence=live');
    expect(status.stdout).toContain('skip=1(busy=1,missed=0)');
    expect((await run(['loops', 'run-now', 'Coordinator', 'health'])).code).toBe(0);
    expect((await run(['loops', 'disable', 'Coordinator', 'health'])).code).toBe(0);
    expect((await run(['loops', 'enable', 'Coordinator', 'health'])).code).toBe(0);
    expect(calls).toEqual(['run:health', 'disable:health', 'enable:health']);
  });

  it('classifies busy as exit 3 and unavailable control as exit 2 without retry', async () => {
    config();
    const manager: ScheduledLoopManagerHandle = {
      start: () => undefined, stop: async () => undefined, status: () => state(),
      runNow: async () => ({ state: 'skipped_busy' }),
      disable: () => ({ state: 'disabled' }), enable: () => ({ state: 'started' }),
      reconcile: () => undefined,
    };
    await startControl(manager);
    expect((await run(['loops', 'run-now', 'Coordinator', 'health'])).code).toBe(3);
    await control.close(); control = undefined;
    const unavailable = await run(['loops', 'run-now', 'Coordinator', 'health', '--json']);
    expect(unavailable.code).toBe(2);
    expect(JSON.parse(unavailable.stdout)).toMatchObject({
      ok: false, error: { kind: 'control-unavailable' },
    });
  });

  it('does not let operational enable override declarative disable', async () => {
    config(false);
    const result = await run(['loops', 'enable', 'Coordinator', 'health']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('disabled in YAML');
  });

  it('reloads trusted config through the authenticated live control plane', async () => {
    config();
    const manager: ScheduledLoopManagerHandle = {
      start: () => undefined, stop: async () => undefined, status: () => state(),
      runNow: async () => ({ state: 'started' }), disable: () => ({ state: 'disabled' }),
      enable: () => ({ state: 'started' }), reconcile: () => undefined,
    };
    await startControl(manager);
    control!.setConfigReloader(async () => ({ changed: true, loops: 1 }));
    const result = await run(['loops', 'reload', 'Coordinator', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true, role: 'Coordinator', changed: true, loops: 1,
    });
  });
});
