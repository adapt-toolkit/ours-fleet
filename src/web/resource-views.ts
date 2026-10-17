import { relative, resolve, sep } from 'node:path';
import { agentsRoot, tmpRoot, stateRoot } from '../paths.js';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { observeFleetResources, type FleetResourceScope, type FleetResourceState } from '../application/resource-observer.js';

export async function abortableProjection<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('resource projection aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([read, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export interface ResourceFrameBinding {
  readonly protocolVersion: 1;
  readonly producerGeneration: string;
  readonly subscriptionEpoch: number;
  readonly viewId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly baselineId?: string;
}
export type ResourceHealthReason = 'auth_required' | 'unsupported' | 'upstream_unavailable';
export type ResourceEnvelope = ResourceFrameBinding & (
  | { readonly kind: 'snapshot'; readonly payload: unknown }
  | { readonly kind: 'upsert'; readonly payload: unknown }
  | { readonly kind: 'delete'; readonly payload: { readonly id: string; readonly revision: number } }
  | { readonly kind: 'ready'; readonly payload: { readonly baselineId: string; readonly source: FleetResourceState } }
  | { readonly kind: 'coverage'; readonly payload: { readonly source: FleetResourceState } }
  | { readonly kind: 'resync'; readonly payload: { readonly reason: 'capacity' | 'projection_unavailable' } }
  | { readonly kind: 'health'; readonly payload: { readonly healthy: false; readonly reason: ResourceHealthReason } }
);
export interface ResourceWireFrame { event: 'resource' | 'resource-chunk'; data: Record<string, unknown> }
export const RESOURCE_FRAME_BYTES = 512 * 1024;
export const RESOURCE_PENDING_BYTES = 8 * 1024 * 1024;
export const RESOURCE_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

/** Lazily yield byte chunks so backpressure never queues an entire large record.
 * Base64 prevents splitting a Unicode scalar from corrupting JSON/SSE parsing. */
