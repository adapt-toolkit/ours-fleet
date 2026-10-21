import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AcpSession } from '../src/session/acp.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';
import {
  RoleControlServer, controlRequest, controlSocketPath, controlTokenPath, followConversation,
} from '../src/session/control.js';
import { readFileSync } from 'node:fs';
import type { ConversationEventV1 } from '../src/session/conversation-types.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startServer(approval: 'ask' | 'allow' | 'deny' = 'allow') {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-conv-ctl-'));
  dirs.push(stateDir);
  const session = await AcpSession.start({
    name: 'A', argv: [process.execPath, fixture], cwd: stateDir, env: {},
    stateDir, mode: 'fresh',
    permissions: { approval, filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
  });
  const server = new RoleControlServer(stateDir, session, () => {});
  await server.start();
  cleanups.push(async () => { await server.close(); await session.close(); });
  return { stateDir, session, server };
}

async function startArbiterServer() {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-conv-arbiter-'));
  dirs.push(stateDir);
  const session = await AcpSession.start({
    name: 'A', argv: [process.execPath, fixture], cwd: stateDir, env: {},
    stateDir, mode: 'fresh',
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
  });
  const arbiter = new RoleTurnArbiter(session);
  const server = new RoleControlServer(stateDir, arbiter, () => {});
  await server.start();
  cleanups.push(async () => { await server.close(); await session.close(); });
  return { stateDir, session, server, arbiter };
}

