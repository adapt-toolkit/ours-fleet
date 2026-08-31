import type { TaskListRecord, TaskRecord, TaskState } from '../rooms-tasks/types.js';
import type { ReportTaskNavigator, ReportValue, ReportViewModel } from './types.js';
import type { ReportArtifact, ReportRequest, ReportViewer } from './types.js';
import { FleetReportService, ReportRegistry, type SafeSnapshot } from './service.js';
import { createHash } from 'node:crypto';

export const TASK_REPORT_MAX_RECORDS = 200;
export const TASK_REPORT_MAX_TEXT = 2_000;
const TASK_REPORT_BRIEF_PREVIEW = 240;
const STATUS_LABEL: Record<TaskState, string> = {
  backlog: 'Backlog', provisioning: 'Provisioning', active: 'Active', review: 'Review',
  done: 'Done', cancelled: 'Cancelled', failed: 'Failed',
};
const STATUS_TONE: Record<TaskState, 'neutral' | 'good' | 'warning' | 'bad'> = {
  backlog: 'neutral', provisioning: 'warning', active: 'good', review: 'warning',
  done: 'good', cancelled: 'neutral', failed: 'bad',
};

const bounded = (value: string | undefined, limit = TASK_REPORT_MAX_TEXT): string | null => {
  if (value === undefined) return null;
  const points = [...value];
  return points.length <= limit ? value
    : `${points.slice(0, Math.max(0, limit - 34)).join('')}… [truncated from ${points.length} chars]`;
};
const briefPreview = (value: string | undefined): string => {
  const first = value?.split(/\r?\n/u).map(line => line.trim()).find(Boolean);
  return bounded(first, TASK_REPORT_BRIEF_PREVIEW) ?? 'No brief supplied.';
};
const field = (label: string, value: ReportValue['value'], tone?: ReportValue['tone'], multiline = false): ReportValue => ({
  label, value, ...(tone ? { tone } : {}), ...(multiline ? { multiline: true } : {}),
});

interface SafeTaskList { list_id: string; name: string; built_in: boolean }
interface SafeTask {
  task_id: string; list_id: string; list_name: string; title: string; brief?: string;
  state: TaskState; blocked?: { reason: string }; room_id?: string;
  template?: { name: string; version: number }; member_roles: Array<{ name: string; slot: string; cowork_role: string }>;
  origin: { type: string }; created_at: string; started_at?: string; ended_at?: string;
  outcome?: { summary?: string };
}
const allowlistList = (list: TaskListRecord): SafeTaskList => ({
  list_id: list.list_id, name: bounded(list.name) ?? 'Unnamed list', built_in: list.built_in,
});
const allowlistTask = (task: TaskRecord): SafeTask => ({
  task_id: task.task_id, list_id: task.list_id, list_name: bounded(task.list_name) ?? 'default',
  title: bounded(task.title) ?? 'Untitled task', ...(task.brief === undefined ? {} : { brief: bounded(task.brief) ?? '' }),
  state: task.state, ...(task.blocked ? { blocked: { reason: bounded(task.blocked.reason) ?? 'Blocked' } } : {}),
  ...(task.room_id ? { room_id: bounded(task.room_id) ?? undefined } : {}),
  ...(task.template ? { template: { name: bounded(task.template.name) ?? 'Unknown', version: task.template.version } } : {}),
  member_roles: task.member_roles.map(member => ({ name: bounded(member.name) ?? 'Unknown', slot: bounded(member.slot) ?? 'Unknown', cowork_role: bounded(member.cowork_role) ?? 'Unknown' })),
  origin: { type: task.origin.type }, created_at: task.created_at,
  ...(task.started_at ? { started_at: task.started_at } : {}), ...(task.ended_at ? { ended_at: task.ended_at } : {}),
  ...(task.outcome ? { outcome: { summary: bounded(task.outcome.summary) ?? undefined } } : {}),
});