export function* resourceFrames(envelope: ResourceEnvelope): Generator<ResourceWireFrame> {
  const bytes = Buffer.from(JSON.stringify(envelope));
  if (bytes.length > RESOURCE_ASSEMBLY_BYTES) throw new Error('resource assembly limit exceeded');
  const ordinary = { event: 'resource' as const, data: envelope as unknown as Record<string, unknown> };
  if (Buffer.byteLength(`event: resource\ndata: ${bytes.toString('utf8')}\n\n`) <= RESOURCE_FRAME_BYTES) {
    yield ordinary; return;
  }
  const id = `${envelope.viewId}:${envelope.subscriptionEpoch}:${envelope.sequence}`;
  const binding = { protocolVersion: 1, id, producerGeneration: envelope.producerGeneration,
    viewId: envelope.viewId, subscriptionEpoch: envelope.subscriptionEpoch, revision: envelope.revision,
    sequence: envelope.sequence };
  yield { event: 'resource-chunk', data: { ...binding, type: 'start', totalBytes: bytes.length, parts: Math.ceil(bytes.length / CHUNK_BYTES) } };
  for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_BYTES, index++) {
    yield { event: 'resource-chunk', data: { ...binding, type: 'chunk', index, data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') } };
  }
  yield { event: 'resource-chunk', data: { ...binding, type: 'commit', totalBytes: bytes.length } };
}

interface PendingOutput {
  envelope: ResourceEnvelope;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** One Fleet HTTP writer. The active record owns the assembly budget;
 * waiting live records share the smaller pending-output budget. */
export class ResourceOutput {
  readonly #pending: PendingOutput[] = [];
  #pendingBytes = 0;
  #active?: PendingOutput;
  #closed = false;
  #releaseDrain?: () => void;
  readonly #abort = () => this.close();
  constructor(
    readonly response: ServerResponse,
    readonly signal: AbortSignal,
    readonly failed: (error: Error) => void,
  ) {
    if (signal.aborted) this.close();
    else {
      signal.addEventListener('abort', this.#abort, { once: true });
      response.once('close', this.#abort);
    }
  }

  send(envelope: ResourceEnvelope): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('resource output closed'));
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (bytes > RESOURCE_ASSEMBLY_BYTES) return this.#fail(new Error('resource assembly limit exceeded'));
    if (this.#active && this.#pendingBytes + bytes > RESOURCE_PENDING_BYTES) {
      return this.#fail(new Error('resource pending limit exceeded'));
    }
    return new Promise<void>((resolve, reject) => {
      const item = { envelope, bytes, resolve, reject };
      if (!this.#active) {
        this.#active = item;
        void this.#pump();
      } else {
        this.#pending.push(item);
        this.#pendingBytes += bytes;
      }
    });
  }

  #fail(error: Error): Promise<never> {
    this.close(error);
    this.failed(error);
    return Promise.reject(error);
  }

  close(error = new Error('resource output closed')): void {
    if (this.#closed) return;
    this.#closed = true;
    this.signal.removeEventListener('abort', this.#abort);
    this.response.removeListener('close', this.#abort);
    this.#releaseDrain?.();
    this.#active?.reject(error);
    for (const item of this.#pending.splice(0)) item.reject(error);
    this.#pendingBytes = 0;
    if (!this.response.destroyed && !this.response.writableEnded) this.response.end();
  }

  async #pump(): Promise<void> {
    try {
      while (this.#active && !this.#closed) {
        const item = this.#active;
        for (const frame of resourceFrames(item.envelope)) {
          if (this.#closed) break;
          const writable = this.response.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
          if (!writable) await this.#drain();
        }
        if (this.#closed) break;
        item.resolve();
        this.#active = this.#pending.shift();
        if (this.#active) this.#pendingBytes -= this.#active.bytes;
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('resource output failed');
      this.close(failure);
      this.failed(failure);
    }
  }

  #drain(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise(resolve => {
      const release = () => {
        this.response.removeListener('drain', release);
        this.#releaseDrain = undefined;
        resolve();
      };
      this.#releaseDrain = release;
      this.response.once('drain', release);
    });
  }
}

export interface ResourceDescriptor {
  viewId: string;
  resource: 'directory' | 'roles' | 'tasks' | 'task-lists' | 'configuration' | 'previews' | 'task-layout' | 'creation-action' | 'action' | 'member-addition' | 'login' | 'onboarding-health' | 'subscriptions';
  entityId?: string;
  receiptId?: string;
  provider?: 'claude' | 'codex';
  includeTemporary?: boolean;
  includeDefinitions?: boolean;
  ids?: string[];
  state?: string;
  list?: string;
  groupByList?: boolean;
  includeDeleting?: boolean;
}
export function canonicalResourceDescriptor(input: unknown): ResourceDescriptor {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('invalid resource descriptor');
  const value = input as ResourceDescriptor;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.viewId) || !['directory','roles','tasks','task-lists','configuration','previews','task-layout','creation-action','action','member-addition','login','onboarding-health','subscriptions'].includes(value.resource)
    || Object.keys(value).some(key => !['viewId','resource','includeTemporary','includeDefinitions','ids','state','list','groupByList','includeDeleting','entityId','receiptId','provider'].includes(key))) throw Error('invalid resource descriptor');
  for (const key of ['includeTemporary','includeDefinitions','groupByList','includeDeleting'] as const) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw Error('invalid resource descriptor');
  if (value.ids !== undefined && (!Array.isArray(value.ids) || value.ids.length > 500 || value.ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(id)))) throw Error('invalid resource ids');
  if (value.state !== undefined && !['all','backlog','provisioning','active','review','done','cancelled','failed'].includes(value.state)) throw Error('invalid resource state');
  if (value.list !== undefined && (typeof value.list !== 'string' || value.list.length > 256)) throw Error('invalid resource list');
  for (const key of ['entityId','receiptId'] as const) if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value[key]!))) throw Error('invalid resource target');
  if (['task-layout','creation-action','action','member-addition','login'].includes(value.resource) && !value.entityId) throw Error('resource target required');
  if (value.resource==='member-addition' && !value.receiptId) throw Error('receipt required');
  if (value.resource==='login' && !['claude','codex'].includes(value.provider??'')) throw Error('provider required');
  return { ...value, ...(value.ids ? { ids: [...new Set(value.ids)] } : {}) };
}
interface View {
  descriptor: ResourceDescriptor; epoch: number; baselineId: string; controller: AbortController;
  revision: number; sequence: number; dirty: boolean; running: boolean; failed: boolean;
  initial: Promise<BoundProjection>; resolveInitial(value: BoundProjection): void; rejectInitial(error: Error): void;
  payload?: unknown; covered?: FleetResourceState;
  source: ReturnType<ReturnType<typeof observeFleetResources>['cursor']>; scheduledPosition: number;
  captureSource: ReturnType<ReturnType<typeof observeFleetResources>['cursor']>;
}
interface BoundProjection {
  payload: unknown; source: FleetResourceState; producerGeneration: string; revision: number; baselineId: string; descriptor: ResourceDescriptor;
}
interface Connection {
  id: string; owner: string; controller: AbortController; output: ResourceOutput;
  views: Map<string, View>; epochs: Map<string, number>;
  observer: ReturnType<typeof observeFleetResources>; tail: Promise<void>; close(): void;
}
export class ResourceBindingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/** Same committed snapshot/ready/bound-read contract as Messenger. No controllers,
 * notification reads or presence are acquired by this delivery owner. */
