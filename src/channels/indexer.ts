import { IdentityReadError, type ContactsActivity, type IdentityReader } from './identity-reads.js';
import { norm, type ChannelSources, type PerspectiveSource } from './sources.js';
import type { ChannelEdge, ChannelsStore } from './store.js';

export interface ResourceFrame { kind: string; producerGeneration: string; position: number }
export interface ResourceEventSource {
  resourceEvents(identity: string, options: { signal: AbortSignal; expectedGeneration?: string; after?: number }): AsyncIterable<ResourceFrame>;
}
export interface ChannelsIndexerDeps {
  store: ChannelsStore;
  reader: IdentityReader;
  events: ResourceEventSource;
  discover(): Promise<ChannelSources>;
  onChange(): void;
  log(message: string): void;
  debounceMs?: number;
}

interface Watch {
  source: PerspectiveSource;
  abort: AbortController;
  generation?: string;
  position?: number;
  timer?: ReturnType<typeof setTimeout>;
  inflight: boolean;
  dirty: boolean;
}

/**
 * Event-driven Channels projection. One passive resource-event stream per live
 * perspective source; idle coverage frames are ignored and a committed frame
 * only schedules work when the source position advanced. Work is debounced,
 * at most one observation runs per source, and each observation reads only
 * that source's contacts and activity (one lease-free daemon read), never other sources.
 */
export class ChannelsIndexer {
  private readonly watches = new Map<string, Watch>();
  private internal = new Set<string>();
  private syncing?: Promise<void>;
  private resync = false;
  private stopped = false;
  private readonly debounceMs: number;
  constructor(private readonly deps: ChannelsIndexerDeps) { this.debounceMs = deps.debounceMs ?? 250; }

  /** Re-derive sources and the exclusion set; start/stop streams accordingly. */
  sync(): Promise<void> {
    if (this.syncing) { this.resync = true; return this.syncing; }
    this.syncing = (async () => {
      try {
        do { this.resync = false; await this.syncOnce(); } while (this.resync && !this.stopped);
      } finally { this.syncing = undefined; }
    })();
    return this.syncing;
  }

  stop(): void {
    this.stopped = true;
    for (const watch of this.watches.values()) this.retire(watch);
    this.watches.clear();
  }

  private async syncOnce(): Promise<void> {
    if (this.stopped) return;
    const found = await this.deps.discover();
    if (this.stopped) return;
    const internalChanged = found.internal.size !== this.internal.size || [...found.internal].some(cid => !this.internal.has(cid));
    this.internal = found.internal;
    this.deps.store.setSources(found.sources);
    const live = new Map(found.sources.filter(s => !s.ended).map(s => [s.cid, s]));
    for (const [cid, watch] of this.watches) {
      const next = live.get(cid);
      if (!next || next.name !== watch.source.name) { this.retire(watch); this.watches.delete(cid); }
      else watch.source = next;
    }
    for (const source of live.values()) {
      let watch = this.watches.get(source.cid);
      if (!watch) {
        watch = { source, abort: new AbortController(), inflight: false, dirty: false };
        this.watches.set(source.cid, watch);
        void this.follow(watch);
        this.schedule(watch); // bounded bootstrap/backfill for a new source
      } else if (internalChanged) this.schedule(watch);
    }
    this.deps.onChange();
  }

  private retire(watch: Watch): void {
    watch.abort.abort();
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = undefined;
  }

  private async follow(watch: Watch): Promise<void> {
    let backoff = 1_000;
    while (!watch.abort.signal.aborted) {
      try {
        for await (const frame of this.deps.events.resourceEvents(watch.source.name, {
          signal: watch.abort.signal, ...(watch.generation ? { expectedGeneration: watch.generation } : {}),
        })) {
          backoff = 1_000;
          if (frame.kind === 'coverage') continue;
          // ready/committed at the already-observed position change nothing; resync always reads.
          if (frame.kind !== 'resync' && frame.producerGeneration === watch.generation && frame.position === watch.position) continue;
          if (frame.producerGeneration !== watch.generation) watch.position = undefined;
          watch.generation = frame.producerGeneration;
          this.schedule(watch);
        }
      } catch (error) {
        if (watch.abort.signal.aborted) return;
        this.deps.log(`channels: ${watch.source.name} event stream interrupted: ${(error as Error).message}`);
      }
      if (watch.abort.signal.aborted) return;
      // The stream ended or failed: data may be behind until it is re-established.
      watch.generation = undefined;
      this.deps.store.markStale(watch.source.cid);
      this.deps.onChange();
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private schedule(watch: Watch): void {
    watch.dirty = true;
    if (watch.timer || watch.inflight || watch.abort.signal.aborted) return;
    watch.timer = setTimeout(() => { watch.timer = undefined; void this.run(watch); }, this.debounceMs);
  }

  private async run(watch: Watch): Promise<void> {
    if (watch.inflight || watch.abort.signal.aborted) return;
    watch.inflight = true; watch.dirty = false;
    try {
      const observation = await this.observe(watch);
      if (!observation || watch.abort.signal.aborted) return;
      this.deps.store.replaceEdges(watch.source.cid, edgesFrom(observation, this.internal));
      watch.generation = observation.source.producerGeneration;
      watch.position = observation.source.position;
      this.deps.onChange();
    } catch (error) {
      this.deps.store.markStale(watch.source.cid);
      this.deps.onChange();
      if (error instanceof IdentityReadError && (error.code === 'identity_not_found' || error.code === 'identity_mismatch')) void this.sync();
      else this.deps.log(`channels: ${watch.source.name} observation failed: ${(error as Error).message}`);
    } finally {
      watch.inflight = false;
      if (watch.dirty && !watch.abort.signal.aborted) this.schedule(watch);
    }
  }

  private async observe(watch: Watch): Promise<ContactsActivity | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.reader.contactsActivity({
          identity: watch.source.name, expectedCid: watch.source.cid,
          ...(watch.generation ? { expectedProducerGeneration: watch.generation } : {}),
        }, watch.abort.signal);
      } catch (error) {
        if (!(error instanceof IdentityReadError) || attempt >= 2) throw error;
        // A new daemon source generation (daemon restart): drop the stale pin and read again.
        if (error.code === 'source_generation_changed') { watch.generation = undefined; watch.position = undefined; continue; }
        // The identity committed during the read: its own wake will follow; retry briefly.
        if (error.code !== 'source_changed') throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        if (watch.abort.signal.aborted) return undefined;
      }
    }
  }
}

/** Contacts of one observation, minus internal identities, as metadata-only edges. */
export function edgesFrom(observation: ContactsActivity, internal: Set<string>): ChannelEdge[] {
  const edges: ChannelEdge[] = [];
  for (const contact of observation.contacts) {
    const cid = norm(contact.container_id);
    if (internal.has(cid)) continue;
    const activity = observation.activity[contact.container_id];
    const root = observation.roots[contact.container_id];
    edges.push({
      contactCid: cid, contactName: contact.name,
      lastActivity: activity && 'at' in activity ? activity.at : '',
      ...(root?.root_cid ? { rootCid: norm(root.root_cid), rootName: root.root_name, roleId: root.role_id } : {}),
    });
  }
  return edges;
}
