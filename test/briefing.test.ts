import { describe, it, expect } from 'vitest';
import { generateBriefing } from '../src/briefing.js';
import { livenessNote, oversightTaxonomy, oversightTaxonomyLines } from '../src/session/control.js';
import { fakeAdapter } from './registry.test.js';
import type { ResolvedRole } from '../src/config.js';
import type { ControlFailureKind } from '../src/session/types.js';

const vocab = fakeAdapter.vocabulary;
const base: ResolvedRole = {
  name: 'Alice', harness: 'fake', identity: 'Alice Dev', sourceFile: 'x.yaml',
  persona: 'Own the Alice codebase.', mission: 'ship v1',
};
const opts = {
  stateDir: '/s/agents/Alice',
  worklogPath: '/s/agents/Alice/WORKLOG.md',
  routinesPath: '/s/agents/Alice/ROUTINES.md',
};

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
    expect(b).toContain('ours-fleet status Bob');
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

  it('renders the Routines section with the injected routinesPath', () => {
    const b = generateBriefing(base, vocab, opts);
    expect(b).toContain('## Routines');
    expect(b).toContain('/s/agents/Alice/ROUTINES.md');
    expect(b).toContain('re-read it at the START of every wake');
    // Mechanical section: sits right after the Durable log section.
    expect(b.indexOf('## Routines')).toBeGreaterThan(b.indexOf('## Durable log'));
  });

  it('tells a supervised (monitor.enabled) role NOT to arm its own watch', () => {
    const enabled = { ...base, monitor: { enabled: true, wake_sources: [], batch_ms: 2000, inject: 'notification' as const } };
    const b = generateBriefing(enabled as ResolvedRole, vocab, opts);
    expect(b).toContain('[fleet-monitor]');
    expect(b).toContain('do NOT arm');
    expect(b).not.toContain('ours-mcp watch');   // legacy watch dropped from both step 6 and restart
  });

  it('keeps the legacy watch instruction for a monitor.enabled=false role', () => {
    const disabled = { ...base, monitor: { enabled: false, wake_sources: [], batch_ms: 2000, inject: 'notification' as const } };
    const b = generateBriefing(disabled as ResolvedRole, vocab, opts);
    expect(b).toContain('ours-mcp watch "Alice Dev"');
    expect(b).not.toContain('[fleet-monitor]');
  });

  it('renders the Routines section even with a curated briefingBody', () => {
    const b = generateBriefing(base, vocab, { ...opts, briefingBody: 'CUSTOM CURATED TEXT' });
    expect(b).toContain('CUSTOM CURATED TEXT');
    expect(b).not.toContain('## Charter');   // narrative replaced
    expect(b).toContain('## Routines');       // mechanical section still rendered
    expect(b).toContain('/s/agents/Alice/ROUTINES.md');
  });
});

describe('the briefing states only what was verified about the identity (7.3)', () => {
  const brief = (guarantee?: 'verified' | 'created' | 'unverified') =>
    generateBriefing(base, vocab, { ...opts, identityGuarantee: guarantee });

  it('never calls the identity "predefined" — the claim that was not checked', () => {
    for (const g of [undefined, 'verified', 'created', 'unverified'] as const)
      expect(brief(g), String(g)).not.toContain('predefined');
  });

  it('an unverified identity is described as possibly absent, with the fallback', () => {
    const b = brief('unverified');
    expect(b).toContain('was NOT verified when your role was created');
    expect(b).toContain('create_identity');
  });

  it('a verified identity says binding should succeed, and to report it if not', () => {
    const b = brief('verified');
    expect(b).toContain('verified to exist');
    expect(b).toContain('report the discrepancy');
    expect(b).not.toContain('NOT verified');
  });

  it('a created identity says so', () => {
    expect(brief('created')).toContain('It was created when your role');
  });

  it('defaults to unverified when the generator was told nothing', () => {
    // A briefing produced without that knowledge must not invent a guarantee.
    expect(brief()).toContain('was NOT verified');
  });

  it('keeps a defensive bind-time check in every case', () => {
    for (const g of ['verified', 'created', 'unverified'] as const) {
      expect(brief(g), g).toContain('choose_identity');
      expect(brief(g), g).toContain('create_identity');
    }
  });
});

/**
 * An overseer only knows what its generated instructions told it. Before 1.5
 * every `peek`/`send` failure printed "is not running", and the guidance told
 * overseers to restart on it — so a busy agent, an unreachable control plane
 * and a genuinely dead role all led to the same intervention.
 */
describe('the oversight procedure distinguishes busy from dead (7.2)', () => {
  const overseeing = generateBriefing(
    { ...base, oversee: [{ role: 'Bob', interval: '5m' }] }, vocab, opts);

  it('carries the taxonomy verbatim from its single definition', () => {
    // Not a paraphrase: the exact lines the CLI's own wording produces.
    for (const line of oversightTaxonomyLines()) expect(overseeing).toContain(line);
  });

  it('tells the overseer to combine status with peek, not to judge on one', () => {
    expect(overseeing).toContain('One console command is not a liveness verdict');
    expect(overseeing).toContain('ours-fleet status Bob');
    expect(overseeing).toContain('ours-fleet peek Bob');
    expect(overseeing).not.toContain('crashed to a shell →\ninvestigate and restart');
  });

  /**
   * Table-driven over every result an overseer can actually receive: what each
   * one means must come from `livenessNote`, so the instructions and the CLI
   * output cannot say different things about the same failure.
   */
  const SCENARIOS: Array<{ role: string; result: 'queued' | ControlFailureKind; restart: boolean }> = [
    { role: 'busy — a long turn in progress', result: 'timeout', restart: false },
    { role: 'busy — prompt accepted behind a running turn', result: 'queued', restart: false },
    { role: 'modal — waiting on a dialog it cannot answer', result: 'control-unavailable', restart: false },
    { role: 'rejected — the session refused the request', result: 'rejected', restart: false },
    { role: 'transport broke', result: 'backend', restart: false },
    { role: 'dead — the session is gone', result: 'offline', restart: true },
  ];

  for (const s of SCENARIOS) {
    it(`${s.role}: the briefing states what '${s.result}' proves`, () => {
      const entry = oversightTaxonomy().find(r => r.result === s.result)!;
      expect(entry, s.result).toBeDefined();
      expect(overseeing).toContain(entry.meaning);
      expect(entry.restartJustified, s.result).toBe(s.restart);
      if (s.result !== 'queued')
        // The meaning is the CLI's own note, not a second wording of it.
        expect(entry.meaning).toBe(livenessNote(s.result as ControlFailureKind, '<Name>'));
    });
  }

  it('exactly one result justifies a restart, and it is the confirmed stop', () => {
    // The overseer scenario the spec asks for, as an invariant rather than a
    // reading of prose: a busy role is left alone because nothing but `offline`
    // authorises touching it.
    const justified = oversightTaxonomy().filter(r => r.restartJustified);
    expect(justified.map(r => r.result)).toEqual(['offline']);
  });

  it('covers every control failure kind the CLI can report', () => {
    // A kind added to ControlFailureKind without a taxonomy entry would leave
    // an overseer with a result its instructions never mention.
    const KINDS: ControlFailureKind[] =
      ['offline', 'control-unavailable', 'timeout', 'rejected', 'backend'];
    const covered = oversightTaxonomy().map(r => r.result);
    for (const kind of KINDS) expect(covered, kind).toContain(kind);
    expect(covered).toContain('queued');
  });

  it('a role with no wards gets no oversight procedure at all', () => {
    expect(generateBriefing(base, vocab, opts)).not.toContain('One console command');
  });
});
