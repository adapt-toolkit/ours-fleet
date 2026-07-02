import { describe, it, expect } from 'vitest';
import { generateBriefing } from '../src/briefing.js';
import { fakeAdapter } from './registry.test.js';
import type { ResolvedRole } from '../src/config.js';

const vocab = fakeAdapter.vocabulary;
const base: ResolvedRole = {
  name: 'Alice', harness: 'fake', identity: 'Alice Dev', sourceFile: 'x.yaml',
  persona: 'Own the Alice codebase.', mission: 'ship v1',
};
const opts = { stateDir: '/s/agents/Alice', worklogPath: '/s/agents/Alice/WORKLOG.md' };

describe('generateBriefing', () => {
  it('renders identity boot steps from the vocabulary', () => {
    const b = generateBriefing(base, vocab, opts);
    expect(b).toContain('# Alice — Role Briefing');
    expect(b).toContain('ours identity: **Alice Dev**');
    expect(b).toContain('choose_identity');
    expect(b).toContain('"Alice Dev"');
    expect(b).toContain('create_identity');
    expect(b).toContain('current_identity');
    expect(b).toContain('set_bio');
    expect(b).toContain('set_persona');
    expect(b).toContain('ours-mcp watch "Alice Dev"');
    expect(b).toContain('## Charter');
    expect(b).toContain('Own the Alice codebase.');
    expect(b).toContain('## Mission');
    expect(b).toContain('/s/agents/Alice/WORKLOG.md');
    expect(b).toContain('## On restart');
    expect(b).toContain('## House rules');
    expect(b.toLowerCase()).not.toContain('a2adapt');
  });

  it('uses bio verbatim when set, summary phrasing when not', () => {
    const withBio = generateBriefing({ ...base, bio: 'Public card here.' }, vocab, opts);
    expect(withBio).toContain('## Bio');
    expect(withBio).toContain('Public card here.');
    expect(withBio).toContain('verbatim');
    const noBio = generateBriefing(base, vocab, opts);
    expect(noBio).toContain('summary of your Charter');
  });

  it('announces to coordinator when set, owner-driven otherwise', () => {
    const c = generateBriefing({ ...base, coordinator: 'Coord' }, vocab, opts);
    expect(c).toContain('ANNOUNCE');
    expect(c).toContain('"Coord"');
    expect(c).toContain('send_message');
    const o = generateBriefing(base, vocab, opts);
    expect(o).toContain('No coordinator is configured');
  });

  it('renders oversight assignments with peek/send procedure', () => {
    const b = generateBriefing(
      { ...base, oversee: [{ role: 'Bob', interval: '5m' }] }, vocab, opts);
    expect(b).toContain('## Oversight assignments');
    expect(b).toContain('Bob');
    expect(b).toContain('every 5m');
    expect(b).toContain('ours-fleet peek Bob');
    expect(b).toContain('ours-fleet send');
  });

  it('briefingBody replaces narrative but keeps mechanical steps', () => {
    const b = generateBriefing({ ...base }, vocab, { ...opts, briefingBody: 'CUSTOM CURATED TEXT' });
    expect(b).toContain('CUSTOM CURATED TEXT');
    expect(b).not.toContain('## Charter');
    expect(b).toContain('choose_identity');   // boot steps always appended
    expect(b).toContain('## On restart');
  });
});
