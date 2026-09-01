import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  classifyFleetArgv, FleetCommandAuditStore, redactFleetArgv,
  lifecycleEventDigestBasis, renderFleetLifecycleEvent, fleetProxyCommandInventory,
  fleetProxyTopLevelInventory, validateFleetAuditBegin, validateFleetAuditFinish,
} from '../src/fleet-command-audit.js';
import { fleetWorkerEnv } from '../src/rooms-tasks/external-worker.js';
import { FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV } from '../src/fleet-proxy.js';
import {
  AGENT_LINE_MAX_CODE_POINTS, MISSION_LABEL_MAX, mandatoryConfigurationFits, missionLabel,
  renderAgentConfiguration, selectionOrigin, summarizeResolvedLaunch,
  type AgentLaunchConfiguration,
} from '../src/lifecycle-summary.js';
import { MARKDOWN_MAX_BYTES, MARKDOWN_MAX_CODE_POINTS } from '../src/rooms-tasks/markdown.js';
import { Buffer } from 'node:buffer';
import '../src/harness/claude-code.js';

describe('fleet command audit', () => {
  it('does not turn trusted internal workers into nested proxy attempts', () => {
    const env = fleetWorkerEnv({ HOME: '/safe', PATH: '/bin',
      [FLEET_PROXY_STATE_DIR_ENV]: '/state/Agent', [FLEET_PROXY_CALLER_ENV]: 'Agent' });
    expect(env).toEqual({ HOME: '/safe', PATH: '/bin' });
  });
  it('keeps the explicit task/room/template inventory in parity with Commander registrations', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/rooms-tasks/cli.ts'), 'utf8');
    for (const surface of ['template', 'task', 'room'] as const) {
      const start = source.indexOf(`export function register${surface[0]!.toUpperCase()}${surface.slice(1)}Commands`);
      const end = source.indexOf('\nexport function ', start + 1);
      const section = source.slice(start, end < 0 ? undefined : end);
      const registered = [...section.matchAll(new RegExp(`${surface}Cmd\\.command\\('([^']+)'`, 'g'))]
        .map(match => match[1]!.split(' ')[0]!)
        .filter(command => !command.startsWith('_'));
      expect([...new Set(registered)].sort()).toEqual(
        [...fleetProxyCommandInventory[surface]!].sort());
    }
  });
  it('keeps every top-level Commander command explicitly classified', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/cli.ts'), 'utf8');
    const registered = [...source.matchAll(/program\.command\('([^']+)'/g)]
      .map(match => match[1]!.split(' ')[0]!);
    for (const surface of ['template', 'task', 'room'])
      if (source.includes(`register${surface[0]!.toUpperCase()}${surface.slice(1)}Commands(program`))
        registered.push(surface);
    const inventory = [...fleetProxyTopLevelInventory.safeRead,
      ...fleetProxyTopLevelInventory.agent, ...fleetProxyTopLevelInventory.public,
      ...fleetProxyTopLevelInventory.denied,
      ...fleetProxyTopLevelInventory.hidden];
    expect([...new Set(registered)].sort()).toEqual([...new Set(inventory)].sort());
    expect(fleetProxyTopLevelInventory.aliases).toContain('man');
  });
  it.each([
    [['spawn', 'Dev', '--temp'], 'allow', 'spawn Dev'],
    [['task', 'create', '--title', 'X'], 'allow', 'task create'],
    [['task', 'work', 't'], 'allow', 'task work'],
    [['task', 'review', 't'], 'allow', 'task review'],
    [['task', 'block', 't'], 'allow', 'task block'],
    [['task', 'unblock', 't'], 'allow', 'task unblock'],
    [['task', 'done', 't'], 'allow', 'task done'],
    [['task', 'cancel', 't', 't'], 'allow', 'task cancel'],
    [['task', 'finish', 't'], 'allow', 'task finish'],
    [['room', 'create', '--name', 'R'], 'allow', 'room create'],
    [['room', 'open', 'r'], 'allow', 'room open'],
    [['room', 'members', 'r'], 'allow', 'room members'],
    [['room', 'close', 'r', 'r'], 'allow', 'room close'],
    [['room', 'delete', 'r', 'r'], 'allow', 'room delete'],
    [['template', 'list'], 'allow', 'template list'],
    [['task', '--help'], 'allow', 'task --help'],
    [['room', '-h'], 'allow', 'room -h'],
    [['template', '--help'], 'allow', 'template --help'],
    [['status', 'A'], 'allow', 'status'],
    [['-c', '/x', 'task', 'list'], 'allow', 'task list'],
    [['--configuration=/x', 'room', 'list'], 'allow', 'room list'],
    [['-c', 'task', 'task', 'list'], 'allow', 'task list'],
    [['-c/path', 'task', 'list'], 'allow', 'task list'],
    [['-c=/path', 'task', 'list'], 'allow', 'task list'],
    [['--help'], 'allow', '--help'],
    [['--version'], 'allow', '--version'],
    [['man'], 'allow', 'man'],
    [['--', 'task', 'list'], 'allow', 'task list'],
    [['down', 'A'], 'allow', 'down'],
    [['send', 'A', 'secret'], 'allow', 'send'],
    [['_run', 'A'], 'deny', '_run'],
    [['task', '_settle', 't'], 'deny', 'task _settle'],
    [['room', '_delete', 'r'], 'deny', 'room _delete'],
    [['unknown'], 'allow', 'unknown'],
    [['task', 'exfiltrate'], 'allow', 'task exfiltrate'],
    [['room', 'bogus'], 'allow', 'room bogus'],
    [[], 'unsupported', '<none>'],
  ] as const)('classifies %j', (argv, decision, command) => {
    expect(classifyFleetArgv(argv)).toMatchObject({ decision, command });
  });

  it('preserves argv shape while redacting sensitive values and inline leaves', () => {
    const argv = ['spawn', 'Δ agent', '--identity=', '--brief', '', '--brain',
      'inline:{"harness":"codex","token":"hush","nested":{"model":"gpt-test","password":"p"}}',
      '--codex-config=x=1', '--brief=multi\nline', '--brief', 'again'];
    const redacted = redactFleetArgv(argv);
    expect(redacted).toHaveLength(argv.length);
    expect(redacted.slice(0, 6)).toEqual(['spawn', 'Δ agent', '--identity=[REDACTED:empty]',
      '--brief', '[REDACTED:empty]', '--brain']);
    expect(redacted[6]).toContain('"harness":"codex"');
    expect(redacted[6]).toContain('"model":"gpt-test"');
    expect(redacted[6]).not.toContain('hush');
    expect(redacted[6]).not.toContain('password: p');
    expect(redacted.at(-1)).toBe('[REDACTED:value]');
  });

  it('redacts attached config paths and preserves untouched URLs byte-for-byte', () => {
    expect(redactFleetArgv(['task', 'start', 't', '--member', 'dev',
      '--loops-file', '/private/loops.yaml', '--no-loops']))
      .toEqual(['task', 'start', 't', '--member', 'dev', '--loops-file',
        '[REDACTED:value]', '--no-loops']);
    expect(redactFleetArgv(['spawn', '--loops-file=/private/loops.yaml']))
      .toEqual(['spawn', '--loops-file=[REDACTED:value]']);
    expect(redactFleetArgv(['-c/private', 'task', 'list']))
      .toEqual(['-c[REDACTED:value]', 'task', 'list']);
    expect(redactFleetArgv(['-c=', 'task', 'list']))
      .toEqual(['-c=[REDACTED:empty]', 'task', 'list']);
    expect(redactFleetArgv(['task', 'create', '--title', 'https://example.test']))
      .toEqual(['task', 'create', '--title', 'https://example.test']);
  });

  it('validates hostile control payloads before persistence or rendering', () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    expect(() => validateFleetAuditBegin({ requestId: id, argv: ['task', 'list'] })).not.toThrow();
    expect(() => validateFleetAuditBegin({ requestId: id, argv: Array(257).fill('x') })).toThrow();
    expect(() => validateFleetAuditBegin({ requestId: id, argv: [], extra: true })).toThrow();
    expect(() => validateFleetAuditFinish({ correlationId: id, class: 'success', effect: 'completed',
      exitCode: 0, resourceIds: { task: 'task-1' } })).not.toThrow();
    expect(() => validateFleetAuditFinish({ correlationId: id, class: 'owned', effect: 'completed' })).toThrow();
    expect(() => validateFleetAuditFinish({ correlationId: id, class: 'success', effect: 'done' })).toThrow();
    expect(() => validateFleetAuditFinish({ correlationId: id, class: 'success', effect: 'completed',
      resourceIds: { token: 'secret' } })).toThrow();
    expect(() => validateFleetAuditFinish({ correlationId: id, class: 'success', effect: 'completed',
      presentations: [{ kind: 'task', operation: 'create', id: 't1', previousState: 'active',
        newState: 'done', agents: [] }] })).toThrow();
    expect(() => validateFleetAuditFinish({ correlationId: id, class: 'success', effect: 'completed',
      presentations: [{ kind: 'room', operation: 'create', id: 'r1', previousState: 'none',
        newState: 'provisioning', participants: [], secret: 'nope' }] })).toThrow();
  });

  it('durably dedupes begin, owns correlations, and makes unfinished attempts observable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-audit-'));
    const path = join(dir, 'audit.json');
    let tick = 0;
    const deps = { now: () => new Date(`2026-01-01T00:00:0${tick++}.000Z`), uuid: () => 'corr-1' };
    const store = new FleetCommandAuditStore(path, deps);
    const first = store.begin('request-1', 'AgentA', ['task', 'list']);
    expect(store.begin('request-1', 'AgentA', ['task', 'list'])).toEqual(first);
    expect(() => store.begin('request-1', 'AgentA', ['DIFFERENT'])).toThrow(/different argv/);
    expect(store.list()).toHaveLength(1);
    expect(new FleetCommandAuditStore(path).list()[0]?.invocation).toBe('uncertain');
    store.invocation('corr-1', 'AgentA', 'delivered');
    expect(() => store.finish('corr-1', 'AgentB', {
      class: 'success', effect: 'completed', exitCode: 0,
    })).toThrow(/cross-role/);
    store.finish('corr-1', 'AgentA', {
      class: 'success', effect: 'completed', exitCode: 0, resourceIds: { task: 't1' },
    });
    expect(() => store.finish('corr-1', 'AgentA', {
      class: 'runtime', effect: 'unknown', exitCode: 9,
    })).toThrow(/conflicting/);
    store.outcome('corr-1', 'AgentA', 'uncertain');
    expect(JSON.parse(readFileSync(path, 'utf8')).attempts[0].outcome.delivery).toBe('uncertain');
    expect(() => store.outcome('corr-1', 'AgentA', 'delivered')).toThrow(/conflicting/);
  });

  it('recovers persisted sending outcomes as uncertain without replaying effects', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fleet-audit-restart-')), 'audit.json');
    const store = new FleetCommandAuditStore(path, { now: () => new Date('2026-01-01T00:00:00Z'), uuid: () => 'corr' });
    store.begin('req', 'Agent', ['task', 'list']);
    store.invocation('corr', 'Agent', 'delivered');
    store.finish('corr', 'Agent', { class: 'success', effect: 'completed', exitCode: 0 });
    const recovered = new FleetCommandAuditStore(path).list()[0]!;
    expect(recovered).toMatchObject({ invocation: 'delivered', outcome: { delivery: 'uncertain', effect: 'completed' } });
  });

  it('keeps raw argv in local diagnostics but never in lifecycle rendering', () => {
    const store = new FleetCommandAuditStore(join(mkdtempSync(join(tmpdir(), 'fleet-audit-')), 'a.json'), {
      now: () => new Date('2026-01-01T00:00:00.000Z'), uuid: () => 'corr',
    });
    const attempt = store.begin('req', 'Agent', ['task', 'create', '--brief', 'secret']);
    expect(attempt.argv).toEqual(['task', 'create', '--brief', '[REDACTED:value]']);
    const rendered = renderFleetLifecycleEvent({ kind: 'task', operation: 'created', id: 'task-1',
      previousState: 'none', newState: 'active', agents: [] });
    expect(rendered).not.toContain('argv');
    expect(rendered).not.toContain('secret');
  });

  it('renders compact deterministic Agent, Task, and Room lifecycle vocabulary', () => {
    const agent = renderFleetLifecycleEvent({ kind: 'agent_started', id: 'Dev', name: 'Dev', lifetime: 'temporary',
      brain: 'ref:brain (explicit)', role: 'inline:sha256:abcd (inherited)', harness: 'codex',
      session: 'acp', permissions: 'allow/full', parent: 'Coordinator', actionId: 'action-1', inherited: ['role'] });
    expect(agent).toContain('Agent Dev (Dev) — ready');
    expect(agent).toContain('legacy launch; resolved details unavailable');
    expect(agent).toContain('Role inline:sha256:abcd (inherited)');
    expect(agent).toContain('Brain ref:brain (explicit)');
    const task = renderFleetLifecycleEvent({ kind: 'task', operation: 'started', id: 't1', title: 'Ship Δ',
      previousState: 'backlog', newState: 'active', template: 'team@1', roomId: 'r1', list: 'default',
      agents: [{ name: 'Dev', brain: 'B', role: 'Developer', permissions: 'allow' }] });
    expect(task).toContain('backlog → active');
    expect(task).toContain('legacy launch; resolved details unavailable (Role Developer; Brain B; permissions allow)');
    const room = renderFleetLifecycleEvent({ kind: 'room', operation: 'activated', id: 'r1',
      previousState: 'provisioning', newState: 'active', taskId: 't1',
      participants: [{ name: 'Critic', id: 'cid-1', role: 'Critic' }] });
    expect(room).toContain('`Critic` (cid-1): legacy launch; resolved details unavailable (Role Critic)');
  });

  it('renders actionable failures from a closed category without exception text', () => {
    const rendered = renderFleetLifecycleEvent({ kind: 'lifecycle_failure', resource: 'Room',
      eventId: 'episode-1', id: 'room-1', state: 'closing', category: 'cleanup_failed' });
    expect(rendered).toContain('Room room-1 lifecycle failure (cleanup_failed)');
    expect(rendered).toContain('run Room recover');
    expect(rendered).not.toContain('/private');
  });

  it('labels actionable pending state without calling it a failure', () => {
    const rendered = renderFleetLifecycleEvent({ kind: 'lifecycle_failure', resource: 'Room',
      eventId: 'episode-1', id: 'room-1', state: 'provisioning', category: 'provision_pending' });
    expect(rendered).toBe('⚠️ Room room-1 lifecycle pending (provision_pending); state provisioning. '
      + 'Action: Run Task or Room recover after checking member readiness.');
    expect(rendered).not.toContain('lifecycle failure');
  });

  it('separates Agent, Task, and Room failure dedupe keys with identical IDs and event IDs', () => {
    const bases = (['Agent', 'Task', 'Room'] as const).map(resource => lifecycleEventDigestBasis({
      kind: 'lifecycle_failure', resource, eventId: 'same-event', id: 'same-id', state: 'failed',
      category: 'provision_failed',
    }));
    expect(new Set(bases).size).toBe(3);
    expect(bases).toEqual([
      'Agent\0same-id\0same-event', 'Task\0same-id\0same-event', 'Room\0same-id\0same-event',
    ]);
  });
});