describe('role-control conversation v3', () => {
  it.each(['interrupt', 'after-tool'])('queues a monitor wake during active voice despite a timed-out member spawn: %s', async policy => {
    const { stateDir, session, server, arbiter } = await startArbiterServer();
    const generation = session.conversationSnapshot().sessionGeneration;
    const voice = await controlRequest(stateDir, { command: 'submit_voice_prompt', commandId: 'voice-task-start',
      text: 'block 600', actor: 'browser', source: 'owner_admin_console', expectedSessionGeneration: generation, requireIdle: true });
    expect(voice.ok).toBe(true);
    await expect.poll(() => session.snapshot().activePromptSource).toBe('owner-admin-console');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    server.setFleetSpawner(async () => { await pending; return {
      caller: 'A', role: 'TaskWorker', lifetime: 'temporary', statePath: '/fixture/task-worker',
      creationActionId: 'task-action', inherited: [], harness: 'codex', session: 'acp',
      monitor: { mode: 'fleet', interrupt: true }, brainSummary: 'fixture', roleSummary: 'worker',
    }; });
    try {
      const spawn = controlRequest(stateDir, { command: 'fleet_spawn', spawn: { name: 'TaskWorker' } }, 30)
        .catch(error => error);
      const options = { interrupt: true, steer: true, interruptSource: 'fleet-monitor' as const, origin: { kind: 'fleet-monitor' as const } };
      const wake = policy === 'after-tool' ? arbiter.submitPromptAfterTool('mail after voice', options) : arbiter.submitPrompt('mail after voice', options);
      expect((await controlRequest(stateDir, { command: 'snapshot' })).result).toMatchObject({
        alive: true, readiness: 'running', activePromptSource: 'owner-admin-console',
      });
      expect((await spawn).kind).toBe('timeout');
      expect((await wake).succeeded).toBe(true);
      const events = session.conversationPage({ limit: 100 }).events;
      expect(events.filter(event => event.kind === 'prompt.interrupt_requested')).toEqual([]);
      const voiceId = (voice.result as { promptId: string }).promptId;
      const stopped = events.findIndex(event => event.kind === 'turn.completed' && event.promptId === voiceId);
      const mailStarted = events.findIndex(event => event.kind === 'prompt.started' && event.source === 'fleet_monitor');
      expect(stopped).toBeGreaterThan(-1);
      expect(mailStarted).toBeGreaterThan(stopped);
      expect(session.conversationSnapshot().sessionGeneration).toBe(generation);
    } finally { release(); }
  });

  it('live voice binds admission and interrupt atomically through the arbiter/control socket', async () => {
    const { stateDir } = await startArbiterServer();
    const page = await controlRequest(stateDir, { command: 'conversation_page', limit: 1 });
    const generation = (page.result as any).snapshot.sessionGeneration;
    const snapshot = await controlRequest(stateDir, { command: 'snapshot' });
    expect((snapshot.result as any).features).toContain('targeted_voice_interrupt');
    const command = { command: 'submit_voice_prompt' as const, commandId: 'live-one', text: 'block 1200', actor: 'browser', source: 'owner_admin_console' as const, expectedSessionGeneration: generation, requireIdle: true };
    const first = await controlRequest(stateDir, command); expect(first.ok).toBe(true);
    await new Promise(r => setTimeout(r, 50));
    expect((await controlRequest(stateDir, command)).result).toEqual(first.result); // lost receipt retry while running
    const busy = await controlRequest(stateDir, { ...command, commandId: 'live-two' });
    expect(busy.ok).toBe(false); expect(busy.error).toContain('voice_busy');
    const cancel = { command: 'interrupt_voice_v2' as const, commandId: 'cancel-one', promptId: (first.result as any).promptId, expectedSessionGeneration: generation };
    expect((await controlRequest(stateDir, { ...cancel, commandId: 'cancel-stale', expectedSessionGeneration: 'old' })).ok).toBe(false);
    expect((await controlRequest(stateDir, { ...cancel, commandId: 'cancel-other', promptId: 'unrelated' })).ok).toBe(true);
    let events = ((await controlRequest(stateDir, { command: 'conversation_page', limit: 100 })).result as any).events;
    expect(events.some((e:any) => e.kind === 'prompt.interrupt_requested')).toBe(false);
    const stopped = await controlRequest(stateDir, cancel); expect(stopped.ok).toBe(true);
    expect((await controlRequest(stateDir, cancel)).result).toEqual(stopped.result);
    expect((await controlRequest(stateDir, { ...cancel, promptId: 'different' })).ok).toBe(false);
    const next = await controlRequest(stateDir, { ...command, commandId: 'live-new', text: 'block 200' }); expect(next.ok).toBe(true);
    await new Promise(r => setTimeout(r, 40));
    expect((await controlRequest(stateDir, { ...cancel, commandId: 'late-old-cancel' })).ok).toBe(true);
    events = ((await controlRequest(stateDir, { command: 'conversation_page', limit: 100 })).result as any).events;
    expect(events.filter((e:any) => e.kind === 'prompt.interrupt_requested')).toHaveLength(1);
  });

  it('binds voice input to its recorded session and replays the exact admitted receipt', async () => {
    const { stateDir, session } = await startServer();
    const command = { command: 'submit_voice_prompt' as const, commandId: 'voice-once', text: 'Voice message:\n/restart', actor: 'browser', source: 'owner_admin_console' as const };
    const missing = await controlRequest(stateDir, command);
    expect(missing.ok).toBe(false);
    const stale = await controlRequest(stateDir, { ...command, expectedSessionGeneration: 'old' });
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain('session_changed');
    const accepted = await controlRequest(stateDir, { ...command, expectedSessionGeneration: session.conversationSnapshot().sessionGeneration });
    expect(accepted.ok).toBe(true);
    const retry = await controlRequest(stateDir, { ...command, expectedSessionGeneration: 'old' });
    expect(retry.result).toEqual(accepted.result);
    expect(session.conversationPage({limit:100}).events.filter(e => e.kind === 'prompt.admitted')).toHaveLength(1);
  });

  it('serves typed read-only correspondence from the selected supervisor',async()=>{
    const {stateDir,server}=await startServer();const queries:unknown[]=[];
    server.setCorrespondence({contacts:async()=>({identity:{name:'A'},contacts:[{name:'Peer',container_id:'B'.repeat(64)}]}),history:async query=>{queries.push(query);return {items:[{seq:2,direction:'out',text:'hello'}],next_cursor:2};}});
    const contacts=await controlRequest(stateDir,{command:'agent_contacts'});
    expect(contacts.ok).toBe(true);expect(contacts.result).toMatchObject({identity:{name:'A'},contacts:[{name:'Peer'}]});
    const query={peer_cid:'B'.repeat(64),limit:10,before_seq:4};
    expect((await controlRequest(stateDir,{command:'agent_history',agentHistory:query})).result).toMatchObject({next_cursor:2});
    expect(queries).toEqual([query]);
    expect((await controlRequest(stateDir,{command:'agent_history',agentHistory:{peer_cid:'bad'}})).ok).toBe(false);
    expect(queries).toHaveLength(1);
  });
  it('serializes idle retirement with incoming work and rejects prompts after closing', async()=>{
    const {session}=await startServer();
    const arbiter=new RoleTurnArbiter(session);
    const queued=arbiter.queuePrompt('block 80');
    const firstRetirement=arbiter.retireIfIdle(()=>true);
    const admitted=await queued;
    expect(await firstRetirement).toBe(false);
    await admitted.completion;
    const closing=arbiter.retireIfIdle(()=>true);
    const later=arbiter.queuePrompt('must not be admitted');
    const rejected=expect(later).rejects.toThrow('Chat is closing');
    expect(await closing).toBe(true);
    await rejected;
    await expect.poll(()=>session.isAlive()).toBe(false);
  });

  it('forwards conversation v3 through the production turn arbiter', async () => {
    const { stateDir } = await startArbiterServer();
    const snapshot = await controlRequest(stateDir, { command: 'snapshot' });
    expect(snapshot.result).toMatchObject({
      protocolVersion: 3, features: expect.arrayContaining(['conversation_v3', 'generation_bound_prompts']),
    });
    const submitted = await controlRequest(stateDir, {
      command: 'submit_prompt_v2', commandId: 'arbiter-cmd',
      text: 'through arbiter', actor: 'browser-digest', source: 'owner_admin_console',
    });
    expect(submitted.ok).toBe(true);
    const page = await controlRequest(stateDir, { command: 'conversation_page', limit: 100 });
    expect((page.result as { events: ConversationEventV1[] }).events.some(
      event => event.commandId === 'arbiter-cmd')).toBe(true);
  });
  it('advertises conversation_v3 and protocol 3 in the snapshot', async () => {
    const { stateDir } = await startServer();
    const response = await controlRequest(stateDir, { command: 'snapshot' });
    expect(response.ok).toBe(true);
    const result = response.result as { protocolVersion: number; features: string[] };
    expect(result.protocolVersion).toBe(3);
    expect(result.features).toContain('conversation_v3');
    expect(result.features).toContain('generation_bound_prompts');
    // v1/v2 features remain, so old callers keep working.
    expect(result.features).toEqual(expect.arrayContaining(
      ['events_since', 'observer_follow', 'retained_range']));
  });

  it('serves conversation pages over the socket', async () => {
    const { stateDir, session } = await startServer();
    await session.submitPrompt('page me');
    const response = await controlRequest(stateDir, { command: 'conversation_page', limit: 100 });
    expect(response.ok).toBe(true);
    const result = response.result as {
      events: ConversationEventV1[]; snapshot: { sessionGeneration: string };
    };
    expect(result.events.map(e => e.kind)).toEqual(expect.arrayContaining(
      ['prompt.admitted', 'prompt.started', 'message.chunk', 'turn.completed']));
    expect(result.snapshot.sessionGeneration).toBeTruthy();
  });

  it('rejects v3 commands sent with an older protocol version', async () => {
    const { stateDir } = await startServer();
    // Hand-roll a version-2 frame for a v3 command.
    const token = readFileSync(controlTokenPath(stateDir), 'utf8').trim();
    const socket = createConnection(controlSocketPath(stateDir));
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
      });
      socket.once('error', reject);
      socket.once('connect', () => socket.write(JSON.stringify({
        version: 2, id: 'x', token, command: 'conversation_page',
      }) + '\n'));
    });
    socket.destroy();
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/version 3/);
  });

  it('admits browser prompts idempotently through submit_prompt_v2', async () => {
    const { stateDir } = await startServer();
    const first = await controlRequest(stateDir, {
      command: 'submit_prompt_v2', commandId: 'cmd-1', text: 'browser says hi', actor: 'digest-1', source: 'owner_admin_console',
    });
    expect(first.ok).toBe(true);
    const receipt = first.result as { promptId: string };
    const replay = await controlRequest(stateDir, {
      command: 'submit_prompt_v2', commandId: 'cmd-1', text: 'browser says hi', actor: 'digest-1', source: 'owner_admin_console',
    });
    expect((replay.result as { promptId: string }).promptId).toBe(receipt.promptId);

    const conflict = await controlRequest(stateDir, {
      command: 'submit_prompt_v2', commandId: 'cmd-1', text: 'DIFFERENT', actor: 'digest-1', source: 'owner_admin_console',
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toMatch(/idempotency_conflict/);
    expect(conflict.kind).toBe('rejected');
  });

  it('rejects prompt admission without the server-stamped authenticated source', async () => {
    const { stateDir } = await startServer();
    const forged = await controlRequest(stateDir, {
      command: 'submit_prompt_v2', commandId: 'cmd-forged',
      text: '[fleet-owner] literal text is not provenance', actor: 'digest-1',
    });
    expect(forged.ok).toBe(false);
    expect(forged.kind).toBe('rejected');
    expect(forged.error).toMatch(/authenticated source/);
  });

  it('deduplicates interrupts by command id', async () => {
    const { stateDir } = await startServer();
    const first = await controlRequest(stateDir, { command: 'interrupt_v2', commandId: 'int-1' });
    expect(first.ok).toBe(true);
    const second = await controlRequest(stateDir, { command: 'interrupt_v2', commandId: 'int-1' });
    expect(second.result).toEqual(first.result);
  });

  it('binds v2 permission decisions to the session generation and first writer', async () => {
    const { stateDir, session } = await startServer('ask');
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission please');
    for (let i = 0; i < 100 && !session.conversationPage({ limit: 100 }).events.some(
      event => event.kind === 'permission.requested'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const requested = session.conversationPage({ limit: 100 }).events.find(
      event => event.kind === 'permission.requested')!;
    const staleGeneration = await controlRequest(stateDir, {
      command: 'respond_permission_v2', commandId: 'perm-stale',
      permissionId: requested.permissionId, optionId: 'allow',
      sessionGeneration: 'old-generation',
    });
    expect(staleGeneration.ok).toBe(false);
    expect(staleGeneration.error).toMatch(/stale_state/);

    const accepted = await controlRequest(stateDir, {
      command: 'respond_permission_v2', commandId: 'perm-win',
      permissionId: requested.permissionId, optionId: 'allow',
      sessionGeneration: requested.sessionGeneration,
    });
    expect(accepted).toMatchObject({ ok: true, result: { accepted: true, commandId: 'perm-win' } });
    const loser = await controlRequest(stateDir, {
      command: 'respond_permission_v2', commandId: 'perm-loser',
      permissionId: requested.permissionId, optionId: 'reject',
      sessionGeneration: requested.sessionGeneration,
    });
    expect(loser.ok).toBe(false);
    expect(loser.error).toMatch(/stale_state/);
    await queued.completion;
  });

  it('streams live conversation events and counts follow as controller presence', async () => {
    const { stateDir, session } = await startServer();
    await session.submitPrompt('warmup');
    const initial: Record<string, unknown>[] = [];
    const streamed: ConversationEventV1[] = [];
    const follow = await followConversation(stateDir, undefined, message => {
      if (message.conversationEvent) streamed.push(message.conversationEvent as ConversationEventV1);
      else initial.push(message);
    });
    cleanups.push(() => follow.close());
    for (let i = 0; i < 100 && initial.length === 0; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const page = (initial[0] as { result: { events: ConversationEventV1[] } }).result;
    expect(page.events.length).toBeGreaterThan(0);

    await session.submitPrompt('second turn');
    for (let i = 0; i < 100 && !streamed.some(e =>
      e.kind === 'turn.completed'
      && page.events.every(existing => existing.eventId !== e.eventId)); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    // No overlap and no gap: streamed events continue exactly after the page.
    const lastPaged = page.events.at(-1)!.seq;
    expect(Math.min(...streamed.map(e => e.seq))).toBe(lastPaged + 1);
    const all = [...page.events.map(e => e.seq), ...streamed.map(e => e.seq)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('passive generation-bound follow', () => {
  it('replays every page before ready and never attaches a controller through the arbiter', async () => {
    const {stateDir,session,arbiter}=await startArbiterServer();
    await session.submitPrompt('warmup');
    const generation=session.conversationSnapshot().sessionGeneration;
    const messages: Record<string,unknown>[]=[];
    const attached:boolean[]=[];
    const original=arbiter.setControllerAttached.bind(arbiter);
    arbiter.setControllerAttached=(value:boolean)=>{attached.push(value);original(value);};
    const follow=await followConversation(stateDir,{expectedGeneration:generation,after:0,controller:false},m=>messages.push(m));
    cleanups.push(()=>follow.close());
    await expect.poll(()=>messages.some(m=>m.conversationReady)).toBe(true);
    const ready=messages.find(m=>m.conversationReady)!.conversationReady as any;
    const replay=messages.flatMap(m=>(m.conversationReplay as any)?.events??[]);
    expect(replay.map((e:any)=>e.seq)).toEqual(session.conversationPage({limit:1000}).events.map(e=>e.seq));
    expect(ready.snapshot).toMatchObject({sessionGeneration:generation,queueDepth:0,pendingPrompts:[],pendingPermissions:[],alive:true});
    expect(ready.coveredThrough).toBe(ready.snapshot.ledgerBarrier);
    expect(attached).toEqual([]);
    follow.close();follow.close();
    expect(session.conversationSnapshot().sessionGeneration).toBe(generation);
  });
  it('rejects a mismatched expected generation instead of silently switching baselines',async()=>{
    const {stateDir}=await startArbiterServer();const messages:Record<string,unknown>[]=[];
    const follow=await followConversation(stateDir,{expectedGeneration:'stale',after:0,controller:false},m=>messages.push(m));
    cleanups.push(()=>follow.close());
    await expect.poll(()=>messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatchObject({ok:false,error:expect.stringMatching(/generation/)});
    expect(messages.some(m=>m.conversationReady)).toBe(false);
  });
});


describe('canonical recovery when live observation fails',()=>{
 it('keeps post-admission durable events visible through the REST adapter after capture failure',async()=>{
  const {RoleSessionControlAdapter}=await import('../src/application/session-control.js');
  const {stateDir,session}=await startServer();
  const baseline=session.observeConversation(()=>{});const frozen=baseline.snapshot.ledgerBarrier;baseline.unsubscribe();
  const owner=session as unknown as {captureObservation():unknown};const capture=owner.captureObservation.bind(session);
  const stop=session.subscribeConversation(event=>{
   if(event.kind==='prompt.admitted')owner.captureObservation=()=>{owner.captureObservation=capture;throw new Error('post-admission capture fault');};
  });
  try{
   await session.submitPrompt('after capture fault');stop();
   await session.submitPrompt('later durable turn');
   const failed=session.observeConversation(()=>{});expect(failed.snapshot).toMatchObject({observationFailure:'capture_failed',ledgerBarrier:frozen});failed.unsubscribe();
   const canonical=session.conversationPage({limit:1000});const last=canonical.events.at(-1)!;
   expect(last.seq).toBeGreaterThan(frozen);
   const adapter=new RoleSessionControlAdapter(stateDir);const page=await adapter.conversationTail({limit:1000});
   expect(page.events.map(e=>e.seq)).toEqual(canonical.events.map(e=>e.seq));
   expect(page.nextCursor).toBe(String(last.seq));
   expect(page.snapshot).toMatchObject({observationFailure:'capture_failed',historyDegraded:true});
   expect(page.snapshot).not.toHaveProperty('ledgerBarrier');
   const messages:Record<string,unknown>[]=[];
   const follow=await followConversation(stateDir,{expectedGeneration:canonical.snapshot.sessionGeneration,after:last.seq,controller:false},m=>messages.push(m));
   cleanups.push(()=>follow.close());
   await expect.poll(()=>messages.some(m=>m.ok===false)).toBe(true);
   expect(messages.some(m=>m.conversationReady)).toBe(false);
  }finally{stop();owner.captureObservation=capture;}
 });
 it('serves canonical REST data when no coherent observation was ever available',async()=>{
  const {RoleSessionControlAdapter}=await import('../src/application/session-control.js');
  const capture=vi.spyOn(AcpSession.prototype as any,'captureObservation').mockImplementation(()=>{throw new Error('initial capture fault');});
  let started:Awaited<ReturnType<typeof startServer>>;
  try{started=await startServer();}finally{capture.mockRestore();}
  const {session,stateDir}=started!;
  await session.submitPrompt('durable despite unavailable observation');
  expect(()=>session.observeConversation(()=>{})).toThrow(/unavailable/);
  const canonical=session.conversationPage({limit:1000});
  const response=await controlRequest(stateDir,{command:'conversation_page',limit:1000});
  expect(response.ok).toBe(true);
  expect((response.result as any).events.map((e:any)=>e.seq)).toEqual(canonical.events.map(e=>e.seq));
  expect((response.result as any).snapshot).toMatchObject({observationFailure:'capture_failed',historyDegraded:true});
  const page=await new RoleSessionControlAdapter(stateDir).conversationTail({limit:1000});
  expect(page.nextCursor).toBe(String(canonical.events.at(-1)!.seq));
  expect(page.events.map(e=>e.seq)).toEqual(canonical.events.map(e=>e.seq));
 });
});

// Fake time covers the exact deadline independently of a still-open consumer socket.
import { vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RoleSessionControlAdapter } from '../src/application/session-control.js';

describe('private observation health', () => {
  afterEach(() => vi.useRealTimers());
  function adapterFixture(roleHealth = 'healthy') {
    const socket = new EventEmitter() as any; socket.destroyed = false;
    const close = vi.fn(() => { socket.destroyed = true; socket.emit('close'); });
    let deliver!: (message: Record<string, unknown>) => void;
    let changed!: (state: any) => void;
    const dispose = vi.fn();
    let state: any = { roleId: 'A', roleRevision: 1, roleLifetime: 'one', availability: 'available', health: roleHealth, stateDir: '/role' };
    const observe = (_listener: (state: any) => void) => ({ snapshot: () => state, dispose, subscribe: (listener: (state: any) => void) => { changed = value => { state = value; listener(value); }; return { snapshot: state, unsubscribe: () => {} }; } });
    const request = vi.fn(async () => ({ ok: true, result: { backend: 'acp', features: ['conversation_observation', 'control_heartbeat'] } }));
    const adapter = new RoleSessionControlAdapter('/role', request as any, (async (_dir: string, _request: unknown, listener: typeof deliver) => { deliver = listener; return { socket, close }; }) as any, observe);
    const onClose = vi.fn(), onRole = vi.fn(), onState = vi.fn();
    const followRequest = { controller: false as const, expectedGeneration: 'g', onReplay: vi.fn(), onReady: vi.fn(), onEvent: vi.fn(), onState, onRole, onClose };
    return { adapter, followRequest, onClose, onRole, onState, close, dispose, request, socket, deliver: (message: Record<string, unknown>) => deliver(message), change: (value: any) => changed({ ...state, ...value }) };
  }
  it('ends at forty-five seconds of private silence even while unrelated traffic remains active', async () => {
    vi.useFakeTimers();
    const f = adapterFixture(); await f.adapter.followConversation(f.followRequest);
    await vi.advanceTimersByTimeAsync(44_999);
    f.deliver({ unrelated: true });
    f.change({});
    expect(f.onClose).not.toHaveBeenCalled(); expect(f.socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.onClose).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledWith('control-silent');
    expect(f.close).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([{ controlHeartbeat: true }, { conversationState: { sessionGeneration: 'g' } }])('private evidence %j renews liveness and owner close clears its timer', async evidence => {
    vi.useFakeTimers(); const f = adapterFixture(); const handle = await f.adapter.followConversation(f.followRequest);
    await vi.advanceTimersByTimeAsync(44_000); f.deliver(evidence);
    await vi.advanceTimersByTimeAsync(44_999); expect(f.onClose).not.toHaveBeenCalled();
    handle.close(); expect(f.dispose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('orders role replacement before closing the old session and drops later session data', async () => {
    const f = adapterFixture(); await f.adapter.followConversation(f.followRequest);
    f.change({ roleRevision: 2, roleLifetime: 'two' });
    expect(f.onRole).toHaveBeenLastCalledWith(expect.objectContaining({ roleRevision: 2, roleLifetime: 'two' }));
    expect(f.onClose).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledWith('role-replaced');
    expect(f.onRole.mock.invocationCallOrder.at(-1)).toBeLessThan(f.onClose.mock.invocationCallOrder[0]);
    f.deliver({ conversationState: {} }); expect(f.onState).not.toHaveBeenCalled();
  });
  it('advertises complete delivery only for healthy session and role support, disposing describe probes', async () => {
    const f = adapterFixture(); expect((await f.adapter.describe()).features).toContain('conversation_live_complete');
    expect(f.dispose).toHaveBeenCalledOnce();
    const unsupported = adapterFixture('unsupported');
    expect((await unsupported.adapter.describe()).features).not.toContain('conversation_live_complete');
    f.request.mockResolvedValueOnce({ ok: true, result: { backend: 'acp', features: ['control_heartbeat'] } });
    expect((await f.adapter.describe()).features).not.toContain('conversation_live_complete');
  });
  it('withdraws complete capability and closes on mid-stream watcher failure', async () => {
    const f = adapterFixture(); await f.adapter.followConversation(f.followRequest);
    f.change({ roleRevision: 2, health: 'failed', failure: 'watch-error' });
    expect(f.onClose).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledWith('watch-error');
    expect((await f.adapter.describe()).features).not.toContain('conversation_live_complete');
  });
  it('borrows one role owner across describe and follows without disposing it on replacement', async () => {
    const f = adapterFixture();
    let current: any = { roleId: 'A', roleRevision: 1, roleLifetime: 'one', availability: 'available', health: 'healthy', stateDir: '/role' };
    const listeners = new Set<(state: any) => void>();
    const borrowed = { snapshot: () => current, dispose: vi.fn(), subscribe: (listener: (state: any) => void) => { listeners.add(listener); return { snapshot: current, unsubscribe: () => { listeners.delete(listener); } }; } };
    expect((await f.adapter.describe(borrowed)).features).toContain('conversation_live_complete');
    const handle = await f.adapter.followConversation({ ...f.followRequest, roleObservation: borrowed });
    expect(f.dispose).not.toHaveBeenCalled();
    current = { ...current, roleRevision: 2, roleLifetime: 'two', availability: 'missing' };
    for (const listener of listeners) listener(current);
    expect(f.onClose).toHaveBeenCalledWith('role-replaced');
    handle.close(); expect(borrowed.dispose).not.toHaveBeenCalled(); expect(listeners.size).toBe(0);
  });
  it('withdraws complete delivery for latched current-generation append failure but preserves an old history warning', async () => {
    const { stateDir, session, arbiter } = await startArbiterServer();
    const generation = session.conversationSnapshot().sessionGeneration;
    const observation = { snapshot: () => ({ health: 'healthy', availability: 'available' }), dispose: () => {}, subscribe: () => { throw new Error('not needed for describe'); } } as any;
    const adapter = new RoleSessionControlAdapter(stateDir);
    const cyclic: any = {}; cyclic.self = cyclic;
    const fail = (sessionGeneration: string) => (session as any).conversation.appendSafe({ kind: 'session.started', source: 'system', sessionGeneration, payload: cyclic });
    fail('older-generation');
    expect(session.conversationSnapshot().historyDegraded).toBe(true);
    expect((await adapter.describe(observation)).features).toContain('conversation_live_complete');
    fail(generation);
    expect((await adapter.describe(observation)).features).not.toContain('conversation_live_complete');
    expect(arbiter.conversationReplayAvailable(generation)).toBe(false);
    expect(arbiter.conversationReplayAvailable('not-current')).toBe(false);
  });
  it('withdraws supervisor observation support after capture failure without breaking snapshot reads', async () => {
    const { stateDir, session } = await startServer();
    const original = session.observeConversation.bind(session);
    session.observeConversation = listener => {
      const observation = original(listener);
      return { ...observation, snapshot: { ...observation.snapshot, observationFailure: 'capture_failed' } };
    };
    const response = await controlRequest(stateDir, { command: 'snapshot' });
    expect(response.ok).toBe(true);
    expect((response.result as any).features).not.toContain('conversation_observation');
    session.observeConversation = () => { throw new Error('unavailable initial capture'); };
    expect((await controlRequest(stateDir, { command: 'snapshot' })).ok).toBe(true);
  });
  it('emits supervisor heartbeats every fifteen seconds without attaching a controller', async () => {
    const { stateDir, session } = await startArbiterServer();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const messages: any[] = [];
    const follow = await followConversation(stateDir, { controller: false, expectedGeneration: session.conversationSnapshot().sessionGeneration }, m => messages.push(m));
    cleanups.push(() => follow.close());
    await expect.poll(() => messages.some(m => m.conversationReady)).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    await new Promise(setImmediate);
    expect(messages.filter(m => m.controlHeartbeat)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect.poll(() => messages.filter(m => m.controlHeartbeat).length).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect.poll(() => messages.filter(m => m.controlHeartbeat).length).toBe(2);
    const descriptor = await controlRequest(stateDir, { command: 'snapshot' });
    expect((descriptor.result as any).features).toEqual(expect.arrayContaining(['conversation_observation', 'control_heartbeat']));
  }, 8_000);
});
