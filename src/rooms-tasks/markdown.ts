import { Buffer } from 'node:buffer';

import type { RoomOrchestrationState, TaskState } from './types.js';

export const MARKDOWN_MAX_CODE_POINTS = 3_500;
export const MARKDOWN_MAX_BYTES = 12_000;

const FIELD_MAX_CODE_POINTS = 900;
const FIELD_MAX_BYTES = 3_000;
const ID_MAX_CODE_POINTS = 160;
const ID_MAX_BYTES = 640;
const TRUNCATED = '_… output truncated._';

const SPOOFING_CONTROLS = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const MULTILINE_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const PROSE_PUNCTUATION = /([\\`*_[\]<>])/g;
const HEADING_PUNCTUATION = /([\\`*_[\]<>#])/g;

export interface StatusPresentation { icon: string; word: string }

const TASK_STATUS = {
  backlog: { icon: '⏸️', word: 'Backlog' },
  provisioning: { icon: '⏳', word: 'Provisioning' },
  active: { icon: '🟢', word: 'Active' },
  review: { icon: '🟡', word: 'Review' },
  done: { icon: '✅', word: 'Done' },
  cancelled: { icon: '🚫', word: 'Cancelled' },
  failed: { icon: '❌', word: 'Failed' },
} satisfies Record<TaskState, StatusPresentation>;

const ROOM_STATUS = {
  provisioning: { icon: '⏳', word: 'Provisioning' },
  active: { icon: '🟢', word: 'Active' },
  closing: { icon: '⏳', word: 'Closing' },
  closed: { icon: '🔒', word: 'Closed' },
} satisfies Record<RoomOrchestrationState, StatusPresentation>;

export type MarkdownField = {
  label: string;
  value: unknown;
  kind?: 'prose' | 'code' | 'markdown';
  multiline?: boolean;
};

export type MarkdownSection = {
  heading?: string;
  items?: unknown[];
  markdownItems?: string[];
  prose?: unknown;
};

const codePoints = (value: string): number => Array.from(value).length;
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

export function withinMarkdownBounds(value: string): boolean {
  return codePoints(value) <= MARKDOWN_MAX_CODE_POINTS && bytes(value) <= MARKDOWN_MAX_BYTES;
}

function normalize(value: unknown, multiline: boolean): string {
  let text = String(value ?? '').replace(/\r\n?/g, '\n').replace(SPOOFING_CONTROLS, '�');
  if (multiline) text = text.replace(MULTILINE_CONTROLS, '�');
  else text = text.replace(SINGLE_LINE_CONTROLS, ' ').replace(/\n+/g, ' ');
  return text;
}

function boundPlain(value: string, maxPoints: number, maxBytes: number): string {
  if (codePoints(value) <= maxPoints && bytes(value) <= maxBytes) return value;
  const suffix = '…';
  let out = '';
  for (const point of value) {
    const next = out + point + suffix;
    if (codePoints(next) > maxPoints || bytes(next) > maxBytes) break;
    out += point;
  }
  return out.replace(/\s+$/u, '') + suffix;
}

/** Escaped single-line prose suitable for a field or list item. */
export function markdownProse(value: unknown): string {
  return boundPlain(normalize(value, false).trim(), FIELD_MAX_CODE_POINTS, FIELD_MAX_BYTES)
    .replace(PROSE_PUNCTUATION, '\\$1');
}

/** Escaped heading text. Newlines and heading/list syntax cannot escape the heading. */
export function markdownHeading(value: unknown): string {
  return boundPlain(normalize(value, false).trim(), 160, 640)
    .replace(HEADING_PUNCTUATION, '\\$1');
}

/** Escaped multiline prose. Intended line breaks remain line breaks. */
export function markdownMultiline(value: unknown): string {
  const bounded = boundPlain(normalize(value, true).trim(), FIELD_MAX_CODE_POINTS, FIELD_MAX_BYTES);
  return bounded.split('\n').map(line => line.replace(PROSE_PUNCTUATION, '\\$1')).join('\n');
}

/** CommonMark code span with a delimiter longer than every run in the value. */
export function markdownCode(value: unknown): string {
  const normalized = normalize(value, false);
  const text = boundPlain(normalized || '—', ID_MAX_CODE_POINTS, ID_MAX_BYTES);
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(text) || (/^ | $/.test(text) && !/^ +$/.test(text));
  return `${fence}${pad ? ' ' : ''}${text}${pad ? ' ' : ''}${fence}`;
}

export function taskStatus(value: TaskState | string): string {
  const status = TASK_STATUS[value as TaskState];
  return status ? `${status.icon} ${status.word}` : `⚪ Unknown (${markdownProse(value)})`;
}

export function roomStatus(value: RoomOrchestrationState | string): string {
  const status = ROOM_STATUS[value as RoomOrchestrationState];
  return status ? `${status.icon} ${status.word}` : `⚪ Unknown (${markdownProse(value)})`;
}

function addBlock(blocks: string[], block: string): boolean {
  const candidate = [...blocks, block, TRUNCATED].join('\n\n');
  if (!withinMarkdownBounds(candidate)) return false;
  blocks.push(block);
  return true;
}

function finalize(blocks: string[], truncated: boolean): string {
  if (truncated) blocks.push(TRUNCATED);
  const output = blocks.join('\n\n');
  if (!withinMarkdownBounds(output)) throw new Error('Markdown result exceeded its transport bounds');
  return output;
}

export function renderMarkdownResult(input: {
  icon: string;
  title: string;
  fields?: MarkdownField[];
  sections?: MarkdownSection[];
}): string {
  const blocks = [`## ${input.icon} ${markdownHeading(input.title)}`];
  let truncated = false;
  for (const field of input.fields ?? []) {
    const label = markdownHeading(field.label);
    const value = field.kind === 'code' ? markdownCode(field.value)
      : field.kind === 'markdown' ? String(field.value)
        : field.multiline ? markdownMultiline(field.value) : markdownProse(field.value);
    const rendered = field.multiline
      ? `**${label}:**\n\n${value.split('\n').map(line => `> ${line}`).join('\n')}`
      : `- **${label}:** ${value || '—'}`;
    if (!addBlock(blocks, rendered)) { truncated = true; break; }
  }
  if (!truncated) for (const section of input.sections ?? []) {
    const lines: string[] = [];
    if (section.heading) lines.push(`### ${markdownHeading(section.heading)}`);
    if (section.prose !== undefined) lines.push(markdownMultiline(section.prose));
    const items = [
      ...(section.items ?? []).map(markdownProse),
      ...(section.markdownItems ?? []),
    ];
    let admitted = 0;
    for (const item of items) {
      const next = [...lines, `- ${item}`];
      const remaining = items.length - admitted - 1;
      const omission = remaining
        ? `- _${remaining} more ${remaining === 1 ? 'result' : 'results'} omitted\\._` : undefined;
      const candidate = [...blocks, [...next, ...(omission ? [omission] : [])].join('\n'), TRUNCATED]
        .join('\n\n');
      if (!withinMarkdownBounds(candidate)) break;
      lines.push(`- ${item}`);
      admitted++;
    }
    if (admitted < items.length) {
      const omitted = items.length - admitted;
      lines.push(`- _${omitted} more ${omitted === 1 ? 'result' : 'results'} omitted\\._`);
    }
    if (!addBlock(blocks, lines.join('\n'))) { truncated = true; break; }
  }
  return finalize(blocks, truncated);
}

export function renderMarkdownList(input: {
  icon: string;
  title: string;
  empty: string;
  records: string[];
}): string {
  const blocks = [`## ${input.icon} ${markdownHeading(input.title)}`];
  if (!input.records.length) return finalize([...blocks, markdownProse(input.empty)], false);
  let admitted = 0;
  for (const record of input.records) {
    const remaining = input.records.length - admitted - 1;
    const rendered = `- ${record}`;
    const omission = remaining
      ? `- _${remaining} more ${remaining === 1 ? 'result' : 'results'} omitted\\._` : '';
    const candidate = [...blocks, rendered, ...(omission ? [omission] : [])].join('\n\n');
    if (!withinMarkdownBounds(candidate)) break;
    blocks.push(rendered);
    admitted++;
  }
  if (admitted < input.records.length) {
    const omitted = input.records.length - admitted;
    const notice = `- _${omitted} more ${omitted === 1 ? 'result' : 'results'} omitted\\._`;
    if (!addBlock(blocks, notice)) return finalize(blocks, true);
  }
  return finalize(blocks, false);
}

export type FailureKind = 'usage' | 'not_found' | 'conflict' | 'state' | 'pending' | 'unexpected';

export function renderMarkdownFailure(input: {
  kind: FailureKind;
  subject: string;
  detail?: unknown;
  action: string;
}): string {
  const titles: Record<FailureKind, string> = {
    usage: 'Invalid command',
    not_found: 'Not found',
    conflict: 'Conflict',
    state: 'Action not allowed',
    pending: 'Action still pending',
    unexpected: 'Command failed',
  };
  return renderMarkdownResult({
    icon: input.kind === 'pending' ? '⏳' : '⚠️',
    title: titles[input.kind],
    fields: [
      { label: 'Command', value: input.subject, kind: 'code' },
      ...(input.detail !== undefined && input.kind !== 'unexpected'
        ? [{ label: 'Reason', value: input.detail } satisfies MarkdownField] : []),
    ],
    sections: [{ heading: 'Next step', items: [input.action] }],
  });
}
