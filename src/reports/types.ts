export const REPORT_KINDS = [
  'overview', 'tasks', 'task-lists', 'task', 'rooms', 'room', 'room-members',
  'agents', 'agent-status', 'templates', 'template', 'template-validation',
  'loops', 'loop-status', 'loop-validation', 'watchdog', 'watchdog-runs',
  'version', 'config', 'doctor', 'manual',
] as const;

export type ReportKind = typeof REPORT_KINDS[number];
export type ReportTone = 'neutral' | 'good' | 'warning' | 'bad' | 'unknown';

export interface ReportValue {
  label: string;
  value: string | number | boolean | null;
  tone?: ReportTone;
  /** Internal artifact link only; the renderer derives the fragment. */
  target?: { section: string; id?: string };
  multiline?: boolean;
}

export type ReportViewer =
  | { surface: 'cli'; authority: 'local-owner' }
  | { surface: 'rest'; sessionId: string; roomCids: string[] }
  | { surface: 'messenger'; authenticatedCid: string; roomCids: string[] };

export type ReportRequest =
  | { kind: 'overview'; viewer: ReportViewer }
  | { kind: 'tasks'; viewer: ReportViewer; state?: string; list?: string; groupByList?: boolean }
  | { kind: 'task-lists'; viewer: ReportViewer }
  | { kind: 'task'; viewer: ReportViewer; taskId: string }
  | { kind: 'rooms'; viewer: ReportViewer; state?: string }
  | { kind: 'room'; viewer: ReportViewer; roomId: string }
  | { kind: 'room-members'; viewer: ReportViewer; roomId: string }
  | { kind: 'agents'; viewer: ReportViewer }
  | { kind: 'agent-status'; viewer: ReportViewer; role: string }
  | { kind: 'templates' | 'template-validation'; viewer: ReportViewer }
  | { kind: 'template'; viewer: ReportViewer; name: string }
  | { kind: 'loops' | 'loop-validation'; viewer: ReportViewer; role?: string }
  | { kind: 'loop-status'; viewer: ReportViewer; role?: string; loop?: string }
  | { kind: 'watchdog'; viewer: ReportViewer; watchdog: string; runId?: string }
  | { kind: 'watchdog-runs'; viewer: ReportViewer; watchdog: string }
  | { kind: 'version' | 'config' | 'doctor' | 'manual'; viewer: ReportViewer };

export interface ReportTable {
  kind: 'table';
  id: string;
  title: string;
  description?: string;
  columns: string[];
  rows: Array<{ id?: string; cells: ReportValue[] }>;
  empty?: string;
  truncated?: { shown: number; total: number };
}

export interface ReportDetails {
  kind: 'details';
  id: string;
  title: string;
  description?: string;
  values: ReportValue[];
  paragraphs?: string[];
}

export interface ReportNotice {
  kind: 'notice';
  id: string;
  title: string;
  tone: ReportTone;
  text: string;
}

export interface ReportCards {
  kind: 'cards';
  id: string;
  title: string;
  description?: string;
  items: Array<{
    id: string;
    title: string;
    subtitle?: string;
    tone?: ReportTone;
    values: ReportValue[];
    paragraphs?: string[];
    open?: boolean;
  }>;
  empty?: string;
  truncated?: { shown: number; total: number };
}

export interface ReportRecords {
  kind: 'records';
  id: string;
  title: string;
  description?: string;
  items: Array<{
    id: string;
    title: string;
    subtitle: string;
    tone?: ReportTone;
    open?: boolean;
    groups: Array<{ title: string; values: ReportValue[] }>;
  }>;
  empty?: string;
  truncated?: { shown: number; total: number };
}

export interface ReportListBoard {
  kind: 'list-board';
  id: string;
  title: string;
  description?: string;
  items: Array<{
    id: string;
    name: string;
    builtIn: boolean;
    createdAt: string | null;
    counts: { total: number; active: number; blocked: number; terminal: number };
    taskTarget: { section: string };
    recent: ReportValue[];
    recentTotal: number;
  }>;
  truncated?: { shown: number; total: number };
}

export interface ReportInbox {
  kind: 'inbox';
  id: string;
  title: string;
  description: string;
  lists: Array<{ id: string; name: string; count: number; blocked: number; selected: boolean }>;
  selected: { name: string; total: number; shown: number };
  attention: Array<{ id: string; title: string; brief: string; status: string; blocker: string; updated: string; groups: Array<{ title: string; values: ReportValue[] }> }>;
  active: Array<{ id: string; title: string; brief: string; status: string; updated: string; groups: Array<{ title: string; values: ReportValue[] }> }>;
  terminal: Array<{ id: string; title: string; brief: string; status: string; updated: string; outcome: string }>;
}

export interface ReportTaskNavigator {
  kind: 'task-navigator';
  id: string;
  title: string;
  description: string;
  lists: Array<{ id: string; name: string; count: number; blocked: number }>;
  defaultList: string;
  panels: Array<{
    id: string; name: string; total: number; shown: number; description: string;
    tasks: Array<{
      id: string; title: string; brief: string; status: string; blocked?: string;
      updated: string; groups: Array<{ title: string; values: ReportValue[] }>;
    }>;
  }>;
}

export type ReportSection = ReportTable | ReportDetails | ReportNotice | ReportCards | ReportRecords | ReportListBoard | ReportInbox | ReportTaskNavigator;

export interface ReportViewModel {
  schemaVersion: 1;
  reportKind: ReportKind;
  title: string;
  description?: string;
  generatedAt: string;
  source: { name: string; version: string; buildId?: string };
  filters?: Record<string, string>;
  observedAt?: Record<string, string>;
  summary?: ReportValue[];
  sections: ReportSection[];
  unavailable?: string[];
}

export interface ReportArtifactMetadata {
  schemaVersion: 1;
  reportKind: ReportKind;
  filename: string;
  mediaType: 'text/html; charset=utf-8';
  byteSize: number;
  source: { name: string; version: string; buildId?: string };
  generatedAt: string;
  filters: Record<string, string>;
  truncated: boolean;
  unavailable: string[];
  observedAt: Record<string, string>;
  truncation: Array<{ section: string; shown: number; total: number }>;
}

export interface ReportArtifact {
  metadata: ReportArtifactMetadata;
  html: string;
}
