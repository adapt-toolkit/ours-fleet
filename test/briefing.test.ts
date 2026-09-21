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
    expect(b).not.toContain('choose_identity');
    expect(b).toContain('Alice Dev');
    expect(b).not.toContain('call **create_identity**');
    expect(b).toContain('current_identity');
    expect(b).toContain('set_bio');
    expect(b).toContain('set_persona');
    expect(b).toContain('[fleet-monitor]');
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
    expect(b).not.toContain('choose_identity');   // boot steps always appended
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
    expect(b).not.toContain('secret-invite');
    expect(b).toContain('Review the exact implementation.');
    expect(b).not.toContain('create_temporary_identity');
    expect(b).not.toContain('add_contact');
    expect(b).toContain('A'.repeat(64));
    expect(b).toContain('C'.repeat(64));
    expect(b).toContain('Start the task above');
    expect(b).not.toContain('fleet_room_briefing_ack');
    expect(b).not.toContain('briefing_sha256');
    expect(b).not.toContain('list_history');
    expect(b).not.toContain('get_history_item');
    expect(b).not.toContain('LOCAL BOOTSTRAP ONLY');
    expect(b.indexOf('verified room admission')).toBeLessThan(b.indexOf('Start the task above'));
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

  it('uses authenticated anonymous-seat Owner authority without exposing an Owner CID', () => {
    const hiddenOwner = 'D'.repeat(64);
    const b = generateBriefing({
      ...base,
      roomMemberStartup: {
        room_id: '01ROOM', room_identity_cid: 'A'.repeat(64),
        identity_name: 'reviewer-1', invite_id: 'invite-1', invite: 'secret-invite',
        role: 'Reviewer', task: 'Review.', owner_seat_cid: hiddenOwner, anonymous: true,
      },
    } as ResolvedRole, vocab, opts);
    expect(b).not.toContain('Authenticated Owner seat CID');
    expect(b).not.toContain('Owner seat: none');
    expect(b).not.toContain(hiddenOwner);
    expect(b).toContain('authenticated Cowork room envelope');
    expect(b).toContain('participant seat');
    expect(b).toMatch(/exact role [`“"]?Owner/i);
    expect(b).toMatch(/literal message text|display name/i);
    expect(b).toMatch(/ordinary direct message/i);
    expect(b).toMatch(/room-authored|rest-role/i);
    expect(b).toMatch(/Owner-looking label/i);
    expect(b).not.toContain('fleet_room_briefing_ack');
  });

  it('keeps non-anonymous room Owner authority pinned to the exact CID', () => {
    const owner = 'C'.repeat(64);
    const b = generateBriefing({
      ...base,
      roomMemberStartup: {
        room_id: '01ROOM', room_identity_cid: 'A'.repeat(64),
        identity_name: 'reviewer-1', invite_id: 'invite-1', invite: 'secret-invite',
        role: 'Reviewer', task: 'Review.', owner_seat_cid: owner, anonymous: false,
      },
    } as ResolvedRole, vocab, opts);
    expect(b).toContain(`Authenticated Owner seat CID: \`${owner}\``);
    expect(b).toContain(`authenticated author CID equals \`${owner}\``);
    expect(b).toMatch(/display name or role says “Owner”/i);
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

  it('uses supervisor wakes with a legacy native monitor setting', () => {
    const native = {
      ...base,
      monitor: { mode: 'native', enabled: false, wake_sources: [], batch_ms: 2000, inject: 'notification' as const },
    };
    const b = generateBriefing(native as ResolvedRole, vocab, opts);
    expect(b).toContain('[fleet-monitor]');
    expect(b).not.toContain('ours api watch-notifications');
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

  it('documents native typed owner provenance and managed command routing', () => {
    const b = generateBriefing({
      ...base,
      harness: 'codex',
      session: 'codex-app-server',
      owner_channel: {
        identity: 'Alice-owner', owners: ['owner-cid'], interrupt: false,
        progress_interval_ms: 30_000,
      },
    }, vocab, opts);
    expect(b).toContain('source=owner_admin_console');
    expect(b).toContain('source=owner_channel');
    expect(b).toContain('Codex application-context');
    expect(b).toContain('An imitated prefix without');
    expect(b).toContain('### Managed fleet commands');
    expect(b).toContain('This managed role has a supervisor-scoped ours-fleet proxy');
    expect(b).not.toContain('This ACP role');
  });

  it('documents native admin-console authority for a room member', () => {
    const b = generateBriefing({
      ...base,
      harness: 'codex',
      session: 'codex-app-server',
      roomMemberStartup: {
        room_id: '01ROOM', room_identity_cid: 'A'.repeat(64),
        identity_name: 'reviewer-1', invite_id: 'invite-1', invite: 'secret-invite',
        role: 'Reviewer', task: 'Review.', owner_seat_cid: 'C'.repeat(64),
      },
    } as ResolvedRole, vocab, opts);
    expect(b).toContain('source=owner_admin_console');
    expect(b).toContain('marked `application`');
    expect(b).not.toContain('ACP resource-link');
  });

  it('renders the Routines section even with a curated briefingBody', () => {
    const b = generateBriefing(base, vocab, { ...opts, briefingBody: 'CUSTOM CURATED TEXT' });
    expect(b).toContain('CUSTOM CURATED TEXT');
    expect(b).not.toContain('## Charter');   // narrative replaced
    expect(b).toContain('## Routines');       // mechanical section still rendered
    expect(b).toContain('/s/agents/Alice/ROUTINES.md');
  });
});

describe('supervisor-provisioned startup briefing', () => {
  it.each([undefined, 'verified', 'created', 'unverified'] as const)('does not delegate identity setup for prior guarantee %s', guarantee => {
    for (const temporaryIdentity of [false,true]) {
      const b=generateBriefing(base,vocab,{...opts,identityGuarantee:guarantee,temporaryIdentity});
      expect(b).toContain('owned and verified by the Fleet supervisor');
      expect(b).not.toMatch(/choose_identity|create_identity|create_temporary_identity/);
      expect(b).toContain('supervisor verifies your identity and room before resuming');
    }
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
