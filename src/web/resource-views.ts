import { relative, resolve, sep } from 'node:path';
import { agentsRoot, tmpRoot, stateRoot, defaultConfigPath, fleetDDir } from '../paths.js';
import { splitRootFor } from '../config.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
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
  readonly source?: FleetResourceState;
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
interface ResourceCoverage { protocolVersion: 1; producerGeneration: string; views: Array<ResourceFrameBinding & { source: FleetResourceState }> }
type ResourceOutputRecord = ResourceEnvelope | ResourceCoverage;
export interface ResourceWireFrame { event: 'resource' | 'resource-chunk' | 'resource-coverage'; data: Record<string, unknown> }
export const RESOURCE_FRAME_BYTES = 512 * 1024;
export const RESOURCE_PENDING_BYTES = 8 * 1024 * 1024;
export const RESOURCE_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
/** Minimum spacing of activity-only follow-up captures of one view. */
export const ACTIVITY_CAPTURE_INTERVAL_MS = 1000;
/** Sparse health: a current view is qualified at most this often without data. */
const COVERAGE_INTERVAL_MS = 15000;

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
  envelope: ResourceOutputRecord;
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

  send(envelope: ResourceOutputRecord, admitted?: () => void): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('resource output closed'));
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (bytes > RESOURCE_ASSEMBLY_BYTES) return this.#fail(new Error('resource assembly limit exceeded'));
    if (this.#active && this.#pendingBytes + bytes > RESOURCE_PENDING_BYTES) {
      return this.#fail(new Error('resource pending limit exceeded'));
    }
    admitted?.();
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
        for (const frame of ('views' in item.envelope ? [{event:'resource-coverage' as const,data:item.envelope as unknown as Record<string,unknown>}] : resourceFrames(item.envelope))) {
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
  /** Previews: each agent's newest assistant message time only, without its text. */
  activityOnly?: boolean;
}
export function canonicalResourceDescriptor(input: unknown): ResourceDescriptor {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('invalid resource descriptor');
  const value = input as ResourceDescriptor;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.viewId) || !['directory','roles','tasks','task-lists','configuration','previews','task-layout','creation-action','action','member-addition','login','onboarding-health','subscriptions'].includes(value.resource)
    || Object.keys(value).some(key => !['viewId','resource','includeTemporary','includeDefinitions','ids','state','list','groupByList','includeDeleting','entityId','receiptId','provider','activityOnly'].includes(key))) throw Error('invalid resource descriptor');
  if (value.activityOnly !== undefined && value.resource !== 'previews') throw Error('invalid resource descriptor');
  for (const key of ['includeTemporary','includeDefinitions','groupByList','includeDeleting','activityOnly'] as const) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw Error('invalid resource descriptor');
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
  payload?: unknown; covered?: FleetResourceState; qualifiedAt?: number;
  source: ReturnType<ReturnType<typeof observeFleetResources>['cursor']>; scheduledPosition: number;
  captureSource: ReturnType<ReturnType<typeof observeFleetResources>['cursor']>;
  /** Start time and structural position of the latest capture; a deferred activity follow-up. */
  capturedAt?: number; capturedStructure?: number; activityTimer?: ReturnType<typeof setTimeout>;
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
  constructor(private scope: FleetResourceScope, private project: (descriptor: ResourceDescriptor, signal: AbortSignal, owner: string) => Promise<unknown>,
    private configurationInputs: () => readonly string[] = () => [],
    private activityCaptureIntervalMs = ACTIVITY_CAPTURE_INTERVAL_MS) {}
  open(response: ServerResponse, owner: string, authorized: () => boolean) {
    const id = randomUUID(), controller = new AbortController();
    let connection: Connection | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let healthTimer: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (controller.signal.aborted) return;
      controller.abort(); clearInterval(timer); clearInterval(healthTimer); this.connections.delete(id);
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
      // Preserve credential retirement timing independently of sparse wire health.
      timer = setInterval(() => {
        if (!authorized()) { close(); return; }
      }, 2000); timer.unref();
      healthTimer = setInterval(() => {
        if (!authorized()) { close(); return; }
        this.coverage(connection!).catch(close);
        if (!connection!.views.size) response.write(': keepalive\n\n');
      }, COVERAGE_INTERVAL_MS); healthTimer.unref();
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
    // Independent agents contribute ordered, last-observed statuses and completed
    // preview records. Activity wakes follow-up reads without revoking structural
    // capture; the read still certifies only its starting source watermark.
    const captureSource = descriptor.resource === 'directory' || descriptor.resource === 'roles' || descriptor.resource === 'previews'
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
  private retire(view:View) {clearTimeout(view.activityTimer);view.activityTimer=undefined;view.controller.abort();view.rejectInitial(new ResourceBindingError(409,'resource binding retired'));}
  private emit(connection:Connection,view:View,kind:ResourceEnvelope['kind'],payload:unknown,source?:FleetResourceState) {
    return connection.output.send({protocolVersion:1,producerGeneration:this.producerGeneration,viewId:view.descriptor.viewId,subscriptionEpoch:view.epoch,baselineId:view.baselineId,sequence:view.sequence+1,revision:view.revision,kind,payload,...(source?{source}:{})} as ResourceEnvelope,()=>{view.sequence++;if(source||kind==='ready')view.qualifiedAt=Date.now();});
  }
  // Admission allocates sequences atomically; the existing writer keeps this
  // complete batch behind any active chunk assembly and earlier data records.
  private coverage(connection:Connection) {
    const now=Date.now();
    return this.cover(connection,[...connection.views.values()].filter(view=>!view.running&&!view.dirty&&view.covered?.position===view.source.snapshot().position&&now-(view.qualifiedAt??0)>=COVERAGE_INTERVAL_MS),now);
  }
  /** Certify each view's last projected source; never a position its capture did not read. */
  private cover(connection:Connection,candidates:View[],now:number) {
    const eligible=candidates.filter(view=>this.current(connection,view)&&!view.failed&&view.payload!==undefined&&view.covered&&view.covered.health==='healthy');
    if(!eligible.length)return Promise.resolve();
    const views=eligible.map(view=>({protocolVersion:1 as const,producerGeneration:this.producerGeneration,viewId:view.descriptor.viewId,subscriptionEpoch:view.epoch,baselineId:view.baselineId,sequence:view.sequence+1,revision:view.revision,source:view.covered!}));
    return connection.output.send({protocolVersion:1,producerGeneration:this.producerGeneration,views},()=>{for(const view of eligible){view.sequence++;view.qualifiedAt=now;}});
  }
  /** Whether `path` is, contains or lies within the manifest, its split definitions or another configuration input. */
  private configurationDependency(path: string): boolean {
    const manifest = resolve(this.scope.configPath ?? defaultConfigPath());
    const root = resolve(splitRootFor(manifest)), changed = resolve(path);
    const within = (candidate: string, parent: string) => {
      const local = relative(parent, candidate);
      return local === '' || (local !== '..' && !local.startsWith('..' + sep));
    };
    // Configuration and provenance read the manifest and split definitions;
    // loadConfig also rejects legacy YAML files in the global fleet.d root.
    // Ancestor replacement/unknown directory wakes remain conservative.
    const legacy = resolve(fleetDDir());
    return within(changed, root) || within(root, changed) || within(manifest, changed)
      || within(changed, legacy) || within(legacy, changed)
      || this.configurationInputs().some(input => within(resolve(input), changed));
  }
  private affects(descriptor: ResourceDescriptor, path: string, structural = false): boolean {
    if (descriptor.resource === 'configuration') return this.configurationDependency(path);
    // An explicitly selected manifest may use any pathname, including one
    // otherwise reserved for an independent task receipt.
    if (this.scope.configPath && resolve(path) === resolve(this.scope.configPath)) return true;
    // These projections read role config/private status and conversation ledgers,
    // not adopted Codex telemetry or this gateway's auth/audit bookkeeping. Those
    // writes otherwise invalidate every in-flight directory capture on a busy host.
    // Keep explicit config, declared role roots and unknown/ancestor wakes fenced.
    const roots = this.scope.roots ?? [agentsRoot(), tmpRoot()];
    const roleProjection = ['directory', 'roles', 'previews'].includes(descriptor.resource);
    const inRoleRoot = roots.some(root => { const local = relative(resolve(root), path); return local === '' || (local !== '..' && !local.startsWith('..' + sep)); });
    if (roleProjection && !inRoleRoot && (
      /^(?:history\.jsonl|models_cache\.json|(?:thread_history|state|logs|queue|goals)_\d+\.sqlite(?:-wal|-shm|-journal)?)$/.test(relative(resolve(homedir(), '.codex'), path))
      || /^(?:workspace-devices\.db(?:-wal|-shm|-journal)?|audit[/\\]audit\.jsonl)$/.test(relative(resolve(stateRoot(), 'web'), path))
    )) return false;
    // Task and room workspaces hold their agents' own execution artifacts (checkouts,
    // builds, test logs); role projections read nothing there except declared role
    // roots and configuration (manifest, split definitions), which stay fenced. Working
    // agents write there continuously, which otherwise fences every directory capture
    // until it resyncs. The workspace directories themselves and their ancestors remain full wakes.
    if (roleProjection && !inRoleRoot && /^(?:tasks|rooms)[/\\][^/\\]+[/\\]/.test(relative(resolve(stateRoot(), 'workspaces'), path))
      && !this.configurationDependency(path)) return false;
    // Preview selection reads role config/state and conversation ledgers, never
    // task layout run/operation/brief receipts. A worker may commit several of
    // these while that independent canonical preview read is in flight.
    // Unknown paths and directory-level events retain full invalidation.
    if (descriptor.resource === 'previews' && /^task-[A-Za-z0-9_-]+(?:\.op\.json|\.json|\.brief\.md)$/.test(relative(resolve(stateRoot(), 'layouts'), path))) return false;
    // Only classify known activity writes under the configured role roots.
    // Parent/unknown events and every other file retain full invalidation.
    // The canonical web producer atomically replaces hashed checkpoint files,
    // once per ledger advance of any role. No projection reads these delivery
    // acknowledgements, so they neither fence a capture nor wake a follow-up.
    if (/^[a-f0-9]{64}\.json$/.test(relative(resolve(stateRoot(), 'web', 'notification-outboxes'), path))) return false;
    for (const root of roots) {
      const parts = relative(resolve(root), path).split(sep);
      if (parts[0] === '..') continue;
      // Both session backends append diagnostic events as well as durable
      // conversation events; ACP usage updates also persist observed usage.
      // Monitor cursor/state and its presented status are per-agent activity.
      // None changes role membership/configuration. Keep these as full wakes.
      if (structural && parts.length === 2 && ['.session-events.jsonl', '.session-events.jsonl.1', '.subscription-usage.json', '.notify-cursor', '.monitor-state.json', '.monitor-status'].includes(parts[1])) return false;
      // A starting or running member also commits its supervisor/session status
      // (restart ledger, exit, daemon recovery, control endpoint, monitor owner) and
      // runner bookkeeping no projection reads. Neither changes membership; while
      // members start, fencing on them left no stable directory capture.
      if (structural && parts.length === 2 && ['.restart-ledger.json', '.exit-status', '.daemon-recovery.json', '.control-token', '.control.sock', '.monitor-owner', '.booted', '.supervisor-run.json', '.subscription-pin.json', '.session-ownership.json', '.managed-recovery.json', '.acp-session-id', '.self-reminders.json', 'supervisor.log', 'WORKLOG.md'].includes(parts[1])) return false;
      if (structural && parts.length >= 2 && ['.ours-bridge', '.task-supervisor'].includes(parts[1])) return false;
      if (parts.length < 3 || parts[1] !== '.conversation') continue;
      if (structural && (descriptor.resource === 'directory' || descriptor.resource === 'roles')) return false;
      if (descriptor.resource === 'previews') {
        // conversationPreview reads bounded completed records, independently per
        // role. These known writer paths still wake ordered follow-up captures.
        // Unknown children, parent replacement and explicit config paths retain
        // their capture fence; do not waive the whole conversation subtree.
        if (structural && parts.length === 3 && /^(?:events-\d{6}\.jsonl|manifest\.json)$/.test(parts[2])) return false;
        return (descriptor.ids ?? []).includes(parts[0]);
      }
      // Directory and roles intentionally remain conservative: live status
      // includes activity. Configuration was classified by its inputs above.
    }
    return true;
  }
  private schedule(connection:Connection,view:View,due=false) {
    if(!this.current(connection,view)||view.failed)return;
    // Agent activity (ledger appends, status files) changes previews and status
    // continuously while an agent works. Without a structural change since the
    // latest capture began, coalesce those wakes into one trailing capture per
    // interval instead of re-projecting every role after every append.
    const wait=!due && view.captureSource!==view.source && view.capturedAt!==undefined
      && view.captureSource.snapshot().position===view.capturedStructure
      ? this.activityCaptureIntervalMs-(Date.now()-view.capturedAt) : 0;
    if(wait>0) {
      view.scheduledPosition=view.source.snapshot().position;view.dirty=true;
      if(!view.running && !view.activityTimer) {
        // The trailing capture runs when its timer fires, whatever the clock reads.
        view.activityTimer=setTimeout(()=>{view.activityTimer=undefined;this.schedule(connection,view,true);},Math.min(wait,this.activityCaptureIntervalMs));
        view.activityTimer.unref?.();
      }
      return;
    }
    clearTimeout(view.activityTimer);view.activityTimer=undefined;
    view.scheduledPosition=view.source.snapshot().position;
    view.dirty=true;if(view.running)return;view.running=true;
    const task=connection.tail.then(async()=>{
      // Resolved projection promises must not starve HTTP, timers or native
      // watch delivery. Preserve serialization and coalesce this event batch.
      await yieldToEventLoop();
      if(!this.current(connection,view)||view.failed)return;
      await this.refresh(connection,view);
    });connection.tail=task.catch(()=>{});
    void task.finally(()=>{view.running=false;if(view.dirty)this.schedule(connection,view);}).catch(connection.close);
  }
  private async refresh(connection:Connection,view:View) {
    try {
      if(!view.dirty||!this.current(connection,view))return;
      view.dirty=false;view.capturedAt=Date.now();view.capturedStructure=view.captureSource.snapshot().position;
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
      if(changed) {view.revision++;await this.emit(connection,view,'snapshot',payload,source);if(!this.current(connection,view))return;view.payload=payload;}
      // Sustained activity can keep a view dirty at every health tick while its payload is
      // unchanged; the completed capture still qualifies the source it read.
      else if(Date.now()-(view.qualifiedAt??0)>=COVERAGE_INTERVAL_MS)await this.cover(connection,[view],Date.now());
      if(first) {
        await this.emit(connection,view,'ready',{baselineId:view.baselineId,source});
        if(this.current(connection,view))view.resolveInitial({payload,source,producerGeneration:this.producerGeneration,revision:view.revision,baselineId:view.baselineId,descriptor:view.descriptor});
      }
    } catch(error) {
      if(!this.current(connection,view))return;view.failed=true;
      view.rejectInitial(error instanceof Error?error:Error('projection failed'));
      await this.emit(connection,view,'resync',{reason:'projection_unavailable'}).catch(connection.close);
    }
  }
}
