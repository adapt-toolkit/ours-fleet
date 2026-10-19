import type { Writable } from 'node:stream';
import { encodeConversationRecord, MAX_PENDING_BYTES, type ConversationRecordType } from './conversation-stream-codec.js';

/** One active logical record; only waiting encoded output consumes the pending budget. */
export class ConversationStreamWriter {
  private queue: Array<{type:ConversationRecordType;payload:unknown;id:string;bytes:number}> = [];
  private active?: Iterator<string>;
  private waiting = false;
  private ended = false;
  private sequence = 0;
  pendingBytes = 0;
  get busy() { return Boolean(this.active); }
  constructor(private readonly output: Writable, private readonly failed: (reason:string) => void) {
    output.on('drain', this.drain); output.once('error', this.error);
  }
  private error = () => this.fail('transport-error');
  private drain = () => { this.waiting=false; this.flush(); };
  send(type: ConversationRecordType, payload: unknown): boolean {
    if (this.ended) return false;
    const id=String(++this.sequence);
    try {
      if (!this.active) {
        this.active=encodeConversationRecord(type,payload,id); this.flush();
      } else {
        let bytes=0;
        for (const frame of encodeConversationRecord(type,payload,id)) bytes+=Buffer.byteLength(frame);
        if (this.pendingBytes+bytes>MAX_PENDING_BYTES) { this.fail('output-overflow'); return false; }
        this.queue.push({type,payload,id,bytes}); this.pendingBytes+=bytes;
      }
      return !this.ended;
    } catch { this.fail('record-too-large'); return false; }
  }
  private flush() {
    if (this.ended || this.waiting) return;
    try {
      while (this.active) {
        const next=this.active.next();
        if (!next.done) {
          if (!this.output.write(next.value)) {this.waiting=true;return;}
        } else {
          const queued=this.queue.shift();
          this.active=queued ? encodeConversationRecord(queued.type,queued.payload,queued.id) : undefined;
          if (queued) this.pendingBytes-=queued.bytes;
        }
      }
    } catch { this.fail('record-too-large'); }
  }
  private fail(reason: string) {
    if (this.ended) return;
    // A resync is only useful at a frame boundary with writable capacity.
    if (!this.waiting && !this.output.destroyed) {
      const frame=encodeConversationRecord('resync',{reason,capability:'degraded',retry:reason!=='record-too-large'},'terminal').next().value;
      if (frame) this.output.write(frame);
    }
    const blocked=this.waiting;
    this.close(); this.failed(reason);
    if (blocked) this.output.destroy();
  }
  close() {
    if (this.ended) return;
    this.ended=true; this.active=undefined; this.queue=[];this.pendingBytes=0;
    this.output.off('drain',this.drain);this.output.off('error',this.error);
  }
}

import type { FastifyInstance } from 'fastify';
import type { WebServices } from './server.js';
import type { WebAuth } from './auth.js';
import { FleetError } from '../application/errors.js';
import type { ConversationRoleObservation, ConversationRoleState } from '../application/conversation-role-observer.js';
import type { ConversationFollowHandle } from '../application/session-control.js';
import type { ConversationEventV1 } from '../session/conversation-types.js';
import { presentAttachmentEvent } from './agent-attachments.js';

