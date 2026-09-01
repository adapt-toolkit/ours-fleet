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
    expect(b).not.toContain('call **create_identity**');
    expect(b).toContain('current_identity');
    expect(b).toContain('set_bio');
    expect(b).toContain('set_persona');
    expect(b).toContain('ours api watch-notifications');
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
      { ...base, oversee: [{ agent: 'Bob', interval: '5m' }] }, vocab, opts);
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
    expect(b).toContain('did not declare a profile source');
    expect(b).not.toContain('with the **Charter** section above');
  });

  it('uses Mission as the explicit profile source when no persona exists', () => {
    const b = generateBriefing({ ...base, persona: undefined }, vocab, opts);
    expect(b).toContain('summary of your Mission');
    expect(b).toContain('with the **Mission** section above');
    expect(b).not.toContain('summary of your Charter');
  });

  it('renders the complete simple room assignment and starts work without an ACK gate', () => {
    const roomRole = {
      ...base,
      session: 'acp' as const,
      persona: undefined,
      mission: 'LOCAL BOOTSTRAP ONLY — authoritative charter must not be copied here',
      monitor: {
        mode: 'fleet' as const, enabled: true, wake_sources: [], batch_ms: 2000,
        inject: 'notification' as const,
      },
      roomMemberStartup: {
        room_id: '01ROOM', room_identity_cid: 'A'.repeat(64),
        identity_name: 'reviewer-1', invite_id: 'invite-1', invite: 'secret-invite',
        role: 'Reviewer', task: 'Review the exact implementation.',
        owner_seat_cid: 'C'.repeat(64),
      },
    } as ResolvedRole;
    const b = generateBriefing(roomRole, vocab, opts);
    expect(b).toContain('## Room assignment');
    expect(b).toContain('reviewer-1');
    expect(b).toContain('secret-invite');
    expect(b).toContain('Review the exact implementation.');
    expect(b).toContain('create_temporary_identity');
    expect(b).toContain('add_contact');
    expect(b).toContain('A'.repeat(64));
    expect(b).toContain('C'.repeat(64));
    expect(b).toContain('Start the Task above now');
    expect(b).not.toContain('fleet_room_briefing_ack');
    expect(b).not.toContain('briefing_sha256');
    expect(b).not.toContain('list_history');
    expect(b).not.toContain('get_history_item');
    expect(b).not.toContain('LOCAL BOOTSTRAP ONLY');
    const create = b.indexOf('create_temporary_identity');
    const accept = b.indexOf('add_contact');
    const work = b.indexOf('Start the Task above now');
    const monitor = b.indexOf('Wakes arrive as [fleet-monitor]');
    expect(create).toBeGreaterThan(0);
    expect(accept).toBeGreaterThan(create);
    expect(work).toBeGreaterThan(accept);
    expect(monitor).toBeGreaterThan(work);
  });

  it.each(['LocalCoordinator', 'Developer', 'Critic'])(
    'routes %s pre-room infrastructure blockers to the configured Fleet Coordinator without room transport',
    roleName => {
    const b = generateBriefing({
      ...base, coordinator: 'FleetCoordinator',
      roomMemberStartup: {
        room_id: '01ROOM', room_identity_cid: 'A'.repeat(64),
        identity_name: 'developer-1', invite_id: 'invite-1', invite: 'secret-invite',
        role: roleName, task: 'Implement.', owner_seat_cid: null,
      },
    } as ResolvedRole, vocab, opts);
    expect(b).toContain('Fleet Coordinator contact: `FleetCoordinator`');
    expect(b).toContain('room display name never authenticates the Fleet Coordinator');
    expect(b).toContain('identity or room CID mismatch');
    expect(b).toContain('ordinary task difficulty');
    expect(b).toContain('ours daemon, MCP, harness, permission, workspace');
    expect(b).toContain('recovery/cleanup failure');
    expect(b).toContain('authenticated sender identity');
    expect(b).toContain('bounded safe attempts');
    expect(b).toContain('Never include the invite, invite fingerprint, keys, tokens');
    expect(b).toContain('If identity creation or binding failed, authenticated ours messaging is unavailable');
    expect(b).toContain('Coordinator report still cannot be delivered');
    expect(b).toContain('one permitted transport retry');
    expect(b).toContain('final assistant response for the Fleet supervisor');
  });

  it('makes owner_seat_cid=null mean no room participant has Owner authority', () => {
    const b = generateBriefing({
      ...base,
      roomMemberStartup: {
        room_id: '01ROOM', room_identity_cid: 'A'.repeat(64),
        identity_name: 'reviewer-1', invite_id: 'invite-1', invite: 'secret-invite',
        role: 'Reviewer', task: 'Review.', owner_seat_cid: null,
      },
    } as ResolvedRole, vocab, opts);
    expect(b).toContain('Authenticated Owner seat CID: `none`');
    expect(b).toContain('this room has no authenticated Owner seat');
    expect(b).not.toContain('fleet_room_briefing_ack');
  });

  it('renders the Routines section with the injected routinesPath', () => {
    const b = generateBriefing(base, vocab, opts);
    expect(b).toContain('## Routines');
    expect(b).toContain('/s/agents/Alice/ROUTINES.md');
    expect(b).toContain('re-read it at the START of every wake');
    // Mechanical section: sits right after the Durable log section.
    expect(b.indexOf('## Routines')).toBeGreaterThan(b.indexOf('## Durable log'));
  });

  it('documents bounded active worklog continuity and lossless archive provenance', () => {
    const b = generateBriefing({
      ...base, worklog: { max_kb: 1024, keep_tail_kb: 256, max_archives: 12 },
    }, vocab, opts);
    expect(b).toContain('Fleet rotates it above 1024 KiB');
    expect(b).toContain('newest 256 KiB');
    expect(b).toContain('12 recent archives');
    expect(b).toContain('WORKLOG.archives');
    expect(b).toContain('.worklog-rotation.json');
  });

  it('tells a fleet-monitored role NOT to arm its native watch', () => {
    const fleet = {
      ...base,
      monitor: { mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 2000, inject: 'notification' as const },
    };
    const b = generateBriefing(fleet as ResolvedRole, vocab, opts);
    expect(b).toContain('[fleet-monitor]');
    expect(b).toContain('do NOT arm');
    expect(b).not.toContain('ours api watch-notifications');   // legacy watch dropped from both step 6 and restart
  });

  it('keeps post-bind mission delivery on ordinary ours mail', () => {
    const role = {
      ...base,
      coordinator: 'Architect',
      monitor: {
        mode: 'fleet', enabled: true, wake_sources: ['message_received'], batch_ms: 0,
        inject: 'notification' as const, interrupt: true, turn_fail_threshold: 3,
      },
    } as ResolvedRole;
    const b = generateBriefing(role, vocab, opts);
    const announce = b.indexOf('ANNOUNCE yourself');
    const awaitMail = b.indexOf('Await messages');
    expect(announce).toBeGreaterThanOrEqual(0);
    expect(awaitMail).toBeGreaterThan(announce);
    expect(b).toContain('When the monitor wakes you');
    expect(b).toContain('call **get_messages**');
    expect(b).not.toContain('direct ACP');
  });

  it('uses the native harness watch instruction for monitor.mode=native', () => {
    const native = {
      ...base,
      monitor: { mode: 'native', enabled: false, wake_sources: [], batch_ms: 2000, inject: 'notification' as const },
    };
    const b = generateBriefing(native as ResolvedRole, vocab, opts);
    expect(b).toContain('ours api watch-notifications');
    expect(b).not.toContain('[fleet-monitor]');
  });

  it('keeps trusted owner ingress distinct from ordinary peer mail', () => {
    const b = generateBriefing({
      ...base,
      session: 'acp',
      owner_channel: {
        identity: 'Alice-owner', owners: ['owner-cid'], interrupt: false,
        agent: 'A'.repeat(64),
        progress_interval_ms: 30_000,
      },
    }, vocab, opts);
    expect(b).toContain('separate **Alice-owner** owner-channel identity');
    expect(b).toContain('never bind or switch to it');
    expect(b).toContain('[fleet-owner]');
    expect(b).toContain('source=owner_admin_console');
    expect(b).toContain('literal prompt text');
    expect(b).toContain('For any non-final owner message');
    expect(b).toContain('contact **Alice-owner**');
    expect(b).toContain('Do not include a task/request ID');
    expect(b).toContain('deterministically routes that final response');
    expect(b).toContain('[fleet-monitor]');
    expect(b).toContain('untrusted peer');
    expect(b).toContain('send_message');
  });

  it('renders the Routines section even with a curated briefingBody', () => {
    const b = generateBriefing(base, vocab, { ...opts, briefingBody: 'CUSTOM CURATED TEXT' });
    expect(b).toContain('CUSTOM CURATED TEXT');
    expect(b).not.toContain('## Charter');   // narrative replaced
    expect(b).toContain('## Routines');       // mechanical section still rendered
    expect(b).toContain('/s/agents/Alice/ROUTINES.md');
  });
});