function safeTask(task: SafeTask): ReportTaskNavigator['panels'][number]['tasks'][number] {
  const status = STATUS_LABEL[task.state];
  const title = bounded(task.title) ?? 'Untitled task';
  const brief = briefPreview(task.brief);
  const groups = [
    { title: '1. Identity and lifecycle', values: [
      field('Task ID', task.task_id), field('Title', title),
      field('Lifecycle status', status, STATUS_TONE[task.state]), field('List', task.list_name),
      field('Blocked indicator', task.blocked ? bounded(task.blocked.reason) : 'No — unblocked', task.blocked ? 'warning' : undefined),
    ] },
    { title: '2. Task content', values: [
      field('Brief', brief, undefined, true),
      field('Detailed description', bounded(task.brief), undefined, true),
    ] },
    { title: '3. Work context', values: [
      field('Room', task.room_id ?? null),
      field('Template', task.template ? `${task.template.name}@${task.template.version}` : null),
      field('Members and roles', task.member_roles.length
        ? bounded(task.member_roles.map(member => `${member.name} — ${member.slot} — ${member.cowork_role}`).join('\n')) : null, undefined, true),
      field('Origin', task.origin.type),
    ] },
    { title: '4. Timeline and outcome', values: [
      field('Created', task.created_at), field('Started', task.started_at ?? null), field('Ended', task.ended_at ?? null),
      field('Terminal outcome', bounded(task.outcome?.summary), undefined, true),
    ] },
  ];
  return {
    id: task.task_id, title, brief, status,
    ...(task.blocked ? { blocked: bounded(task.blocked.reason) ?? 'Blocked' } : {}), updated: task.ended_at ?? task.started_at ?? task.created_at,
    groups,
  };
}

function presentTasksReport(input: {
  lists: SafeTaskList[];
  tasks: SafeTask[];
  generatedAt: string;
  selectedList?: string;
  state?: TaskState;
  source?: { name: string; version: string; buildId?: string };
  observedAt?: string;
  totalsByList?: Record<string, number>;
  maxRecords?: number;
}): ReportViewModel {
  const maxRecords = input.maxRecords ?? TASK_REPORT_MAX_RECORDS;
  const includedLists = input.selectedList
    ? input.lists.filter(list => list.name === input.selectedList) : input.lists;
  let remaining = maxRecords;
  const panels = includedLists.map(list => {
    const all = input.tasks.filter(task => task.list_id === list.list_id);
    const total = input.totalsByList?.[list.list_id] ?? all.length;
    const shown = all.slice(0, remaining); remaining -= shown.length;
    return {
      id: list.list_id, name: list.name, total, shown: shown.length,
      description: shown.length === total ? `All ${total} tasks are included in source order.`
        : `${shown.length} of ${total} tasks are included by the report bound; source order is preserved.`,
      tasks: shown.map(safeTask),
    };
  });
  const defaultList = includedLists.find(list => list.name === input.selectedList)?.list_id
    ?? includedLists.find(list => list.built_in)?.list_id ?? includedLists[0]?.list_id ?? 'default';
  const section: ReportTaskNavigator = {
    kind: 'task-navigator', id: 'task-lists', title: 'Fleet task lists',
    description: 'One read-only task report shared by task and list commands.',
    lists: panels.map(panel => ({ id: panel.id, name: panel.name, count: panel.total,
      blocked: panel.tasks.filter(task => task.blocked).length })), defaultList, panels,
  };
  return {
    schemaVersion: 1, reportKind: 'tasks', title: 'Fleet task lists',
    description: section.description, generatedAt: input.generatedAt,
    source: input.source ?? { name: 'ours-fleet', version: '1' },
    filters: { ...(input.selectedList ? { list: input.selectedList } : {}), ...(input.state ? { state: input.state } : {}) },
    observedAt: input.observedAt ? { tasks: input.observedAt } : {}, unavailable: [], sections: [section],
  };
}

export function buildTasksReport(input: {
  lists: TaskListRecord[]; tasks: TaskRecord[]; generatedAt: string; selectedList?: string;
  state?: TaskState; source?: { name: string; version: string; buildId?: string };
  observedAt?: string; totalsByList?: Record<string, number>; maxRecords?: number;
}): ReportViewModel {
  return presentTasksReport({ ...input, lists: input.lists.map(allowlistList), tasks: input.tasks.map(allowlistTask) });
}

interface RawTaskReportData { lists: TaskListRecord[]; tasks: TaskRecord[] }
interface TaskReportData { lists: SafeTaskList[]; tasks: SafeTask[]; totalsByList: Record<string, number> }

