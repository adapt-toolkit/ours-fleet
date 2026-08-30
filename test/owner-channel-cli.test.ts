import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoleControlServer } from '../src/session/control.js';
import type { OwnerChannelHandle, OwnerChannelManagementRequest } from '../src/owner-channel/channel.js';
import type { SessionHandle } from '../src/session/types.js';

const CLI = resolve('dist/cli.js');
const A = 'A'.repeat(64);
const B = 'B'.repeat(64);
const REQUEST = 'c'.repeat(64);
const TASK = 'd'.repeat(64);
// These cases intentionally launch 10+ separate CLI processes. Under a
// contended 2-core CI runner they can exceed Vitest's generic 5s unit-test
// budget even though every command completes normally.
const CLI_INTEGRATION_TIMEOUT_MS = 20_000;
let homeDir: string;
let control: RoleControlServer | undefined;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('dist/cli.js missing — global setup should have built it');
});
beforeEach(() => { homeDir = mkdtempSync(join(tmpdir(), 'ours-owner-cli-')); });
afterEach(async () => {
  await control?.close();
  control = undefined;
  rmSync(homeDir, { recursive: true, force: true });
});

const run = (args: string[], extraEnv: Record<string, string> = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>(resolveRun => {
  execFile(process.execPath, [CLI, ...args], {
    env: { ...process.env, OURS_FLEET_HOME: homeDir, ...extraEnv },
  },
    (error, stdout, stderr) => resolveRun({
      code: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
        ? (error as NodeJS.ErrnoException).code as number : error ? 1 : 0,
      stdout: String(stdout), stderr: String(stderr),
    }));
});

const runStdin = (args: string[], stdin: string) =>
  new Promise<{ code: number; stdout: string; stderr: string }>(resolveRun => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, OURS_FLEET_HOME: homeDir }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('exit', code => resolveRun({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });

function config(body = [
  'roles:', '  PhoneRole:', '    session: acp', '    owner_channel:',
  '      identity: PhoneRole-owner', `      owners: [${A}]`, '',
].join('\n')): void {
  writeFileSync(join(homeDir, 'fleet.yaml'), body);
}

async function startControl(manage: OwnerChannelHandle['manage']): Promise<void> {
  const stateDir = join(homeDir, '.ours-fleet', 'agents', 'PhoneRole');
  mkdirSync(stateDir, { recursive: true });
  const session = {
    backend: 'acp', pid: process.pid, isAlive: () => true,
    snapshot: () => ({ backend: 'acp', alive: true, readiness: 'running' }),
    queuePrompt: vi.fn(), interrupt: vi.fn(), eventsSince: () => [],
    setControllerAttached: vi.fn(), subscribe: () => () => {},
  } as unknown as SessionHandle;
  control = new RoleControlServer(stateDir, session, () => {});
  control.setOwnerChannel({ start: async () => {}, drain: async () => {}, close: async () => {}, manage });
  await control.start();
}

describe('owner-channel CLI', () => {
  it('exposes coherent nested help and the two-step authority boundary', async () => {
    const top = await run(['--help']);
    expect(top.stdout).toContain('owner-channel');
    const help = await run(['owner-channel', '--help']);
    expect(help.stdout).toContain('contact');
    expect(help.stdout).toContain('owner');
    expect(help.stdout).toContain('update');
    expect(help.stdout).toContain('task');
    expect(help.stdout).toContain('two-step');
  });

  it('runs every management command over role control without leaking invite material', async () => {
    config();
    const calls: OwnerChannelManagementRequest[] = [];
    await startControl(async request => {
      calls.push(request);
      switch (request.action) {
        case 'contact_list': return { action: request.action, contacts: [
          { cid: B, name: 'Mobile', status: 'established', kind: 'human' },
        ] };
        case 'contact_invite': return { action: request.action, invite: 'MOCK_INVITE_SECRET' };
        case 'contact_add': return { action: request.action, status: 'pending' };
        case 'owner_list': return { action: request.action, integrity: { ok: true }, owners: [
          { cid: A, source: 'baseline', effective: true },
          { cid: B, source: 'dynamic', effective: true },
        ] };
        case 'owner_authorize': return {
          action: request.action, owner: { cid: request.cid, source: 'dynamic', effective: true },
        };
        case 'owner_revoke': return {
          action: request.action, owner: { cid: request.cid, source: 'dynamic', effective: false },
        };
        case 'request_update': return {
          action: request.action, requestId: request.requestId, sequence: 1,
        };
        case 'task_open': return {
          action: request.action, taskId: TASK, expiresAt: '2026-08-10T00:00:00.000Z',
        };
        case 'task_report': return {
          action: request.action, taskId: request.taskId, phase: request.phase,
          sequence: 2, state: request.phase === 'progress' ? 'open' : 'closed',
        };
      }
    });

    const list = await run(['owner-channel', 'contact', 'list', 'PhoneRole']);
    expect(list).toMatchObject({ code: 0, stderr: '' });
    expect(list.stdout).toContain(`${B}\tMobile\testablished`);

    const invite = await run(['owner-channel', 'contact', 'invite', 'PhoneRole', '--name', 'Mobile']);
    expect(invite).toEqual({ code: 0, stdout: 'MOCK_INVITE_SECRET\n', stderr: '' });

    const fixture = join(homeDir, 'invite.fixture');
    writeFileSync(fixture, 'MOCK_FILE_INVITE\n', { mode: 0o600 });
    const fileAdd = await run([
      'owner-channel', 'contact', 'add', 'PhoneRole', '--invite-file', fixture, '--name', 'Mobile',
    ]);
    expect(fileAdd.code).toBe(0);
    expect(fileAdd.stdout).toContain('No owner authority was granted');
    expect(fileAdd.stdout + fileAdd.stderr).not.toContain('MOCK_FILE_INVITE');

    const stdinAdd = await runStdin([
      'owner-channel', 'contact', 'add', 'PhoneRole', '--invite-stdin',
    ], 'MOCK_STDIN_INVITE\n');
    expect(stdinAdd.code).toBe(0);
    expect(stdinAdd.stdout + stdinAdd.stderr).not.toContain('MOCK_STDIN_INVITE');

    const owners = await run(['owner-channel', 'owner', 'list', 'PhoneRole']);
    expect(owners.stdout).toContain(`${A}\tbaseline\tyes`);
    expect(owners.stdout).toContain(`${B}\tdynamic\tyes`);
    expect((await run(['owner-channel', 'owner', 'authorize', 'PhoneRole', B])).stdout)
      .toContain(`Authorized owner ${B}`);
    expect((await run(['owner-channel', 'owner', 'revoke', 'PhoneRole', B])).stdout)
      .toContain(`Revoked owner ${B}`);
    const update = await runStdin([
      'owner-channel', 'update', 'PhoneRole', REQUEST, '--phase', 'working', '--message-stdin',
    ], 'Focused verification is running.\n');
    expect(update).toEqual({ code: 0, stdout: 'Owner update 1 delivered.\n', stderr: '' });
    const opened = await run(['owner-channel', 'task', 'open', 'PhoneRole', REQUEST]);
    expect(opened).toEqual({
      code: 0,
      stdout: `Owner task ${TASK} opened; expires 2026-08-10T00:00:00.000Z.\n`, stderr: '',
    });
    const reported = await runStdin([
      'owner-channel', 'task', 'report', 'PhoneRole', TASK,
      '--phase', 'done', '--message-stdin',
    ], 'Specialist verification passed.\n');
    expect(reported).toEqual({
      code: 0, stdout: 'Owner task report 2 delivered; task closed.\n', stderr: '',
    });
    expect(calls.filter(call => call.action === 'contact_add')).toEqual([
      { action: 'contact_add', invite: 'MOCK_FILE_INVITE', name: 'Mobile' },
      { action: 'contact_add', invite: 'MOCK_STDIN_INVITE' },
    ]);
    expect(calls.find(call => call.action === 'request_update')).toEqual({
      action: 'request_update', requestId: REQUEST, phase: 'working',
      message: 'Focused verification is running.\n',
    });
    expect(calls.find(call => call.action === 'task_open')).toEqual({
      action: 'task_open', requestId: REQUEST,
    });
    expect(calls.find(call => call.action === 'task_report')).toEqual({
      action: 'task_report', taskId: TASK, phase: 'done',
      message: 'Specialist verification passed.\n',
    });
    expect(calls.filter(call => call.action === 'owner_authorize')).toEqual([
      { action: 'owner_authorize', cid: B },
    ]);
    expect(calls.filter(call => call.action === 'owner_revoke')).toEqual([
      { action: 'owner_revoke', cid: B },
    ]);
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it('validates owner CIDs before transport and acknowledges only a persisted success', async () => {
    config();
    const persisted = join(homeDir, 'owner-persisted');
    const manage = vi.fn(async (request: OwnerChannelManagementRequest) => {
      if (request.action !== 'owner_authorize') throw new Error('unexpected action');
      writeFileSync(persisted, request.cid);
      return {
        action: request.action,
        owner: { cid: request.cid, source: 'dynamic' as const, effective: true },
      };
    });
    await startControl(manage);

    const invalid = await run([
      'owner-channel', 'owner', 'authorize', 'PhoneRole', '../not-a-cid',
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('contact CID must be exactly 64 hexadecimal characters');
    expect(manage).not.toHaveBeenCalled();

    const valid = await run(['owner-channel', 'owner', 'authorize', 'PhoneRole', B]);
    expect(manage).toHaveBeenCalledWith({ action: 'owner_authorize', cid: B });
    expect(valid).toEqual({ code: 0, stdout: `Authorized owner ${B} (dynamic).\n`, stderr: '' });
    expect(existsSync(persisted)).toBe(true);
  });

  it('prefers the managed role proxy for spawn and supports --role', async () => {
    config();
    await startControl(async () => { throw new Error('not used'); });
    const stateDir = join(homeDir, '.ours-fleet', 'agents', 'PhoneRole');
    const spawn = vi.fn(async options => ({
      caller: 'PhoneRole', role: options.name, lifetime: options.temp ? 'temporary' as const : 'permanent' as const,
      statePath: '/state/ProxyWorker', harness: options.harness ?? 'codex', session: 'acp' as const,
      model: 'gpt-proxy', monitor: { mode: 'fleet' as const, interrupt: true },
      permissionMode: { fleetMode: 'allow' as const, nativeMode: 'bypassPermissions' },
      inherited: ['session', 'model', 'monitorConfig'], creationActionId: 'proxy-action',
    }));
    control!.setFleetSpawner(spawn);

    const result = await run([
      'spawn', '--role', 'ProxyWorker', '--temp', '--harness', 'claude-code',
    ], {
      OURS_FLEET_PROXY_STATE_DIR: stateDir,
      OURS_FLEET_PROXY_CALLER: 'PhoneRole',
    });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain("spawned temporary agent 'ProxyWorker' through PhoneRole's fleet proxy");
    expect(result.stdout).toContain('claude-code/acp');
    expect(result.stdout).toContain('permission=allow native=bypassPermissions');
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ProxyWorker', temp: true, harness: 'claude-code',
    }));
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it('rejects invalid targets, invalid CIDs, conflicting invite sources, and unavailable channels', async () => {
    config('roles:\n  Plain: { session: acp }\n  PhoneRole:\n    session: acp\n    owner_channel:\n      identity: PhoneRole-owner\n      owners: [' + A + ']\n');
    expect((await run(['owner-channel', 'contact', 'list', 'Missing'])).stderr).toMatch(/no such role/);
    expect((await run(['owner-channel', 'contact', 'list', 'Plain'])).stderr).toMatch(/no owner_channel/);
    expect((await run(['owner-channel', 'contact', 'list', 'PhoneRole'])).stderr).toMatch(/stopped.*control socket/);
    expect((await run(['owner-channel', 'owner', 'authorize', 'PhoneRole', 'not-a-cid'])).stderr)
      .toMatch(/64 hexadecimal/);
    expect((await runStdin([
      'owner-channel', 'update', 'PhoneRole', 'bad', '--phase', 'working', '--message-stdin',
    ], 'safe update')).stderr).toMatch(/64 lowercase/);
    expect((await run(['owner-channel', 'task', 'open', 'PhoneRole', 'bad'])).stderr)
      .toMatch(/64 lowercase/);
    expect((await runStdin([
      'owner-channel', 'task', 'report', 'PhoneRole', TASK,
      '--phase', 'wrong', '--message-stdin',
    ], 'safe report')).stderr).toMatch(/progress, done, or blocked/);

    await startControl(async () => { throw new Error('owner-channel MCP client is unavailable'); });
    const unavailable = await run(['owner-channel', 'owner', 'list', 'PhoneRole']);
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toContain('MCP client is unavailable');
    const conflicting = await runStdin([
      'owner-channel', 'contact', 'add', 'PhoneRole', '--invite-stdin', '--invite-file', 'ignored',
    ], 'NEVER_LOG_ME');
    expect(conflicting.stderr).toContain('exactly one');
    expect(conflicting.stdout + conflicting.stderr).not.toContain('NEVER_LOG_ME');
  }, CLI_INTEGRATION_TIMEOUT_MS);
});