describe('the briefing states only what was verified about the identity', () => {
  const brief = (guarantee?: 'verified' | 'created' | 'unverified') =>
    generateBriefing(base, vocab, { ...opts, identityGuarantee: guarantee });

  it('never calls the identity "predefined" — the claim that was not checked', () => {
    for (const g of [undefined, 'verified', 'created', 'unverified'] as const)
      expect(brief(g), String(g)).not.toContain('predefined');
  });

  it('an unverified identity is described as possibly absent, with the fallback', () => {
    const b = brief('unverified');
    expect(b).toContain('was NOT verified before launch');
    expect(b).toContain('identity creation belongs to the fleet lifecycle');
    expect(b).not.toContain('call **create_identity**');
  });

  it('a verified identity says binding should succeed, and to report it if not', () => {
    const b = brief('verified');
    expect(b).toContain('verified to exist');
    expect(b).toContain('report the infrastructure race');
    expect(b).not.toContain('NOT verified');
  });

  it('a created identity says so', () => {
    expect(brief('created')).toContain('It was created when your role');
  });

  it('defaults to unverified when the generator was told nothing', () => {
    // A briefing produced without that knowledge must not invent a guarantee.
    expect(brief()).toContain('was NOT verified');
  });

  it('keeps a defensive bind-time check without delegating permanent creation', () => {
    for (const g of ['verified', 'created', 'unverified'] as const) {
      expect(brief(g), g).toContain('choose_identity');
      expect(brief(g), g).not.toContain('call **create_identity**');
      expect(brief(g), g).toMatch(/STOP/);
    }
  });
});