export function registerConversationStream(app: FastifyInstance, services: WebServices, auth: WebAuth): void {
  const connections=new Set<()=>void>();
  app.addHook('preClose',async()=>{for(const close of connections)close();});
  app.get<{Params:{id:string};Querystring:{expectedGeneration?:string;after?:string}}>('/api/v1/roles/:id/conversation/events', async(request,reply)=>{
    const browser=auth.authenticate(request);
    const generation=request.query.expectedGeneration, rawAfter=request.query.after ?? '0', after=Number(rawAfter);
    if (typeof generation!=='string' || !generation.trim() || generation.length>512 || !/^\d+$/.test(rawAfter) || !Number.isSafeInteger(after))
      throw new FleetError('invalid_request','expectedGeneration and a nonnegative integer after cursor are required');
    if (!services.observeRole) throw new FleetError('capability_unavailable','Complete conversation observation is unavailable');
    let ended=false, owner:ConversationRoleObservation|undefined, follow:ConversationFollowHandle|undefined;
    let binding:(()=>void)|undefined, timer:ReturnType<typeof setInterval>|undefined;
    let epoch=0, revision=-1, lifetime:string|undefined, available=false;
    let abort=new AbortController();
    const close=()=>{
      if(ended)return;ended=true;epoch++;abort.abort();
      if(timer)clearInterval(timer);binding?.();writer.close();follow?.close();follow=undefined;owner?.dispose();
      connections.delete(close);reply.raw.end();
    };
    const writer=new ConversationStreamWriter(reply.raw,close);
    const resync=(reason:string,retry=true)=>writer.send('resync',{reason,retry,capability:'degraded'});
    const valid=()=>{if(auth.sessionValid(browser))return true;writer.send('resync',{reason:'auth-expired',retry:browser.rotating?'authenticate':'reauthenticate',capability:'auth-expired'});close();return false;};
    const stopFollow=()=>{epoch++;abort.abort();abort=new AbortController();follow?.close();follow=undefined;};
    const open=async()=>{
      const current=++epoch, signal=abort.signal;
      const active=()=>!ended && current===epoch && !signal.aborted;
      try {
        const control=await services.session(request.params.id);
        if(!active() || !valid())return;
        const descriptor=await control.describe(owner);
        if(!active() || !valid())return;
        if(!control.followConversation || !descriptor.features.includes('conversation_live_complete')) {resync('capability-unavailable',false);return;}
        const stateDir=owner?.snapshot().stateDir;
        const present=(event:ConversationEventV1)=>presentAttachmentEvent(stateDir,request.params.id,event);
        const handle=await control.followConversation({controller:false,expectedGeneration:generation,after,signal,roleObservation:owner,
          onReplay:page=>{if(active() && valid()){for(const event of page.events)writer.send('ledger',present(event));writer.send('ledger',{coveredThrough:page.coveredThrough});}},
          onReady:ready=>{if(active() && valid()){
            writer.send('state',ready.snapshot);
            writer.send('ready',{sessionGeneration:ready.snapshot.sessionGeneration,stateRevision:ready.snapshot.stateRevision,
              ledgerBarrier:ready.snapshot.ledgerBarrier,coveredThrough:ready.coveredThrough,capability:'complete',authorizedUntil:browser.absoluteExpiresAt});
          }},
          onEvent:event=>{if(active() && valid()){writer.send('ledger',present(event));writer.send('ledger',{coveredThrough:event.seq});}},
          onState:state=>{if(active() && valid())writer.send('state',state);},
          onClose:reason=>{if(active()){epoch++;abort.abort();follow=undefined;resync(reason ?? 'control-closed',!reason?.includes('assembly limit'));}},
        });
        if(!active())handle.close();else follow=handle;
      } catch {if(active())resync('observation-unavailable');}
    };
    const changed=(state:ConversationRoleState)=>{
      if(ended || state.roleRevision<=revision)return;
      revision=state.roleRevision;
      const {stateDir:_private,...publicState}=state;
      writer.send('role',publicState);
      const replaced=lifetime!==undefined && lifetime!==state.roleLifetime;
      const nextAvailable=state.availability==='available' && state.health==='healthy';
      if(replaced || !nextAvailable)stopFollow();
      if(state.health!=='healthy')resync(state.failure ?? 'role-observation-unavailable',state.health !== 'unsupported');
      else if(replaced)resync('role-replaced');
      const shouldOpen=nextAvailable && (!available || replaced);
      lifetime=state.roleLifetime;available=nextAvailable;
      if(shouldOpen)void open();
    };
    reply.hijack();
    for(const [name,value] of Object.entries(reply.getHeaders()))if(value!==undefined)reply.raw.setHeader(name,Array.isArray(value)?value:String(value));
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    reply.raw.flushHeaders();reply.raw.once('close',close);connections.add(close);
    binding=auth.bindTransport(browser,()=>{writer.send('resync',{reason:'auth-expired',capability:'auth-expired',retry:browser.rotating?'authenticate':'reauthenticate'});close();});
    try {
      // Factory callbacks can be synchronous; defer handling until the owner can be borrowed.
      owner=services.observeRole(request.params.id,state=>queueMicrotask(()=>changed(state)));
      if(ended){owner.dispose();return;}
      changed(owner.snapshot());
      timer=setInterval(()=>{if(valid())writer.send('keepalive',{at:Date.now()});},1_000);timer.unref();
    } catch {resync('role-observation-unavailable');close();}
  });
}
