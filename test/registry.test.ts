import { describe, it, expect } from 'vitest';
import { registerAdapter, getAdapter, knownAdapters } from '../src/harness/registry.js';
import type { HarnessAdapter } from '../src/harness/types.js';

export const fakeAdapter: HarnessAdapter = {
  id: 'fake',
  supportsResume: true,
  async checkPrereqs() { return { ok: true, checks: [] }; },
  validateOptions() { return []; },
  async prepareSession() { return { argv: ['--fake-prep'], env: { FAKE: '1' } }; },
  buildLaunch(role, mode, s, prep) {
    return { argv: ['fakebin', ...prep.argv, mode === 'fresh' ? '--sid' : '--resume', s.sessionId, 'go'], env: prep.env };
  },
  vocabulary: {
    bindTool: 'choose_identity', createTool: 'create_identity', setBioTool: 'set_bio',
    setPersonaTool: 'set_persona', currentIdentityTool: 'current_identity',
    sendTool: 'send_message', getMessagesTool: 'get_messages',
    watchCommand: id => `ours-mcp watch "${id}"`,
    monitorInstruction: id => `Arm a persistent Monitor running \`ours-mcp watch "${id}"\`.`,
    launchNote: name => `You are session ${name}.`,
    restartPrompt: (id, wl) => `Restarted. Re-bind "${id}", continue from ${wl}.`,
  },
  exitPolicy: { cleanExitIsFresh: true, fastFailSecs: 20 },
};

describe('harness registry', () => {
  it('registers and resolves adapters', () => {
    registerAdapter(fakeAdapter);
    expect(getAdapter('fake')).toBe(fakeAdapter);
    expect(knownAdapters()).toContain('fake');
  });

  it('throws for unknown ids, listing known ones', () => {
    registerAdapter(fakeAdapter);
    expect(() => getAdapter('nope')).toThrowError(/unknown harness 'nope'.*fake/);
  });
});
