import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  beginFleetAuditCollection, checkpointFleetAuditPresentations, classifyFleetArgv,
  consumeFleetAuditCollection, FleetCommandAuditStore, fleetPresentationLabel,
  recordFleetAuditPresentation, redactFleetArgv,
  lifecycleEventDigestBasis, renderFleetLifecycleEvent, fleetProxyCommandInventory,
  fleetProxyTopLevelInventory, setFleetAuditLifecycleCheckpoint,
  validateFleetAuditBegin, validateFleetAuditFinish,
} from '../src/fleet-command-audit.js';
import {
  FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV, fleetWorkerEnv,
} from '../src/rooms-tasks/external-worker.js';
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
  it('checkpoints created before readiness and removes the event from the final batch', async () => {
    const delivered: string[][] = [];
    beginFleetAuditCollection();
    setFleetAuditLifecycleCheckpoint(async presentations => {
      delivered.push(presentations.map(event => `${event.kind}:${event.eventId}`));
    });
    recordFleetAuditPresentation({ kind: 'room', operation: 'create',
      eventId: 'room-created:2026-01-01T00:00:00.000Z', id: 'room-1', name: 'Room',
      previousState: 'none', newState: 'provisioning', participants: [] });
    await checkpointFleetAuditPresentations();
    expect(delivered).toEqual([['room:room-created:2026-01-01T00:00:00.000Z']]);
    expect(consumeFleetAuditCollection().presentations).toBeUndefined();
    setFleetAuditLifecycleCheckpoint(undefined);
  });

  it('dedupes canonical lifecycle events within one command collection', () => {
    beginFleetAuditCollection();
    const event = { kind: 'room' as const, operation: 'activate' as const,
      eventId: 'room-ready:2026-01-01T00:00:01.000Z', id: 'room-1', name: 'Room',
      previousState: 'provisioning', newState: 'active', participants: [] };
    recordFleetAuditPresentation(event);
    recordFleetAuditPresentation(event);
    expect(consumeFleetAuditCollection().presentations).toEqual([expect.objectContaining(event)]);
  });
  it('does not turn trusted internal workers into nested proxy attempts', () => {
    const env = fleetWorkerEnv({ HOME: '/safe', PATH: '/bin',
      [FLEET_PROXY_STATE_DIR_ENV]: '/state/Agent', [FLEET_PROXY_CALLER_ENV]: 'Agent' });
    expect(env).toEqual({ HOME: '/safe', PATH: '/bin',
      [FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV]: '/state/Agent' });
    expect(env).not.toHaveProperty(FLEET_PROXY_STATE_DIR_ENV);
    expect(env).not.toHaveProperty(FLEET_PROXY_CALLER_ENV);
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

  it('pins the approved multiline Owner lifecycle copy exactly', () => {
    const task = (operation: 'create' | 'work' | 'block' | 'unblock' | 'review' | 'finish' | 'cancel' | 'delete',
      newState: string, extra: Record<string, unknown> = {}) => renderFleetLifecycleEvent({
      kind: 'task', operation, eventId: `${operation}-1`, id: 'T-104', title: 'Inventory API',
      previousState: operation === 'create' ? 'none' : 'active', newState, list: 'Product',
      agents: [{ name: 'Dev', role: 'Developer' }], ...extra,
    } as Parameters<typeof renderFleetLifecycleEvent>[0]);
    const failure = (resource: 'Agent' | 'Task' | 'Room', category:
      'provision_failed' | 'provision_pending' | 'readiness_failed' | 'settlement_pending' | 'cleanup_failed',
    ) => renderFleetLifecycleEvent({ kind: 'lifecycle_failure', resource, category,
      eventId: `${category}-1`, id: resource === 'Task' ? 'T-104' : resource === 'Room' ? 'R-219' : 'acme-developer-1',
      label: resource === 'Task' ? 'Inventory API' : resource === 'Room' ? 'Release planning' : 'acme-developer-1',
      state: category.startsWith('provision') ? 'provisioning' : 'pending' });
    const outputs = {
      agent: renderFleetLifecycleEvent({ kind: 'agent_started', eventId: 'launch-1', id: 'acme-developer-1',
        name: 'acme-developer-1', lifetime: 'temporary', brain: 'default', role: 'Developer', harness: 'codex',
        session: 'acp', parent: 'Coordinator', actionId: 'launch-1', inherited: [], configuration: {
          version: 1, template: 'coding', role: { kind: 'named', ref: 'Developer' },
          brain: { kind: 'named', ref: 'default' }, harness: 'codex', session: 'acp', model: 'gpt-5',
          effort: 'high', mission: 'Implement the inventory API', approval: 'ask', filesystem: 'workspace',
          unattended: 'wait', permissionMode: { fleetMode: 'auto', nativeMode: 'workspace-write' },
          monitor: { mode: 'fleet', interrupt: false },
          isolation: { requested: 'podman', network: 'deny', on_unavailable: 'strict', read_mounts: 2, write_mounts: 1 },
          loops: { source: 'agent-template', policy: 'skip-if-busy', entries: [{ name: 'status-check', enabled: true,
            intervalMs: 60_000, initialDelayMs: 5_000, jitterMs: 2_000,
            prompt: { bytes: 184, sha256: 'a1b2c3d4e5f6'.padEnd(64, '0') } }] },
        } }),
      taskBacklog: task('create', 'backlog', { template: 'coding' }),
      taskStarted: task('work', 'active', { previousState: 'provisioning', roomId: 'R-218', roomName: 'Inventory API' }),
      taskBlocked: task('block', 'active', { reason: 'Waiting for API credentials' }),
      taskUnblocked: task('unblock', 'active'),
      taskReview: task('review', 'review'),
      taskCompleted: task('finish', 'done'),
      taskCancelled: task('cancel', 'cancelled'),
      taskDeletionStarted: task('delete', 'deleting'),
      roomReady: renderFleetLifecycleEvent({ kind: 'room', operation: 'activate', eventId: 'ready-1', id: 'R-219',
        name: 'Release planning', previousState: 'provisioning', newState: 'active', template: 'planning',
        memberCount: 3, participants: [] }),
      roomDeleted: renderFleetLifecycleEvent({ kind: 'room', operation: 'delete', eventId: 'deleted-1', id: 'R-219',
        name: 'Release planning', previousState: 'closing', newState: 'deleted', participants: [] }),
      taskProvisionFailed: failure('Task', 'provision_failed'),
      taskProvisionPending: failure('Task', 'provision_pending'),
      agentReadinessFailed: failure('Agent', 'readiness_failed'),
      taskCleanupPending: failure('Task', 'settlement_pending'),
      roomCleanupFailed: failure('Room', 'cleanup_failed'),
    };
    for (const line of Object.values(outputs).flatMap(output => output.split('\n'))
      .filter(line => line.startsWith('- **')))
      expect(line).not.toMatch(/[;·|]/u);
    expect(outputs).toMatchInlineSnapshot(`
      {
        "agent": "🚀 Agent launched: acme-developer-1
      - **Started by:** Coordinator
      - **Lifetime:** Temporary
      - **Template:** \`coding\`
      - **Role:** Preset \`Developer\`
      - **Mission:** “Implement the inventory API”
      - **Brain:** Preset \`default\`
      - **Harness:** \`codex\`
      - **Model:** \`gpt-5\`
      - **Effort:** high
      - **Approval:** ask
      - **Filesystem:** workspace
      - **Wait:** wait
      - **Fleet mode:** auto
      - **Native mode:** workspace-write
      - **Monitor mode:** fleet
      - **Interrupt:** off
      - **Isolation:** podman
      - **Network:** deny
      - **If unavailable:** Fail
      - **Read-only mounts:** 2
      - **Read-write mounts:** 1
      - **Loop:** \`status-check\`
      - **Loop status:** Enabled
      - **Loop interval:** 60,000 ms
      - **Loop delay:** 5,000 ms
      - **Loop jitter:** 2,000 ms
      - **Loop prompt size:** 184 B
      - **Loop prompt hash:** \`a1b2c3d4e5f6\`
      - **Loop policy:** Skip if busy
      - **Loop source:** agent template
      - **Agent ID:** \`acme-developer-1\`

      Launch was accepted; harness and room-seat readiness converge separately.",
        "agentReadinessFailed": "⚠️ Agent didn’t become ready: acme-developer-1
      - **Status:** Readiness failed
      - **Agent ID:** \`acme-developer-1\`

      **Next:** Check the Agent log, correct its configuration, then create it again.",
        "roomCleanupFailed": "⚠️ Room cleanup is incomplete: Release planning
      - **Status:** Deletion pending
      - **Room ID:** \`R-219\`

      **Next:** Check the Fleet service logs, then repeat the same confirmed Room delete command.",
        "roomDeleted": "🗑️ Room deleted: Release planning
      - **Room ID:** \`R-219\`

      Temporary Agents were cleaned up.",
        "roomReady": "🏠 Room ready: Release planning
      - **Status:** Active
      - **Template:** \`planning\`
      - **Team:** 3 Agents ready
      - **Room ID:** \`R-219\`",
        "taskBacklog": "✅ Task added to Backlog
      - **Task:** “Inventory API”
      - **Task ID:** \`T-104\`
      - **List:** Product
      - **Template:** \`coding\`",
        "taskBlocked": "⛔ Task blocked: Inventory API
      - **Status:** Active
      - **Blocked:** Yes
      - **Reason:** Waiting for API credentials
      - **Task ID:** \`T-104\`",
        "taskCancelled": "🚫 Task cancelled: Inventory API
      - **Status:** Cancelled
      - **List:** Product
      - **Task ID:** \`T-104\`

      The task room and temporary Agents have been cleaned up.",
        "taskCleanupPending": "⚠️ Task cleanup is incomplete: Inventory API
      - **Status:** Finish pending
      - **Task ID:** \`T-104\`

      **Next:** Check the Fleet service logs, then repeat the same \`done\`, \`finish\`, or \`cancel\` command.",
        "taskCompleted": "🎉 Task completed: Inventory API
      - **Status:** Done
      - **List:** Product
      - **Task ID:** \`T-104\`

      The task room and temporary Agents have been cleaned up.",
        "taskDeletionStarted": "🗑️ Task deletion started: Inventory API
      - **Current status:** Deleting
      - **Task ID:** \`T-104\`

      Fleet is removing the linked room and temporary Agents in the background.",
        "taskProvisionFailed": "⚠️ Couldn’t prepare Task “Inventory API”
      - **Status:** Provisioning failed
      - **Resource:** Task
      - **Task ID:** \`T-104\`

      **Next:** Check the Fleet service logs, correct the configuration, then run the same start command again.",
        "taskProvisionPending": "⏳ Task “Inventory API” is still getting ready
      - **Status:** Waiting for Agents
      - **Resource:** Task
      - **Task ID:** \`T-104\`

      **Next:** Check member readiness, then run \`task await T-104\`.",
        "taskReview": "🔎 Task ready for review: Inventory API
      - **List:** Product
      - **Task ID:** \`T-104\`",
        "taskStarted": "🚀 Task started: Inventory API
      - **Status:** Active
      - **List:** Product
      - **Room:** Inventory API
      - **Room ID:** \`R-218\`
      - **Team:** 1 Agent ready
      - **Task ID:** \`T-104\`

      The task room and its Agents are ready to work.",
        "taskUnblocked": "✅ Task unblocked: Inventory API
      - **Status:** Active
      - **Task ID:** \`T-104\`",
      }
    `);
  });

  it('captures bounded sanitized labels at record time and falls back for legacy events', () => {
    const hostile = `  Inventory\nAPI\u202e${'🛰️'.repeat(200)}  `;
    const label = fleetPresentationLabel(hostile)!;
    expect(label).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    expect(Array.from(label).length).toBeLessThanOrEqual(160);
    expect(Buffer.byteLength(label, 'utf8')).toBeLessThanOrEqual(640);
    beginFleetAuditCollection();
    recordFleetAuditPresentation({ kind: 'task', operation: 'block', id: 'task-1',
      title: hostile, roomName: hostile, reason: hostile, previousState: 'active',
      newState: 'active', agents: [] });
    recordFleetAuditPresentation({ kind: 'room', operation: 'activate', id: 'room-1',
      name: hostile, previousState: 'provisioning', newState: 'active', participants: [] });
    recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Task', id: 'task-1',
      label: hostile, state: 'provisioning', category: 'provision_failed' });
    expect(consumeFleetAuditCollection().presentations).toEqual([
      expect.objectContaining({ title: label, roomName: label, reason: label }),
      expect.objectContaining({ name: label }),
      expect.objectContaining({ label }),
    ]);
    const astral = '😀'.repeat(129);
    beginFleetAuditCollection();
    recordFleetAuditPresentation({ kind: 'task', operation: 'block', id: 'task-astral',
      title: astral, roomName: astral, reason: astral,
      previousState: 'active', newState: 'active', agents: [] });
    recordFleetAuditPresentation({ kind: 'room', operation: 'activate', id: 'room-astral',
      name: astral, previousState: 'provisioning', newState: 'active', participants: [] });
    recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Task', id: 'task-astral',
      label: astral, state: 'provisioning', category: 'provision_failed' });
    const recorded = consumeFleetAuditCollection().presentations!;
    expect(recorded).toEqual([
      expect.objectContaining({ title: astral, roomName: astral, reason: astral }),
      expect.objectContaining({ name: astral }),
      expect.objectContaining({ label: astral }),
    ]);
    expect(() => validateFleetAuditFinish({ correlationId: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f',
      class: 'success', effect: 'completed', presentations: recorded })).not.toThrow();
    expect(renderFleetLifecycleEvent({ kind: 'lifecycle_failure', resource: 'Room',
      eventId: 'episode-1', id: 'room-1', state: 'closing', category: 'cleanup_failed' }))
      .toContain('Room cleanup is incomplete: room-1');
    expect(renderFleetLifecycleEvent({ kind: 'task', operation: 'review', eventId: 'review-1',
      id: 'task-legacy', previousState: 'active', newState: 'review', agents: [] }))
      .toContain('Task ready for review: task-legacy');
    expect(renderFleetLifecycleEvent({ kind: 'room', operation: 'delete', eventId: 'delete-1',
      id: 'room-legacy', previousState: 'closing', newState: 'deleted', participants: [] }))
      .toContain('Room deleted: room-legacy');
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

  it('summarizes a large task team without replaying per-Agent configuration', () => {
    const agents = Array.from({ length: 64 }, (_, index) => ({
      name: `agent-${String(index).padStart(2, '0')}`, role: 'Member',
      configuration: { ...named(), mission: `Mission ${'🛰️'.repeat(40)}` },
    }));
    const rendered = renderFleetLifecycleEvent({ kind: 'task', operation: 'work', id: 't1',
      previousState: 'provisioning', newState: 'active', agents });
    expect(Array.from(rendered).length).toBeLessThanOrEqual(MARKDOWN_MAX_CODE_POINTS);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
    expect(rendered).toContain('- **Team:** 64 Agents ready');
    expect(rendered).not.toContain('agent-00');
  });

  it('keeps the ready notice concise even when legacy participant details are present', () => {
    const big: AgentLaunchConfiguration = { ...named(),
      template: '𝕏'.repeat(160), model: '𝕐'.repeat(160), mission: '𝕄'.repeat(80),
      permissionMode: { fleetMode: 'ask', nativeMode: '𝕅'.repeat(80) } };
    const rendered = renderFleetLifecycleEvent({ kind: 'room', operation: 'activate', id: 'r1',
      previousState: 'provisioning', newState: 'active',
      participants: Array.from({ length: 3 }, (_, index) => ({
        name: `m${index}`, role: 'Member', configuration: big })) });
    expect(Array.from(rendered).length).toBeLessThanOrEqual(MARKDOWN_MAX_CODE_POINTS);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
    expect(rendered).toBe('🏠 Room ready: r1\n- **Status:** Active\n- **Team:** 3 Agents ready\n- **Room ID:** `r1`');
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

  it('never overflows while rendering a maximal multiline Agent configuration', () => {
    const big = (pad: number): AgentLaunchConfiguration => ({ ...named(),
      template: '𝕏'.repeat(120), model: '𝕐'.repeat(120),
      mission: `${'𝕄'.repeat(40)}${'M'.repeat(Math.min(pad, 40))}`,
      permissionMode: { fleetMode: 'ask', nativeMode: '𝕅'.repeat(60) } });
    for (let pad = 0; pad <= 40; pad++) {
      const rendered = renderFleetLifecycleEvent({ kind: 'agent_started', eventId: `e-${pad}`,
        id: 'agent-1', name: 'agent-1', lifetime: 'temporary', brain: 'Brain', role: 'Role',
        harness: 'codex', session: 'acp', parent: 'Coordinator', actionId: `e-${pad}`,
        inherited: [], configuration: big(pad) });
      expect(Array.from(rendered).length).toBeLessThanOrEqual(MARKDOWN_MAX_CODE_POINTS);
      expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
      expect(rendered).toContain('\n- **Role:**');
      expect(rendered).toContain('\n- **Brain:**');
    }
  });

  it('atomically bounds maximal loop details while reserving mandatory Agent output', () => {
    const configuration: AgentLaunchConfiguration = { ...named(), loops: {
      source: 'agent-template', policy: 'skip-if-busy',
      entries: Array.from({ length: 64 }, (_, index) => ({
        name: `loop-${String(index).padStart(2, '0')}-${'x'.repeat(48)}`,
        enabled: index % 2 === 0, intervalMs: 60_000 + index,
        initialDelayMs: 5_000 + index, jitterMs: 2_000 + index,
        prompt: { bytes: 184 + index, sha256: index.toString(16).padStart(64, '0') },
      })),
    } };
    const presentation = { kind: 'agent_started' as const, eventId: 'max-loops',
      id: 'agent-max-loops', name: 'agent-max-loops', lifetime: 'temporary' as const,
      brain: 'Brain', role: 'Role', harness: 'codex', session: 'acp' as const,
      parent: 'Coordinator', actionId: 'max-loops', inherited: [], configuration };
    expect(() => validateFleetAuditFinish({ correlationId: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f',
      class: 'success', effect: 'completed', presentations: [presentation] })).not.toThrow();
    const rendered = renderFleetLifecycleEvent(presentation);
    expect(Array.from(rendered).length).toBeLessThanOrEqual(MARKDOWN_MAX_CODE_POINTS);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
    expect(rendered).toContain('- **Template:** `dev-pair/critic`');
    expect(rendered).toContain('- **Role:** Preset `reviewer`');
    expect(rendered).toContain('- **Mission:** “Challenge every material change”');
    expect(rendered).toContain('- **Brain:** Preset `codex-high`');
    expect(rendered).toContain('- **Harness:** `codex`');
    expect(rendered).toContain('- **Model:** `gpt-5`');
    expect(rendered).toContain('- **Effort:** high');
    expect(rendered).toContain('- **Approval:** ask');
    expect(rendered).toContain('- **Filesystem:** workspace');
    expect(rendered).toContain('- **Wait:** wait');
    expect(rendered).toContain('- **Fleet mode:** ask');
    expect(rendered).toContain('- **Native mode:** read-only');
    expect(rendered).toContain('- **Loop policy:** Skip if busy');
    expect(rendered).toContain('- **Loop source:** agent template');
    expect(rendered).toContain('- **Details omitted:** Additional optional Agent configuration');
    expect(rendered).toContain('- **Agent ID:** `agent-max-loops`');
    expect(rendered).toContain('Launch was accepted; harness and room-seat readiness converge separately.');
    const count = (label: string) => rendered.split(`- **${label}:**`).length - 1;
    const loops = count('Loop');
    expect(loops).toBeGreaterThan(0);
    expect(loops).toBeLessThan(64);
    for (const label of ['Loop status', 'Loop interval', 'Loop delay', 'Loop jitter',
      'Loop prompt size', 'Loop prompt hash']) expect(count(label)).toBe(loops);
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
