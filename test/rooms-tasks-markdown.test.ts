import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  MARKDOWN_MAX_BYTES, MARKDOWN_MAX_CODE_POINTS, markdownCode, markdownHeading,
  markdownMultiline, markdownProse, renderMarkdownFailure, renderMarkdownList,
  renderMarkdownResult, roomStatus, taskStatus, withinMarkdownBounds,
} from '../src/rooms-tasks/markdown.js';
import type { RoomOrchestrationState, TaskState } from '../src/rooms-tasks/types.js';

const points = (value: string): number => Array.from(value).length;

function expectSafe(value: string): void {
  expect(withinMarkdownBounds(value)).toBe(true);
  expect(points(value)).toBeLessThanOrEqual(MARKDOWN_MAX_CODE_POINTS);
  expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
  expect(value).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
  expect(value).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u);
}

describe('task/room Markdown primitives', () => {
  it('uses context-specific escaping and neutralizes control/spoofing characters', () => {
    expect(markdownHeading('# heading\r\n- injected')).toBe('\\# heading - injected');
    expect(markdownProse('*bold*\t[link](x)\u202e\u200b')).toBe('\\*bold\\* \\[link\\](x)��');
    expect(markdownMultiline('first\r\n> quote\rsecond\u0000')).toBe('first\n\\> quote\nsecond�');
  });

  it('keeps every line-leading CommonMark block construct literal, including CRLF input', () => {
    const input = [
      '# heading', '- item', '+ item', '* item', '1. ordered', '> quote',
      '---', '***', '___', '``` fence', '~~~ fence', '  ## indented heading',
    ].join('\r\n');
    const expected = [
      '\\# heading', '\\- item', '\\+ item', '\\* item', '1\\. ordered', '\\> quote',
      '\\---', '\\*\\*\\*', '\\_\\_\\_', '\\`\\`\\` fence', '\\~~~ fence', '  \\## indented heading',
    ].join('\n');
    expect(markdownMultiline(input)).toBe(expected);
    const rendered = renderMarkdownResult({
      icon: '📋', title: 'Literal multiline',
      fields: [{ label: 'Text', value: input, multiline: true }],
    });
    expect(rendered).toContain(expected.split('\n').map(line => `> ${line}`).join('\n'));
  });

  it('uses a CommonMark-safe padded code fence for backticks and spaces', () => {
    expect(markdownCode('`id``')).toBe('``` `id`` ```');
    expect(markdownCode(' spaced ')).toBe('`  spaced  `');
    expect(markdownCode('line\nnext')).toBe('`line next`');
  });

  it('maps every declared state to an icon and word, with a runtime fallback', () => {
    const tasks: TaskState[] = ['backlog', 'provisioning', 'active', 'review', 'done', 'cancelled', 'failed'];
    const rooms: RoomOrchestrationState[] = ['provisioning', 'active', 'closing', 'closed'];
    expect(tasks.map(taskStatus)).toMatchSnapshot();
    expect(rooms.map(roomStatus)).toMatchSnapshot();
    expect(taskStatus('future')).toBe('⚪ Unknown (future)');
    expect(roomStatus('future')).toBe('⚪ Unknown (future)');
  });
});

describe('task/room Markdown renderers', () => {
  it('snapshots a compact structured result and actionable failure', () => {
    expect(renderMarkdownResult({
      icon: '📋', title: 'Task details',
      fields: [
        { label: 'ID', value: 'task`one', kind: 'code' },
        { label: 'Title', value: 'Fix *parser* [now]' },
        { label: 'Status', value: taskStatus('active'), kind: 'markdown' },
        { label: 'Summary', value: 'line one\r\nline > two', multiline: true },
      ],
      sections: [{ heading: 'Next steps', items: ['Run /task review task-one.'] }],
    })).toMatchSnapshot();
    expect(renderMarkdownFailure({
      kind: 'not_found', subject: '/task show missing', detail: 'Task was not found.',
      action: 'Run /task list to find a valid task ID.',
    })).toMatchSnapshot();
  });

  it('snapshots zero, one, and many list results', () => {
    expect(renderMarkdownList({ icon: '📋', title: 'Tasks', empty: 'No tasks found.', records: [] }))
      .toMatchSnapshot();
    expect(renderMarkdownList({
      icon: '📋', title: 'Tasks', empty: 'No tasks found.',
      records: [`${taskStatus('active')} ${markdownCode('task-one')} — ${markdownProse('Fix parser')}`],
    })).toMatchSnapshot();
    expect(renderMarkdownList({
      icon: '🏠', title: 'Rooms', empty: 'No rooms found.',
      records: [
        `${roomStatus('active')} ${markdownCode('room-one')} — ${markdownProse('Alpha')}`,
        `${roomStatus('closing')} ${markdownCode('room-two')} — ${markdownProse('Beta')}`,
      ],
    })).toMatchSnapshot();
  });

  it('keeps omission records and truncation footers inside both final bounds', () => {
    const records = Array.from({ length: 2_000 }, (_, i) =>
      `${taskStatus('active')} ${markdownCode(`task-${i}`)} — ${markdownProse('*'.repeat(700))}`);
    const output = renderMarkdownList({ icon: '📋', title: 'Tasks', empty: 'No tasks.', records });
    expect(output).toMatch(/more results omitted/);
    expectSafe(output);

    const escaped = renderMarkdownResult({
      icon: '📋', title: 'Escaping bound',
      fields: Array.from({ length: 20 }, (_, i) => ({ label: `Field ${i}`, value: '*'.repeat(2_000) })),
    });
    expect(escaped).toContain('_… output truncated._');
    expectSafe(escaped);
  });

  it('makes the UTF-8 byte ceiling independently active for astral text', () => {
    const output = renderMarkdownResult({
      icon: '📋', title: 'Astral bound',
      fields: Array.from({ length: 20 }, (_, i) => ({ label: `Field ${i}`, value: '😀'.repeat(2_000) })),
    });
    expect(output).toContain('_… output truncated._');
    expect(points(output)).toBeLessThan(MARKDOWN_MAX_CODE_POINTS);
    expectSafe(output);
  });
});
