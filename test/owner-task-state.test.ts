import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OWNER_TASK_MAX_OPEN, OWNER_TASK_MAX_REPORTS, OWNER_TASK_REPORT_MIN_INTERVAL_MS,
  OwnerTaskState, ownerTaskDigest,
} from '../src/owner-channel/tasks.js';

const OWNER = 'A'.repeat(64);
const REQUEST = 'b'.repeat(64);
const dirs: string[] = [];

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-owner-task-state-'));
  dirs.push(dir);
  const path = join(dir, '.owner-channel-tasks.json');
  return { path, state: new OwnerTaskState(path) };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('OwnerTaskState', () => {
  it('persists only bounded routing metadata and hashes in mode 0600', () => {
    const { path, state } = make();
    const task = state.open({ requestId: REQUEST, contact: OWNER, wireId: 'source-wire' }, 1_000);
    const body = 'The specialist completed verification.';
    const digest = ownerTaskDigest('progress', body);
    state.beginReport(task.id, 'progress', digest, body.length, Buffer.byteLength(body), 2_000);
    state.delivered(task.id, digest, false, 2_000);
    const persisted = readFileSync(path, 'utf8');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(persisted).toContain('source-wire');
    expect(persisted).toContain(digest);
    expect(persisted).not.toContain(body);
  });

  it('turns a crash-time sending marker into an uncertain non-resendable task', () => {
    const { path, state } = make();
    const task = state.open({ requestId: REQUEST, contact: OWNER, wireId: 'wire' }, 1_000);
    const digest = ownerTaskDigest('done', 'Finished safely.');
    state.beginReport(task.id, 'done', digest, 16, 16, 2_000);

    const restarted = new OwnerTaskState(path);
    expect(restarted.route(task.id, 2_001).status).toBe('uncertain');
    expect(() => restarted.beginReport(task.id, 'done', digest, 16, 16, 2_001))
      .toThrow(/uncertain/);
  });

  it('enforces report count and interval limits without storing bodies', () => {
    const { state } = make();
    const task = state.open({ requestId: REQUEST, contact: OWNER, wireId: 'wire' }, 1_000);
    let now = 2_000;
    for (let i = 0; i < OWNER_TASK_MAX_REPORTS; i++) {
      const digest = ownerTaskDigest('progress', `Safe report ${i}.`);
      state.beginReport(task.id, 'progress', digest, 14, 14, now);
      state.delivered(task.id, digest, false, now);
      now += OWNER_TASK_REPORT_MIN_INTERVAL_MS;
    }
    const finalDigest = ownerTaskDigest('done', 'One report too many.');
    expect(() => state.beginReport(task.id, 'done', finalDigest, 20, 20, now))
      .toThrow(/limited to 20/);
  });

  it('fails closed on corrupt state instead of recovering routes', () => {
    const { path } = make();
    writeFileSync(path, '{"version":1,"tasks":[{"contact":"attacker"}]}', { mode: 0o666 });
    const state = new OwnerTaskState(path);
    expect(state.integrity()).toMatchObject({ ok: false });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => state.open({ requestId: REQUEST, contact: OWNER, wireId: 'wire' }))
      .toThrow(/corrupt/);
  });

  it('rejects unbounded routes and inconsistent persisted counters', () => {
    const { path, state } = make();
    expect(() => state.open({ requestId: REQUEST, contact: OWNER, wireId: '' }, 1_000))
      .toThrow(/route is invalid/);
    expect(() => state.open({
      requestId: REQUEST, contact: OWNER, wireId: 'x'.repeat(1_025),
    }, 1_000)).toThrow(/exceeds its bounds/);

    writeFileSync(path, JSON.stringify({
      version: 1,
      tasks: [{
        id: 'c'.repeat(64), requestId: REQUEST, contact: OWNER, wireId: 'wire',
        createdAt: 1_000, expiresAt: 1_000 + 7 * 24 * 60 * 60 * 1_000,
        status: 'open', sequence: 1, reportCount: 0, digests: [],
      }],
      tombstones: [],
    }), { mode: 0o600 });
    const restarted = new OwnerTaskState(path);
    expect(restarted.integrity()).toMatchObject({ ok: false });
    expect(() => restarted.route('c'.repeat(64))).toThrow(/corrupt/);
  });

  it('caps total open routes independently of the per-owner cap', () => {
    const { state } = make();
    for (let i = 0; i < OWNER_TASK_MAX_OPEN; i++) {
      const contact = i.toString(16).padStart(64, '0');
      state.open({ requestId: REQUEST, contact, wireId: `wire-${i}` }, 1_000);
    }
    expect(() => state.open({
      requestId: REQUEST, contact: 'f'.repeat(64), wireId: 'over-cap',
    }, 1_000)).toThrow(/32 open tasks/);
  });
});
