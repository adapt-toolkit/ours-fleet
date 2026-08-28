import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReportArtifact } from '../dist/reports/index.js';

const out = process.argv[2];
if (!out) throw new Error('usage: generate-inbox-task-mocks.mjs <output-directory>');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const generatedAt = '2026-08-28T10:00:00.000Z';
const source = { name: 'ours-fleet', version: 'mock-preview', buildId: 'attention-first-task-inbox' };
const value = (label, fieldValue, tone, multiline = false) => ({
  label, value: fieldValue, ...(tone ? { tone } : {}), ...(multiline ? { multiline: true } : {}),
});
const statusTone = status => ({ Active: 'good', Done: 'good', Provisioning: 'warning', Review: 'warning', Failed: 'bad', Cancelled: 'neutral', Backlog: 'neutral' }[status] ?? 'unknown');
const groups = task => [
  { title: '1. Identity and lifecycle', values: [
    value('Task ID', task.id), value('Title', task.title), value('Lifecycle status', task.status, statusTone(task.status)),
    value('List', task.list), value('Blocked indicator', task.blocker ?? 'No — unblocked', task.blocker ? 'warning' : undefined),
  ] },
  { title: '2. Task content', values: [
    value('Brief', task.brief, undefined, true), value('Detailed description', task.description, undefined, true),
  ] },
  { title: '3. Work context', values: [
    value('Room', task.room), value('Template', task.template), value('Members and roles', task.members, undefined, true),
    value('Safe readiness', task.readiness, task.blocker ? 'warning' : 'good'),
  ] },
  { title: '4. Timeline and outcome', values: [
    value('Created', task.created), value('Updated', task.updated), value('Started', task.started),
    value('Ended', null), value('Terminal outcome', null),
  ] },
];
const withGroups = task => ({ ...task, groups: groups(task) });

const blocked = {
  id: 'tsk-release-blocked', title: 'Approve visual design', status: 'Active', list: 'release',
  blocker: 'Waiting for authenticated Owner visual approval.',
  brief: 'Review the attention-first task report before production integration begins.',
  description: 'Confirm that the selected list is unmistakable, blocked work appears once at the top, active work remains scannable, and full task details stay available without JavaScript.',
  room: 'rm-review', template: 'pair-review@2', members: 'Secretary — mock owner — blocked/waiting\nCritic — independent reviewer — reviewing/ready',
  readiness: '1 of 2 waiting for Owner', created: '2026-08-28T09:20:00.000Z', updated: '2026-08-28T09:40:00.000Z', started: '2026-08-28T09:23:00.000Z',
};
const activeTasks = [
  {
    id: 'tsk-release-capture', title: 'Capture responsive previews', status: 'Active', list: 'release',
    brief: 'Verify the selected-list report at desktop, mobile, and print sizes.',
    description: 'Capture deterministic screenshots, confirm the compact list navigation remains legible, and verify disclosure content is present in print.',
    room: 'rm-review', template: 'solo@1', members: 'Critic — verification owner — working/ready', readiness: 'Ready',
    created: '2026-08-28T09:15:00.000Z', updated: '2026-08-28T09:56:00.000Z', started: '2026-08-28T09:18:00.000Z',
  },
  {
    id: 'tsk-release-registry', title: 'Build report registry', status: 'Active', list: 'release',
    brief: 'Build the shared typed registry and deterministic report pipeline.',
    description: 'Create allowlisted collectors, canonical ordering, portable HTML output, bounded artifacts, and common delivery metadata while preserving text and JSON output.',
    room: 'rm-html', template: 'pair-review@2', members: 'Secretary — implementation owner — working/ready\nCritic — independent reviewer — reviewing/ready', readiness: '2 of 2 ready',
    created: '2026-08-28T08:00:00.000Z', updated: '2026-08-28T09:52:00.000Z', started: '2026-08-28T08:05:00.000Z',
  },
];
const lists = [
  { id: 'default', name: 'default', count: 2, blocked: 0, selected: false },
  { id: 'release', name: 'release', count: 7, blocked: 1, selected: true },
  { id: 'archive', name: 'archive', count: 5, blocked: 0, selected: false },
  { id: 'waiting', name: 'waiting', count: 0, blocked: 0, selected: false },
];
const inbox = (selectedName, total, shown, description, attention, active, terminal) => ({
  schemaVersion: 1, reportKind: 'task-lists', title: `Tasks · ${selectedName}`,
  description: 'A read-only snapshot organized around the selected task list.', generatedAt, source,
  filters: { list: selectedName }, observedAt: { tasks: '2026-08-28T09:59:58.000Z' }, unavailable: [],
  sections: [{ kind: 'inbox', id: `tasks-${selectedName}`, title: `${selectedName} tasks`, description,
    lists: lists.map(item => ({ ...item, selected: item.name === selectedName })), selected: { name: selectedName, total, shown },
    attention, active, terminal }],
});