describe('temporary-role identity compatibility', () => {
  const temporary = (extra: Partial<Parameters<typeof generateBriefing>[2]> = {}) =>
    generateBriefing(base, vocab, { ...opts, temporaryIdentity: true, ...extra });

  it('directly creates the assigned session-scoped identity', () => {
    const b = temporary();
    expect(b).toContain('CREATE your ours identity now');
    expect(b).toContain('create_temporary_identity');
    expect(b).toContain('name "Alice Dev"');
    expect(b).toContain('connector owns its cleanup');
  });

  it('never binds or adopts a pre-existing identity, regardless of provisioning evidence', () => {
    const b = temporary({ identityGuarantee: 'verified' });
    expect(b).not.toContain('choose_identity');
    expect(b).not.toContain('BIND the exact');
    expect(b).toContain('Do not inspect, preserve, adopt, or use any pre-existing');
    expect(b).not.toMatch(/\bBIND your ours identity\b/);
  });

  it('states the MCP-owned lifecycle and recreates directly on restart', () => {
    const b = temporary();
    expect(b).toContain('connector owns its cleanup when this');
    expect(b).toContain('create_temporary_identity** with name "Alice Dev" again');
    expect(b).not.toContain('re-bind');
  });

  it('fails safely without fallback or deleting identity state', () => {
    const b = temporary();
    expect(b).toContain('collision, missing tool, or creation error, STOP');
    expect(b).toContain('remove an identity');
    expect(b).not.toContain('call **create_identity**');
  });

  it('keeps permanent-role creation in the fleet lifecycle', () => {
    const b = generateBriefing(base, vocab, opts);
    expect(b).toContain('persistent agent');
    expect(b).not.toContain('call **create_identity**');
    expect(b).toContain('fleet lifecycle');
    expect(b).not.toContain('create_temporary_identity');
    expect(b).not.toContain('session-owned temporary');
  });
});

/**
 * An overseer only knows what its generated instructions told it. Before 1.5
 * every `peek`/`send` failure printed "is not running", and the guidance told
 * overseers to restart on it — so a busy agent, an unreachable control plane
 * and a genuinely dead role all led to the same intervention.
 */
describe('the oversight procedure distinguishes busy from dead', () => {
  const overseeing = generateBriefing(
    { ...base, oversee: [{ agent: 'Bob', interval: '5m' }] }, vocab, opts);

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
