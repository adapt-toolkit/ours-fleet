import { describe, expect, it } from 'vitest';
import { partitionActivity } from '../../web/src/activity-presentation.js';

describe('activity presentation', () => {
  it('keeps meaningful activity visible and separates noisy streaming telemetry', () => {
    const events = [
      { seq: 1, kind: 'tool_update' },
      { seq: 2, kind: 'agent_text', text: 'Working' },
      { seq: 3, kind: 'agent_text', text: ' on' },
      { seq: 4, kind: 'agent_text', text: ' the release.' },
      { seq: 5, kind: 'permission' },
      { seq: 6, kind: 'thought' },
      { seq: 7, kind: 'turn_stop' },
    ];
    const result = partitionActivity(events);
    expect(result.meaningful.map(event => event.kind))
      .toEqual(['agent_text', 'permission', 'turn_stop']);
    expect(result.meaningful[0]).toMatchObject({
      seq: 2, lastSeq: 4, text: 'Working on the release.',
    });
    expect(result.technical.map(event => event.kind)).toEqual(['tool_update', 'thought']);
  });
});