const release = inbox(
  'release', 7, 4,
  'You are viewing the release list. One blocked task needs attention; active tasks are ordered by updated time, then ID.',
  [{ ...blocked, groups: groups(blocked) }],
  activeTasks.map(task => ({ ...task, groups: groups(task) })),
  [{ id: 'tsk-release-inventory', title: 'Audit command inventory', brief: 'Classify all current read-only surfaces.', status: 'Done', updated: '2026-08-27T14:15:00.000Z', outcome: 'Inventory documented with explicit privacy and mutation exclusions.' }],
);
const waiting = inbox(
  'waiting', 0, 0, 'You are viewing the waiting list. It contains no tasks and nothing needs attention.', [], [], [],
);

const combined = {
  schemaVersion: 1, reportKind: 'tasks', title: 'Fleet task lists',
  description: 'Jump to any included list. Each list puts blocked work first, then active work, then recent terminal outcomes.',
  generatedAt, source, filters: { lists: 'bounded included lists', state: 'all' },
  observedAt: { tasks: '2026-08-28T09:59:58.000Z' }, unavailable: [],
  sections: [{
    kind: 'task-navigator', id: 'task-lists', title: 'Fleet task lists',
    description: 'One read-only task report shared by task and list commands.', lists, defaultList: 'release',
    panels: [
      { id: 'release', name: 'release', total: 7, shown: 3, description: 'Three of seven tasks are included by the report bound; source order is preserved.', tasks: [
        withGroups({ ...blocked, status: 'Provisioning', blocked: blocked.blocker }),
        withGroups({ ...activeTasks[0], status: 'Active' }),
        withGroups({ ...activeTasks[1], id: 'tsk-release-review', status: 'Review', title: 'Review report registry', brief: 'Review the shared typed registry before integration.', description: 'Check the report registry contract, canonical ordering, bounded output, and transport-neutral artifact metadata before accepting the implementation.' }),
      ] },
      { id: 'default', name: 'default', total: 2, shown: 2, description: 'All two tasks are included in source order.', tasks: [
        withGroups({ ...activeTasks[1], id: 'tsk-default-backlog', list: 'default', status: 'Backlog', title: 'Plan report registry', brief: 'Plan the shared typed registry and deterministic report pipeline.', description: 'Document the registry inputs, authorization boundary, canonical ordering rules, output bounds, and delivery metadata before work starts.' }),
        withGroups({ ...activeTasks[1], id: 'tsk-default-done', list: 'default', title: 'Audit report safety', brief: 'Verify redaction boundaries.', description: 'Verify that reports exclude secrets, prompts, message bodies, raw logs, private paths, control sockets, and sensitive payloads.', status: 'Done' }),
      ] },
      { id: 'archive', name: 'archive', total: 5, shown: 2, description: 'Two of five tasks are included by the report bound; source order is preserved.', tasks: [
        withGroups({ ...activeTasks[1], id: 'tsk-archive-cancelled', list: 'archive', title: 'Retire obsolete preview', brief: 'Record cancellation of a superseded preview.', description: 'Retire the superseded preview after the unified table design replaced it; retain only safe review evidence.', status: 'Cancelled', room: null, template: 'solo@1', members: 'Secretary — cancellation recorder', readiness: 'Terminal — cancelled' }),
        withGroups({ ...activeTasks[1], id: 'tsk-archive-failed', list: 'archive', title: 'Capture legacy renderer', brief: 'A legacy capture failed before artifact creation.', description: 'The legacy capture could not produce a bounded printable artifact. Record the failure without exposing raw logs or sensitive error payloads.', status: 'Failed', room: 'rm-legacy', template: 'solo@1', members: 'Critic — capture owner — terminal/failed', readiness: 'Terminal — failed' }),
      ] },
      { id: 'waiting', name: 'waiting', total: 0, shown: 0, description: 'This included list contains no tasks.', tasks: [] },
    ],
  }],
};
const artifact = createReportArtifact(combined, 'combined');
await writeFile(join(out, artifact.metadata.filename), artifact.html, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: out, files: 1, filename: artifact.metadata.filename }));