describe('human-readable launch configuration', () => {
  const named = (): AgentLaunchConfiguration => ({
    version: 1, template: 'dev-pair/critic',
    role: { kind: 'named', ref: 'reviewer' },
    brain: { kind: 'named', ref: 'codex-high' },
    harness: 'codex', session: 'acp', model: 'gpt-5', effort: 'high',
    mission: 'Challenge every material change',
    approval: 'ask', filesystem: 'workspace', unattended: 'wait',
    permissionMode: { fleetMode: 'ask', nativeMode: 'read-only' },
    monitor: { mode: 'fleet', interrupt: false },
    isolation: { requested: 'bubblewrap', network: 'broker', read_mounts: 2, write_mounts: 1 },
  });

  it('renders named presets with every resolved material setting, no hashes', () => {
    const line = renderAgentConfiguration(named());
    expect(line).toContain('template `dev-pair/critic`');
    expect(line).toContain('Role preset `reviewer`');
    expect(line).toContain('mission “Challenge every material change”');
    expect(line).toContain('Brain preset `codex-high`');
    expect(line).toContain('harness `codex`');
    expect(line).toContain('model `gpt-5`');
    expect(line).toContain('effort high');
    expect(line).toContain('approval=ask, filesystem=workspace, unattended=wait');
    expect(line).toContain('mode ask/read-only');
    expect(line).toContain('monitor fleet/false');
    expect(line).toContain('isolation requested bubblewrap, net broker, mounts +2ro/+1rw');
    expect(line).not.toContain('sha256');
  });

  it('renders inline definitions with a human label and only a short secondary fingerprint', () => {
    const config: AgentLaunchConfiguration = { ...named(), template: undefined,
      role: { kind: 'inline', fingerprint: 'a1b2c3d4e5f6' },
      brain: { kind: 'inline', fingerprint: '0f1e2d3c4b5a' }, model: null };
    const line = renderAgentConfiguration(config);
    expect(line).toContain('inline Role (def `a1b2c3d4e5f6`)');
    expect(line).toContain('inline Brain (def `0f1e2d3c4b5a`)');
    expect(line).toContain('model harness-default');
    expect(line).not.toContain('inline:sha256');
    expect(line).not.toMatch(/[a-f0-9]{16}/u);
  });

  it('renders mixed overrides: named role with an inline brain override', () => {
    const config: AgentLaunchConfiguration = { ...named(),
      brain: { kind: 'inline', fingerprint: 'abcdefabcdef' } };
    const line = renderAgentConfiguration(config);
    expect(line).toContain('Role preset `reviewer`');
    expect(line).toContain('inline Brain (def `abcdefabcdef`)');
  });

  it('renders temporary loop source, fixed policy, timing, and prompt metadata only', () => {
    const config = { ...named(), loops: {
      source: 'agent-template', policy: 'skip-if-busy', entries: [{
        name: 'progress', enabled: true, intervalMs: 60_000, initialDelayMs: 0,
        jitterMs: 30_000, prompt: { bytes: 15, sha256: 'abcdef0123456789'.padEnd(64, '0') },
        promptText: 'LOOP_PROMPT_CANARY',
      }],
    } } as AgentLaunchConfiguration;
    const line = renderAgentConfiguration(config);
    expect(line).toContain('temporary loops progress:enabled');
    expect(line).toContain('interval=60000ms delay=0ms jitter=30000ms');
    expect(line).toContain('prompt=15B/abcdef012345');
    expect(line).toContain('policy skip-if-busy');
    expect(line).toContain('source agent-template');
    expect(line).not.toContain('LOOP_PROMPT_CANARY');
  });

  it('escapes hostile Markdown in every human label', () => {
    const config: AgentLaunchConfiguration = { ...named(),
      template: 'evil`template', mission: '**bold** [link](https://x) # heading',
      role: { kind: 'named', ref: 'rev`iewer' },
      permissionMode: { fleetMode: 'ask', nativeMode: '*native* _mode_' } };
    const line = renderAgentConfiguration(config);
    expect(line).not.toContain('**bold**');
    expect(line).not.toContain('[link](https://x)');
    expect(line).toContain('\\*\\*bold\\*\\*');
    expect(line).toContain('\\*native\\* \\_mode\\_');
    // hostile backticks stay inside a longer code fence, never close it
    expect(line).toContain('``evil`template``');
    expect(line).toContain('``rev`iewer``');
  });

  it('always derives inline fingerprints canonically from the inline body', () => {
    const inline = selectionOrigin({ inline: { harness: 'codex', model: 'gpt-5' } });
    expect(inline).toMatchObject({ kind: 'inline' });
    expect((inline as { fingerprint: string }).fingerprint).toMatch(/^[a-f0-9]{12}$/u);
    // Deterministic for the same canonical body, different for a different one.
    expect(selectionOrigin({ inline: { model: 'gpt-5', harness: 'codex' } })).toEqual(inline);
    expect(selectionOrigin({ inline: { harness: 'codex' } })).not.toEqual(inline);
    expect(selectionOrigin({ ref: 'reviewer' })).toEqual({ kind: 'named', ref: 'reviewer' });
    expect(selectionOrigin(undefined)).toEqual({ kind: 'unknown' });
  });

  it('caps the mission label at eighty code points with a visible ellipsis', () => {
    expect(missionLabel(undefined)).toBeUndefined();
    expect(missionLabel('  \n\n ')).toBeUndefined();
    expect(missionLabel('first line\nsecond line')).toBe('first line');
    const long = '🛰️'.repeat(200);
    const label = missionLabel(long)!;
    expect(Array.from(label).length).toBeLessThanOrEqual(MISSION_LABEL_MAX);
    expect(label.endsWith('…')).toBe(true);
  });

  it('drops whole optional components past the per-line budget with a visible marker', () => {
    const config: AgentLaunchConfiguration = { ...named(),
      mission: 'M'.repeat(80),
      permissionMode: { fleetMode: 'ask', nativeMode: 'n'.repeat(160) },
      template: 'T'.repeat(160), model: 'm'.repeat(160) };
    const line = renderAgentConfiguration(config);
    expect(Array.from(line).length).toBeLessThanOrEqual(AGENT_LINE_MAX_CODE_POINTS + 2);
    expect(line).toContain('approval=ask');
    // mandatory components always survive; oversized optional tail is marked
    if (!line.includes('monitor')) expect(line.endsWith('; …')).toBe(true);
  });

  it('admits whole agent lines then reports an accurate omission count', () => {
    const agents = Array.from({ length: 64 }, (_, index) => ({
      name: `agent-${String(index).padStart(2, '0')}`, role: 'Member',
      configuration: { ...named(), mission: `Mission ${'🛰️'.repeat(40)}` },
    }));
    const rendered = renderFleetLifecycleEvent({ kind: 'task', operation: 'work', id: 't1',
      previousState: 'provisioning', newState: 'active', agents });
    expect(Array.from(rendered).length).toBeLessThanOrEqual(MARKDOWN_MAX_CODE_POINTS);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
    expect(rendered).toContain('- `agent-00`:');
    const note = /…and (\d+) more agents omitted\./u.exec(rendered);
    expect(note).not.toBeNull();
    const shown = [...rendered.matchAll(/- `agent-\d+`/gu)].length;
    expect(shown + Number(note![1])).toBe(64);
  });

  it('always shows at least one complete agent summary even for a maximal first line', () => {
    const big: AgentLaunchConfiguration = { ...named(),
      template: '𝕏'.repeat(160), model: '𝕐'.repeat(160), mission: '𝕄'.repeat(80),
      permissionMode: { fleetMode: 'ask', nativeMode: '𝕅'.repeat(80) } };
    const rendered = renderFleetLifecycleEvent({ kind: 'room', operation: 'activate', id: 'r1',
      previousState: 'provisioning', newState: 'active',
      participants: Array.from({ length: 3 }, (_, index) => ({
        name: `m${index}`, role: 'Member', configuration: big })) });
    expect(Array.from(rendered).length).toBeLessThanOrEqual(MARKDOWN_MAX_CODE_POINTS);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
    expect(rendered).toContain('- `m0`:');
  });

  it('accepts a complete v1 configuration through the audit finish boundary', () => {
    expect(() => validateFleetAuditFinish({ correlationId: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f',
      class: 'success', effect: 'completed', presentations: [{ kind: 'task', operation: 'work',
        eventId: 'e1', id: 't1', previousState: 'provisioning', newState: 'active',
        agents: [{ name: 'Dev', role: 'Member', configuration: named() }] }] })).not.toThrow();
  });

  it('rejects partial, unknown-key, and bad-enum v1 configurations', () => {
    const attempt = (configuration: unknown) => () => validateFleetAuditFinish({
      correlationId: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f', class: 'success', effect: 'completed',
      presentations: [{ kind: 'task', operation: 'work', eventId: 'e1', id: 't1',
        previousState: 'provisioning', newState: 'active',
        agents: [{ name: 'Dev', role: 'Member', configuration }] }] });
    const { approval: _dropped, ...partial } = named();
    expect(attempt(partial)).toThrow();                                        // missing approval
    expect(attempt({ ...named(), extra: true })).toThrow();                    // unknown key
    expect(attempt({ ...named(), filesystem: 'everything' })).toThrow();       // bad enum
    expect(attempt({ ...named(), monitor: { mode: 'psychic', interrupt: false } })).toThrow();
    expect(attempt({ ...named(), role: { kind: 'inline', fingerprint: 'XYZ' } })).toThrow();
    expect(attempt({ ...named(), role: { kind: 'inline', fingerprint: 'abcdef' } })).toThrow();  // exactly 12 hex
    expect(attempt({ ...named(), isolation: { requested: 'bubblewrap', read_mounts: -1 } })).toThrow();
    expect(attempt({ ...named(), mission: 'M'.repeat(81) })).toThrow();                          // builder cap is 80 cp
    expect(attempt({ ...named(), version: 2 })).toThrow();
  });

  it('rejects a per-field-valid configuration whose mandatory rendering cannot fit', () => {
    // Every field is within its cap, but all-backtick values more than triple
    // their code spans (the fence must outgrow the longest backtick run), so
    // the complete mandatory rendering exceeds the line budget. Such a
    // configuration must be rejected at the wire and never produced — not
    // silently trimmed of Brain/model/mode.
    const hostile: AgentLaunchConfiguration = {
      version: 1, template: '`'.repeat(160),
      role: { kind: 'named', ref: '`'.repeat(160) },
      brain: { kind: 'named', ref: '`'.repeat(160) },
      harness: '`'.repeat(64), session: 'acp', model: '`'.repeat(160),
      effort: 'e'.repeat(32), mission: '*'.repeat(80),
      approval: 'ask', filesystem: 'workspace', unattended: 'wait',
      permissionMode: { fleetMode: 'ask', nativeMode: 'n'.repeat(160) },
      monitor: { mode: 'fleet', interrupt: false },
    };
    expect(mandatoryConfigurationFits(hostile)).toBe(false);
    expect(() => validateFleetAuditFinish({ correlationId: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f',
      class: 'success', effect: 'completed', presentations: [{ kind: 'task', operation: 'work',
        eventId: 'e1', id: 't1', previousState: 'provisioning', newState: 'active',
        agents: [{ name: 'Dev', role: 'Member', configuration: hostile }] }] })).toThrow();
    const role = {
      name: 'dev', harness: 'claude-code', session: 'acp',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' },
      permissionsDeclared: true, identity: 'dev', model: '`'.repeat(160),
      sourceFile: '(temp)', monitor: { mode: 'fleet', enabled: true, wake_sources: [],
        batch_ms: 5, inject: 'x', interrupt: false, turn_fail_threshold: 1 },
    } as unknown as import('../src/config.js').ResolvedRole;
    expect(() => summarizeResolvedLaunch(role, {
      role: { kind: 'named', ref: '`'.repeat(160) },
      brain: { kind: 'named', ref: '`'.repeat(160) },
      template: '`'.repeat(160),
      permissionMode: { fleetMode: 'ask', nativeMode: 'n'.repeat(160) },
    })).toThrow(/mandatory rendering budget/u);
  });

  it('renders every mandatory component simultaneously for an accepted maximal configuration', () => {
    // Near-max but genuinely fitting: hostile backticks in one field, long
    // plain values elsewhere. The validator accepts it, so every mandatory
    // component must appear at once; only monitor/isolation may drop.
    const nearMax: AgentLaunchConfiguration = {
      version: 1, template: 'evil`template',
      role: { kind: 'named', ref: 'R'.repeat(160) },
      brain: { kind: 'named', ref: 'B'.repeat(160) },
      harness: 'h'.repeat(64), session: 'acp', model: 'm'.repeat(160),
      effort: 'e'.repeat(32), mission: '*'.repeat(80),
      approval: 'ask', filesystem: 'workspace', unattended: 'wait',
      permissionMode: { fleetMode: 'ask', nativeMode: 'n'.repeat(160) },
      monitor: { mode: 'fleet', interrupt: false },
      isolation: { requested: 'bubblewrap', network: 'broker', read_mounts: 9, write_mounts: 9 },
    };
    expect(mandatoryConfigurationFits(nearMax)).toBe(true);
    expect(() => validateFleetAuditFinish({ correlationId: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f',
      class: 'success', effect: 'completed', presentations: [{ kind: 'task', operation: 'work',
        eventId: 'e1', id: 't1', previousState: 'provisioning', newState: 'active',
        agents: [{ name: 'Dev', role: 'Member', configuration: nearMax }] }] })).not.toThrow();
    const line = renderAgentConfiguration(nearMax);
    expect(Array.from(line).length).toBeLessThanOrEqual(AGENT_LINE_MAX_CODE_POINTS);
    expect(line).toContain('template ``evil`template``');
    expect(line).toContain(`Role preset \`${'R'.repeat(160)}\``);
    expect(line).toContain(`Brain preset \`${'B'.repeat(160)}\``);
    expect(line).toContain(`harness \`${'h'.repeat(64)}\``);
    expect(line).toContain(`model \`${'m'.repeat(160)}\``);
    expect(line).toContain(`effort ${'e'.repeat(32)}`);
    expect(line).toContain('approval=ask, filesystem=workspace, unattended=wait');
    expect(line).toContain('mode ask/');
  });

  it('never overflows across the note boundary: whole-line admission sweep', () => {
    // Sweep mission padding in 1-code-point steps with near-line-budget agent
    // lines so successive renders cross every residue around the omission
    // note, including the exact 'candidate fits, candidate+note does not'
    // window that previously had an unchecked return path.
    const big = (pad: number): AgentLaunchConfiguration => ({ ...named(),
      template: '𝕏'.repeat(120), model: '𝕐'.repeat(120),
      mission: `${'𝕄'.repeat(40)}${'M'.repeat(Math.min(pad, 40))}`,
      permissionMode: { fleetMode: 'ask', nativeMode: '𝕅'.repeat(60) } });
    for (let pad = 0; pad <= 40; pad++) {
      const rendered = renderFleetLifecycleEvent({ kind: 'task', operation: 'work', id: 't1',
        previousState: 'provisioning', newState: 'active',
        agents: Array.from({ length: 8 }, (_, index) => ({
          name: `agent-${index}`, role: 'Member', configuration: big(pad) })) });
      expect(Array.from(rendered).length).toBeLessThanOrEqual(MARKDOWN_MAX_CODE_POINTS);
      expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
      const shown = [...rendered.matchAll(/- `agent-\d+`/gu)].length;
      const note = /…and (\d+) more agents? omitted\./u.exec(rendered);
      expect(shown + (note ? Number(note[1]) : 0)).toBe(8);
      expect(shown).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps accepting legacy presentations without a configuration', () => {
    expect(() => validateFleetAuditFinish({ correlationId: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f',
      class: 'success', effect: 'completed', presentations: [{ kind: 'room', operation: 'activate',
        eventId: 'e1', id: 'r1', previousState: 'provisioning', newState: 'active',
        participants: [{ name: 'Critic', id: 'cid', role: 'Critic', brain: 'legacy',
          permissions: 'approval=ask' }] }] })).not.toThrow();
  });

  it('summarizes the exact resolved launch state with the whitelist only', () => {
    const role = {
      name: 'dev-1', harness: 'claude-code', session: 'acp' as const,
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' },
      permissionsDeclared: true, identity: 'dev-1', model: 'claude-opus-5',
      effort: 'high', mission: 'Build the feature\nSecond line ignored',
      sourceFile: '(temp)', env: { SECRET: 'never' }, cwd: '/private/path',
      monitor: { mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 5, inject: 'x',
        interrupt: 'after_tool', turn_fail_threshold: 1 },
      isolation: { backend: 'podman', on_unavailable: 'strict', network: 'deny',
        fs: { read: ['/a', '/b'], write: ['/c'] } },
    } as unknown as import('../src/config.js').ResolvedRole;
    const summary = summarizeResolvedLaunch(role, {
      role: { kind: 'named', ref: 'developer' },
      brain: { kind: 'inline', fingerprint: 'abcdefabcdef' },
      template: 'squad/dev', missionFallback: 'Developer',
      permissionMode: { fleetMode: 'ask', nativeMode: 'default' },
    });
    expect(summary).toEqual({
      version: 1, template: 'squad/dev',
      role: { kind: 'named', ref: 'developer' },
      brain: { kind: 'inline', fingerprint: 'abcdefabcdef' },
      harness: 'claude-code', session: 'acp', model: 'claude-opus-5', effort: 'high',
      mission: 'Build the feature',
      approval: 'ask', filesystem: 'workspace', unattended: 'wait',
      permissionMode: { fleetMode: 'ask', nativeMode: 'default' },
      monitor: { mode: 'fleet', interrupt: 'after_tool' },
      isolation: { requested: 'podman', on_unavailable: 'strict', network: 'deny',
        read_mounts: 2, write_mounts: 1 },
    });
    expect(JSON.stringify(summary)).not.toContain('SECRET');
    expect(JSON.stringify(summary)).not.toContain('/private/path');
    const fallback = summarizeResolvedLaunch({ ...role, mission: undefined } as never, {
      role: { kind: 'unknown' }, brain: { kind: 'unknown' },
      permissionMode: { fleetMode: 'ask', nativeMode: 'default' }, missionFallback: 'Developer',
    });
    expect(fallback.mission).toBe('Developer');
  });
});