export async function createTasksReport(input: {
  viewer: ReportViewer;
  collect: (limits: { maxRecords: number }) => Promise<RawTaskReportData> | RawTaskReportData;
  generatedAt?: string;
  state?: TaskState;
  selectedList?: string;
  source?: { name: string; version: string; buildId?: string };
  maxBytes?: number;
}): Promise<ReportArtifact> {
  const request: Extract<ReportRequest, { kind: 'tasks' }> = {
    kind: 'tasks', viewer: input.viewer,
    ...(input.state ? { state: input.state } : {}),
    ...(input.selectedList ? { list: input.selectedList } : {}),
  };
  const registry = new ReportRegistry().register({
    kind: 'tasks', maxRecords: TASK_REPORT_MAX_RECORDS,
    validate: (candidate: ReportRequest): candidate is Extract<ReportRequest, { kind: 'tasks' }> => candidate.kind === 'tasks',
    resourceId: () => undefined,
    present: (candidate, snapshot: SafeSnapshot<TaskReportData>, generatedAt) => presentTasksReport({
      ...snapshot.data, generatedAt, observedAt: snapshot.observedAt.tasks, source: input.source,
      selectedList: candidate.list, state: candidate.state as TaskState | undefined,
      maxRecords: TASK_REPORT_MAX_RECORDS,
    }),
  });
  const provider = {
    surface: input.viewer.surface,
    collect: async (_request: ReportRequest, limits: { maxRecords: number }): Promise<SafeSnapshot<TaskReportData>> => {
      const data = await input.collect(limits);
      const observedAt = new Date().toISOString();
      const total = data.tasks.length;
      const tasks = data.tasks.slice(0, limits.maxRecords).map(allowlistTask);
      const totalsByList = data.tasks.reduce<Record<string, number>>((totals, task) => {
        totals[task.list_id] = (totals[task.list_id] ?? 0) + 1; return totals;
      }, {});
      return { data: { lists: data.lists.map(allowlistList), tasks, totalsByList }, observedAt: { tasks: observedAt }, unavailable: [], stale: [],
        bounds: { shown: tasks.length, total, truncated: total > tasks.length } };
    },
  } as const;
  return new FleetReportService(registry, input.maxBytes)
    .create(request, { provider, generatedAt: input.generatedAt ?? new Date().toISOString() });
}

export async function createTaskReport(input: {
  viewer: ReportViewer; taskId: string;
  collect: () => Promise<TaskRecord> | TaskRecord;
  generatedAt?: string; source?: { name: string; version: string; buildId?: string }; maxBytes?: number;
}): Promise<ReportArtifact> {
  const request: Extract<ReportRequest, { kind: 'task' }> = { kind: 'task', viewer: input.viewer, taskId: input.taskId };
  const resourceSlug = input.taskId.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 68) || 'task';
  const resourceName = `${resourceSlug}-${createHash('sha256').update(input.taskId).digest('hex').slice(0, 10)}`;
  const registry = new ReportRegistry().register({
    kind: 'task', maxRecords: 1,
    validate: (candidate: ReportRequest): candidate is Extract<ReportRequest, { kind: 'task' }> => candidate.kind === 'task'
      && typeof candidate.taskId === 'string' && candidate.taskId.length > 0 && candidate.taskId.length <= 200,
    resourceId: () => resourceName,
    present: (candidate, snapshot: SafeSnapshot<SafeTask>, generatedAt) => {
      const task = snapshot.data;
      const model = presentTasksReport({
        lists: [{ list_id: task.list_id, name: task.list_name, built_in: task.list_id === 'default' }],
        tasks: [task], generatedAt, observedAt: snapshot.observedAt.tasks, source: input.source,
        selectedList: task.list_name, maxRecords: 1,
      });
      return { ...model, reportKind: 'task', title: `Task — ${task.title}`,
        description: `Focused read-only task report for ${candidate.taskId}.`, filters: { task: candidate.taskId } };
    },
  });
  const provider = {
    surface: input.viewer.surface,
    collect: async (): Promise<SafeSnapshot<SafeTask>> => {
      const collected = await input.collect();
      if (collected.task_id !== input.taskId) throw new Error('authorized task provider returned a mismatched resource');
      const task = allowlistTask(collected);
      return { data: task, observedAt: { tasks: new Date().toISOString() }, unavailable: [], stale: [],
        bounds: { shown: 1, total: 1, truncated: false } };
    },
  } as const;
  return new FleetReportService(registry, input.maxBytes)
    .create(request, { provider, generatedAt: input.generatedAt ?? new Date().toISOString() });
}
