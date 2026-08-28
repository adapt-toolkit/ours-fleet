import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildTasksReport, createReportArtifact, createTaskReport, createTasksReport, renderReportHtml } from '../src/reports/index.js';
import type { TaskRecord, TaskState } from '../src/rooms-tasks/types.js';

const states: TaskState[] = ['backlog', 'provisioning', 'active', 'review', 'done', 'cancelled', 'failed'];
const lists = [
  { list_id: 'default', name: 'default', built_in: true, created_at: '2026-01-01T00:00:00.000Z' },
  { list_id: 'release', name: 'release', built_in: false, created_at: '2026-01-02T00:00:00.000Z' },
];
const task = (state: TaskState, index: number): TaskRecord => ({
  task_id: `tsk-${state}`, list_id: index < 4 ? 'release' : 'default', list_name: index < 4 ? 'release' : 'default',
  title: `${state} <task>`, brief: `${state} brief`, state,
  ...(state === 'provisioning' ? { blocked: { reason: 'waiting & safe', at: '2026-01-02T00:00:00.000Z' } } : {}),
  template: { name: 'pair', version: 1, content_hash: 'SECRET-HASH' }, room_id: `room-${index}`,
  room_identity_cid: 'SECRET-ROOM-CID', member_roles: [{ name: 'Reviewer', identity_cid: 'SECRET-MEMBER-CID', slot: 'critic', cowork_role: 'reviewer' }],
  origin: { type: 'cli', owner_cid: 'SECRET-OWNER-CID' }, idempotency_key: 'SECRET-IDEMPOTENCY',
  brief_file: '/SECRET/private/path', created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
  ...(state === 'failed' ? { terminal_intent: { kind: 'cancelled' as const, status: 'settled' as const, accepted_at: '2026-01-08T00:00:00.000Z', error: 'SECRET-ERROR' } } : {}),
});

describe('unified production task report', () => {
  it('uses canonical states, name-first tables, parity data, passive markup, and excludes sensitive fields', () => {
    const tasks = states.map(task);
    const model = buildTasksReport({ lists, tasks, generatedAt: '2026-08-28T15:00:00.000Z' });
    const html = renderReportHtml(model);
    expect(html).toContain('<th scope="col">Name</th><th scope="col">Brief description</th><th scope="col">Status</th>');
    for (const state of ['Backlog', 'Provisioning', 'Active', 'Review', 'Done', 'Cancelled', 'Failed']) expect(html).toContain(`>${state}<`);
    expect(html).toContain('data-task-title="failed &lt;task&gt;"');
    expect(html).toContain('<span class="blocked-indicator">Blocked</span>');
    for (const secret of ['SECRET-HASH', 'SECRET-ROOM-CID', 'SECRET-MEMBER-CID', 'SECRET-OWNER-CID', 'SECRET-IDEMPOTENCY', '/SECRET/private/path', 'SECRET-ERROR']) expect(html).not.toContain(secret);
    expect(html).not.toMatch(/<(?:script|form|iframe|object)\b/u);
  });

  it('is deterministic, reports bounds, and rejects duplicate task IDs', () => {
    const tasks = states.map(task);
    const input = { lists, tasks, generatedAt: '2026-08-28T15:00:00.000Z', maxRecords: 3 };
    const first = createReportArtifact(buildTasksReport(input));
    const second = createReportArtifact(buildTasksReport(input));
    expect(first.html).toBe(second.html);
    expect(first.metadata.truncated).toBe(true);
    expect(first.metadata.truncation.reduce((sum, item) => sum + item.shown, 0)).toBeLessThan(tasks.length);
    const duplicate = buildTasksReport({ lists, tasks: [task('active', 0), { ...task('done', 1), task_id: 'tsk-active' }], generatedAt: input.generatedAt });
    expect(() => renderReportHtml(duplicate)).toThrow(/duplicate task anchor/u);
  });

  it('keeps a short brief plus bounded full multiline details and enforces the shared artifact cap', async () => {
    const long = `Summary line\n${'detail '.repeat(500)}`;
    const record = { ...task('active', 0), brief: long };
    const artifact = await createTasksReport({
      viewer: { surface: 'cli', authority: 'local-owner' },
      generatedAt: '2026-08-28T15:00:00.000Z',
      collect: () => ({ lists, tasks: [record] }),
    });
    expect(artifact.html).toContain('Summary line');
    expect(artifact.html).toContain('Detailed description');
    expect(artifact.html).toContain('[truncated from');
    expect(artifact.metadata.observedAt.tasks).not.toBe(artifact.metadata.generatedAt);
    await expect(createTasksReport({
      viewer: { surface: 'cli', authority: 'local-owner' },
      generatedAt: '2026-08-28T15:00:00.000Z', maxBytes: 1,
      collect: () => ({ lists, tasks: [record] }),
    })).rejects.toThrow(/artifact limit/u);
  });

  it('creates a deterministic focused task artifact from one allowlisted read', async () => {
    let reads = 0;
    const record = { ...task('review', 0), task_id: '../Unsafe ID', title: '<img src=x onerror=alert(1)>' };
    const artifact = await createTaskReport({
      viewer: { surface: 'cli', authority: 'local-owner' }, taskId: record.task_id,
      generatedAt: '2026-08-28T15:00:00.000Z', collect: () => { reads++; return record; },
    });
    expect(reads).toBe(1);
    expect(artifact.metadata.reportKind).toBe('task');
    expect(artifact.metadata.filename).toMatch(/^fleet-task-unsafe-id-[a-f0-9]{10}\.html$/u);
    expect(artifact.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(artifact.html).not.toContain('SECRET-IDEMPOTENCY');
    expect(artifact.html).not.toContain('tsk-active');
    await expect(createTaskReport({
      viewer: { surface: 'cli', authority: 'local-owner' }, taskId: record.task_id,
      generatedAt: '2026-08-28T15:00:00.000Z', maxBytes: 1, collect: () => record,
    })).rejects.toThrow(/artifact limit/u);
    await expect(createTaskReport({
      viewer: { surface: 'cli', authority: 'local-owner' }, taskId: 'expected',
      generatedAt: '2026-08-28T15:00:00.000Z', collect: () => record,
    })).rejects.toThrow(/mismatched resource/u);
    const prefix = 'same-safe-prefix-'.repeat(8);
    const ids = [`${prefix}alpha`, `${prefix}beta`];
    const filenames = await Promise.all(ids.map(async taskId => (await createTaskReport({
      viewer: { surface: 'cli', authority: 'local-owner' }, taskId,
      generatedAt: '2026-08-28T15:00:00.000Z', collect: () => ({ ...record, task_id: taskId }),
    })).metadata.filename));
    expect(filenames[0]).not.toBe(filenames[1]);
    ids.forEach((taskId, index) => {
      const hash = createHash('sha256').update(taskId).digest('hex').slice(0, 10);
      expect(filenames[index]).toMatch(new RegExp(`-${hash}\\.html$`, 'u'));
      expect(filenames[index].length).toBeLessThanOrEqual(95);
    });
  });
});
