import { describe, expect, it } from 'vitest';
import { isInactive, needsAttention, presentFleet } from '../../web/src/fleet-presentation.js';

const item = (
  id: string, overall: string, liveness = 'running', reachability = 'online',
  problems: Array<{ source?: string }> = [],
) => ({
  role: { id, config: { mission: `${id} mission` } },
  status: { overall, supervisor: { liveness }, session: { reachability }, problems },
});

describe('active-first fleet presentation', () => {
  const live = item('Live', 'ready');
  const warning = item('Warning', 'attention');
  const unknown = item('Unknown', 'unknown', 'unknown', 'unknown');
  const stopped = item('Stopped', 'offline', 'stopped', 'offline');
  const degradedStopped = item('DegradedStopped', 'attention', 'stopped', 'offline');

  it('hides inactive nodes by default and reveals them only on request', () => {
    const all = [live, warning, unknown, stopped, degradedStopped];
    expect(presentFleet(all, { filter: '', showInactive: false, attentionOnly: false })
      .map(value => value.role.id)).toEqual(['Unknown', 'Warning', 'Live']);
    expect(presentFleet(all, { filter: '', showInactive: true, attentionOnly: false })
      .map(value => value.role.id)).toEqual([
        'Unknown', 'Warning', 'DegradedStopped', 'Live', 'Stopped',
      ]);
  });

  it('does not count stopped/offline nodes as needing active attention', () => {
    expect([live, warning, unknown, stopped, degradedStopped].filter(needsAttention)
      .map(value => value.role.id)).toEqual(['Warning', 'Unknown']);
    expect(isInactive(degradedStopped)).toBe(true);
    expect(presentFleet([warning, unknown, stopped], {
      filter: '', showInactive: true, attentionOnly: true,
    }).map(value => value.role.id)).toEqual(['Unknown', 'Warning']);
  });

  it('matches filter text "watchdog" for items carrying a source: watchdog problem', () => {
    const flagged = item('Flagged', 'attention', 'running', 'online', [{ source: 'watchdog' }]);
    const plain = item('Plain', 'attention');
    expect(presentFleet([flagged, plain], { filter: 'watchdog', showInactive: true, attentionOnly: false })
      .map(value => value.role.id)).toEqual(['Flagged']);
  });
});
