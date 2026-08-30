import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  classifyFleetArgv, FleetCommandAuditStore, redactFleetArgv,
  renderFleetAuditInvocation, renderFleetAuditOutcome, fleetProxyCommandInventory,
  fleetProxyTopLevelInventory, validateFleetAuditBegin, validateFleetAuditFinish,
} from '../src/fleet-command-audit.js';
import { fleetWorkerEnv } from '../src/rooms-tasks/external-worker.js';
import { FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV } from '../src/fleet-proxy.js';

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
      ...fleetProxyTopLevelInventory.agent, ...fleetProxyTopLevelInventory.denied,
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
    [['down', 'A'], 'deny', 'down'],
    [['send', 'A', 'secret'], 'deny', 'send'],
    [['_run', 'A'], 'deny', '_run'],
    [['task', '_settle', 't'], 'deny', 'task _settle'],
    [['room', '_delete', 'r'], 'deny', 'room _delete'],
    [['unknown'], 'unsupported', 'unknown'],
    [['task', 'exfiltrate'], 'unsupported', 'task exfiltrate'],
    [['room', 'bogus'], 'unsupported', 'room bogus'],
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

  it('renders mandatory raw argv in both canonical records', () => {
    const store = new FleetCommandAuditStore(join(mkdtempSync(join(tmpdir(), 'fleet-audit-')), 'a.json'), {
      now: () => new Date('2026-01-01T00:00:00.000Z'), uuid: () => 'corr',
    });
    let attempt = store.begin('req', 'Agent', ['task', 'create', '--brief', 'secret']);
    expect(renderFleetAuditInvocation(attempt)).toContain('Raw argv (redacted): ["task","create","--brief","[REDACTED:value]"]');
    attempt = store.finish('corr', 'Agent', { class: 'success', effect: 'completed', exitCode: 0 });
    expect(renderFleetAuditOutcome(attempt)).toContain('Raw argv (redacted): ["task","create","--brief","[REDACTED:value]"]');
  });

  it('renders stable structured Agent, Task, and Room vocabulary after the raw block', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fleet-audit-')), 'structured.json');
    const agentStore = new FleetCommandAuditStore(path, { now: () => new Date('2026-01-01T00:00:00.000Z'), uuid: () => 'agent' });
    agentStore.begin('req', 'Coordinator', ['spawn', 'Dev']);
    const agent = agentStore.finish('agent', 'Coordinator', { class: 'success', effect: 'completed', exitCode: 0,
      presentation: { kind: 'agent_started', name: 'Dev', lifetime: 'temporary', brain: 'brain-ref',
        role: 'role-ref', harness: 'codex', session: 'acp', permissions: 'allow/full',
        parent: 'Coordinator', actionId: 'action-1', inherited: ['role'] } });
    expect(renderFleetAuditOutcome(agent)).toMatch(/Raw argv[\s\S]+Structured result: Agent started/);
    expect(renderFleetAuditOutcome(agent)).toContain('Brain: brain-ref');
    const taskStore = new FleetCommandAuditStore(path + '-task', { now: () => new Date('2026-01-01T00:00:00.000Z'), uuid: () => 'task' });
    taskStore.begin('req', 'Coordinator', ['task', 'start', 't1']);
    const task = taskStore.finish('task', 'Coordinator', { class: 'success', effect: 'completed', exitCode: 0,
      presentation: { kind: 'task', operation: 'started', id: 't1', title: 'Ship',
        previousState: 'backlog', newState: 'active', template: 'team@1', roomId: 'r1',
        agents: [{ name: 'Dev', brain: 'B', role: 'Developer' }] } });
    expect(renderFleetAuditOutcome(task)).toContain('Status: backlog -> active');
    expect(renderFleetAuditOutcome(task)).toContain('Responsible Agents: Dev [Brain B; Role Developer]');
    const roomStore = new FleetCommandAuditStore(path + '-room', { now: () => new Date('2026-01-01T00:00:00.000Z'), uuid: () => 'room' });
    roomStore.begin('req', 'Coordinator', ['room', 'open', 'r1']);
    const room = roomStore.finish('room', 'Coordinator', { class: 'success', effect: 'completed', exitCode: 0,
      presentation: { kind: 'room', operation: 'opened', id: 'r1', previousState: 'provisioning',
        newState: 'active', participants: [{ name: 'Critic', role: 'Critic' }] } });
    expect(renderFleetAuditOutcome(room)).toContain('Participants: Critic [Role Critic]');
  });
});