export class FleetResourceViews {
  readonly producerGeneration = randomUUID();
  private connections = new Map<string, Connection>();
  constructor(private scope: FleetResourceScope, private project: (descriptor: ResourceDescriptor, signal: AbortSignal, owner: string) => Promise<unknown>) {}
  open(response: ServerResponse, owner: string, authorized: () => boolean) {
    const id = randomUUID(), controller = new AbortController();
    let connection: Connection | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (controller.signal.aborted) return;
      controller.abort(); clearInterval(timer); this.connections.delete(id);
      if (connection) {
        for (const view of connection.views.values()) this.retire(view);
        connection.views.clear(); connection.output.close();
      }
      response.off('close', close);
    };
    const output = new ResourceOutput(response, controller.signal, close);
    const observer = observeFleetResources(this.scope, state => {
      if (!connection || controller.signal.aborted) return;
      if (state.health !== 'healthy') {
        const pending = [...connection.views.values()].map(view => {
          view.failed = true; view.rejectInitial(Error('resource observation unavailable')); view.controller.abort();
          return this.emit(connection!, view, 'health', { healthy: false, reason: state.health === 'unsupported' ? 'unsupported' : 'upstream_unavailable' });
        });
        if (!pending.length) response.write(`event: resource-service-health\ndata: ${JSON.stringify({protocolVersion:1, healthy:false, reason:state.health === 'unsupported' ? 'unsupported' : 'upstream_unavailable'})}\n\n`);
        void Promise.allSettled(pending).then(close);
      } else for (const view of connection.views.values()) if (view.source.snapshot().position !== view.scheduledPosition) this.schedule(connection, view);
    }, controller.signal);
    connection = { id, owner, controller, output, views: new Map(), epochs: new Map(), observer, tail: Promise.resolve(), close };
    this.connections.set(id, connection); response.once('close', close);
    response.write(`event: resource-connection\ndata: ${JSON.stringify({ protocolVersion:1, connectionId:id, producerGeneration:this.producerGeneration, continuity:'reset', baselineRequired:true })}\n\n`);
    if (observer.snapshot().health !== 'healthy') {
      response.write(`event: resource-service-health\ndata: ${JSON.stringify({protocolVersion:1,healthy:false,reason:observer.snapshot().health === 'unsupported' ? 'unsupported':'upstream_unavailable'})}\n\n`); close();
    } else {
      timer = setInterval(() => {
        if (!authorized()) { close(); return; }
        for (const view of connection!.views.values()) if (!view.failed && view.covered && view.covered.position===view.source.snapshot().position) void this.emit(connection!, view, 'coverage', { source:view.covered }).catch(close);
        // Keep the transport live with no subscribed views; never claim source coverage from bytes.
        if (!connection!.views.size) response.write(': keepalive\n\n');
      }, 2000); timer.unref();
    }
    return { connectionId:id, close };
  }
  register(owner: string, connectionId: string, viewId: string, epoch: number, input: unknown) {
    const connection = this.get(owner, connectionId);
    let descriptor: ResourceDescriptor;
    try { descriptor = canonicalResourceDescriptor(input); } catch { throw new ResourceBindingError(400, 'invalid resource descriptor'); }
    if (descriptor.viewId !== viewId || !Number.isSafeInteger(epoch) || epoch < 1) throw new ResourceBindingError(400, 'invalid resource epoch');
    if ((connection.epochs.get(viewId) ?? 0) >= epoch) throw new ResourceBindingError(409, 'obsolete resource epoch');
    if (connection.observer.snapshot().health !== 'healthy') throw new ResourceBindingError(503, 'resource observation unavailable');
    if(!connection.epochs.has(viewId) && connection.epochs.size>=256)throw new ResourceBindingError(503,'resource epoch capacity exceeded');
    if(!connection.views.has(viewId) && connection.views.size>=64)throw new ResourceBindingError(409,'resource view capacity exceeded');
    const old = connection.views.get(viewId); if (old) this.retire(old);
    let resolveInitial!: View['resolveInitial'], rejectInitial!: View['rejectInitial'];
    const initial = new Promise<BoundProjection>((resolve, reject) => {resolveInitial=resolve;rejectInitial=reject;}); void initial.catch(()=>{});
    const controller = new AbortController();
    const source = connection.observer.cursor(path => this.affects(descriptor, path), controller.signal);
    // Independent agents contribute ordered, last-observed statuses. Their
    // ledger commits wake the view but do not revoke its structural capture.
    const captureSource = descriptor.resource === 'directory' || descriptor.resource === 'roles'
      ? connection.observer.cursor(path => this.affects(descriptor, path, true), controller.signal)
      : source;
    const view: View = {source,captureSource,scheduledPosition:-1,descriptor,epoch,baselineId:randomUUID(),controller,revision:0,sequence:0,dirty:false,running:false,failed:false,initial,resolveInitial,rejectInitial};
    connection.views.set(viewId, view); connection.epochs.set(viewId, epoch); this.schedule(connection,view);
    return {subscriptionEpoch:epoch,baselineId:view.baselineId};
  }
  remove(owner: string, connectionId: string, viewId: string, epoch: number) {
    const connection = this.get(owner,connectionId),view=connection.views.get(viewId);
    if (typeof viewId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(viewId) || !Number.isSafeInteger(epoch) || epoch < 1) throw new ResourceBindingError(400,'invalid resource epoch');
    if (!connection.epochs.has(viewId) && connection.epochs.size >= 256) throw new ResourceBindingError(503,'resource epoch capacity exceeded');
    // Independent DELETE can arrive before the POST it retires.
    connection.epochs.set(viewId, Math.max(connection.epochs.get(viewId) ?? 0, epoch));
    if (view && epoch >= view.epoch) { this.retire(view); connection.views.delete(viewId); }
  }
  async bound(owner:string,connectionId:string,viewId:string,epoch:number,baselineId:string):Promise<BoundProjection> {
    const connection=this.get(owner,connectionId),view=connection.views.get(viewId);
    if (!view || view.epoch!==epoch || view.baselineId!==baselineId) throw new ResourceBindingError(409,'resource binding mismatch');
    const baseline=await view.initial;
    if (!this.current(connection,view) || view.failed) throw new ResourceBindingError(409,'resource binding retired');
    return baseline;
  }
  close() {for(const connection of this.connections.values())connection.close();}
  private get(owner:string,id:string) {
    const connection=this.connections.get(id);
    if(!connection || connection.owner!==owner)throw new ResourceBindingError(409,'unknown resource connection');return connection;
  }
  private current(connection:Connection,view:View) {return !connection.controller.signal.aborted && !view.controller.signal.aborted && connection.views.get(view.descriptor.viewId)===view;}
  private retire(view:View) {view.controller.abort();view.rejectInitial(new ResourceBindingError(409,'resource binding retired'));}
  private emit(connection:Connection,view:View,kind:ResourceEnvelope['kind'],payload:unknown) {
    return connection.output.send({protocolVersion:1,producerGeneration:this.producerGeneration,viewId:view.descriptor.viewId,subscriptionEpoch:view.epoch,baselineId:view.baselineId,sequence:++view.sequence,revision:view.revision,kind,payload} as ResourceEnvelope);
  }
  private affects(descriptor: ResourceDescriptor, path: string, structural = false): boolean {
    // Only classify known activity writes under the configured role roots.
    // Parent/unknown events and every other file retain full invalidation.
    // The canonical web producer atomically replaces hashed checkpoint files.
    // These delivery acknowledgements are not role/task/config membership;
    // retain full wakes without requiring an outbox-quiet capture window.
    if (structural && /^[a-f0-9]{64}\.json$/.test(relative(resolve(stateRoot(), 'web', 'notification-outboxes'), path))) return false;
    const roots = this.scope.roots ?? [agentsRoot(), tmpRoot()];
    for (const root of roots) {
      const parts = relative(resolve(root), path).split(sep);
      if (parts[0] === '..') continue;
      // Both session backends append diagnostic events as well as durable
      // conversation events; ACP usage updates also persist observed usage.
      // Monitor cursor/state and its presented status are per-agent activity.
      // None changes role membership/configuration. Keep these as full wakes.
      if (structural && parts.length === 2 && ['.session-events.jsonl', '.session-events.jsonl.1', '.subscription-usage.json', '.notify-cursor', '.monitor-state.json', '.monitor-status'].includes(parts[1])) return false;
      if (parts.length < 3 || parts[1] !== '.conversation') continue;
      if (structural && (descriptor.resource === 'directory' || descriptor.resource === 'roles')) return false;
      if (descriptor.resource === 'previews') return (descriptor.ids ?? []).includes(parts[0]);
      // Configuration/provenance reads no conversation data. Directory and
      // roles intentionally remain conservative: live status includes activity.
      if (descriptor.resource === 'configuration') return false;
    }
    return true;
  }
  private schedule(connection:Connection,view:View) {
    if(!this.current(connection,view)||view.failed)return;
    view.scheduledPosition=view.source.snapshot().position;
    view.dirty=true;if(view.running)return;view.running=true;
    const task=connection.tail.then(()=>this.refresh(connection,view));connection.tail=task.catch(()=>{});
    void task.finally(()=>{view.running=false;if(view.dirty)this.schedule(connection,view);}).catch(connection.close);
  }
  private async refresh(connection:Connection,view:View) {
    try {
      if(!view.dirty||!this.current(connection,view))return;
      view.dirty=false;
      let payload:unknown,source:FleetResourceState|undefined;
      for(let attempt=0;attempt<3;attempt++) {
        view.controller.signal.throwIfAborted();
        const before=view.captureSource.snapshot();
        const covered=view.source.snapshot();
        payload=await abortableProjection(this.project(view.descriptor,view.controller.signal,connection.owner),view.controller.signal);
        view.controller.signal.throwIfAborted();
        const after=view.captureSource.snapshot();
        if(after.health!=='healthy')throw Error('resource observation unavailable');
        // Certify only the starting wake barrier. Status commits during the
        // asynchronous canonical read stay dirty and are drained in order by
        // the next serialized capture, even if this read happened to see them.
        if(before.position===after.position) {source=covered;break;}
      }
      if(!source)throw Error('resource projection unstable');
      if(!this.current(connection,view))return;
      const first=view.payload===undefined,changed=first||JSON.stringify(payload, (key,value)=>key==='observedAt'?undefined:value)!==JSON.stringify(view.payload, (key,value)=>key==='observedAt'?undefined:value);
      view.covered=source;
      if(changed) {view.revision++;await this.emit(connection,view,'snapshot',payload);if(!this.current(connection,view))return;view.payload=payload;}
      if(first) {
        await this.emit(connection,view,'ready',{baselineId:view.baselineId,source});
        if(this.current(connection,view))view.resolveInitial({payload,source,producerGeneration:this.producerGeneration,revision:view.revision,baselineId:view.baselineId,descriptor:view.descriptor});
      } else await this.emit(connection,view,'coverage',{source});
    } catch(error) {
      if(!this.current(connection,view))return;view.failed=true;
      view.rejectInitial(error instanceof Error?error:Error('projection failed'));
      await this.emit(connection,view,'resync',{reason:'projection_unavailable'}).catch(connection.close);
    }
  }
}
