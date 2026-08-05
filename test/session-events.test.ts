import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionEvents } from '../src/session/events.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SessionEvents transient commentary', () => {
  it('delivers commentary live while persisting only a redacted marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-session-events-'));
    dirs.push(dir);
    const path = join(dir, 'events.jsonl');
    const events = new SessionEvents(path);
    const observed: string[] = [];
    events.subscribe(event => observed.push(event.text ?? ''));
    events.emit('agent_text', {
      turnId: 'turn-1', messageId: 'message-1', messagePhase: 'commentary',
      origin: { kind: 'owner', requestId: 'request-1' }, text: 'private progress detail',
    });

    expect(observed).toEqual(['private progress detail']);
    expect(events.since(0)[0].text).toBe('private progress detail');
    const persisted = readFileSync(path, 'utf8');
    expect(persisted).toContain('[assistant commentary redacted]');
    expect(persisted).not.toContain('private progress detail');
  });
});
