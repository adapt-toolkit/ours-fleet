import { FleetError } from '../application/errors.js';
import { IdentityReadError, type IdentityHistoryPage, type IdentityReader } from './identity-reads.js';
import type { ChannelsIndexer } from './indexer.js';
import type { ChannelPage, ChannelPerspective, ChannelRow, ChannelsStore } from './store.js';

export interface ChannelsServiceDeps {
  store: ChannelsStore;
  reader: IdentityReader;
  indexer: ChannelsIndexer;
  /** Actual root CID of this workspace's Owner, when known. */
  ownerRoot(): string | undefined;
  /** False until the first discovery completed. */
  ready(): boolean;
}

export type ChannelRowView = ChannelRow & { claimsOwnerRoot: boolean };

/**
 * Owner-facing Channels queries over the durable projection. Served only
 * behind the Fleet web Owner session; agents get no route to it.
 */
export class ChannelsService {
  constructor(private readonly deps: ChannelsServiceDeps) {}

  status(): { ready: boolean; sources: ReturnType<ChannelsStore['sourcesSummary']> } {
    return { ready: this.deps.ready(), sources: this.deps.store.sourcesSummary() };
  }

  private view(row: ChannelRow): ChannelRowView {
    const root = this.deps.ownerRoot();
    return { ...row, claimsOwnerRoot: !!root && row.claimedRoot?.rootCid === root };
  }

  list(options: { cursor?: string; limit?: number; q?: string; root?: string }): ChannelPage & { channels: ChannelRowView[] } {
    let page: ChannelPage;
    try { page = this.deps.store.list(options); }
    catch (error) { throw new FleetError('invalid_request', (error as Error).message); }
    return { ...page, channels: page.channels.map(row => this.view(row)) };
  }

  /** The SSE snapshot: the first Recent page. */
  snapshot(): { ready: boolean; channels: ChannelRowView[]; nextCursor: string | null } {
    const page = this.deps.store.list({ limit: 50 });
    return { ready: this.deps.ready(), channels: page.channels.map(row => this.view(row)), nextCursor: page.nextCursor };
  }

  get(cid: string): { channel: ChannelRowView; perspectives: ChannelPerspective[] } {
    const found = this.deps.store.get(cid);
    if (!found) throw new FleetError('resource_not_found', 'no such channel');
    return { channel: this.view(found.channel), perspectives: found.perspectives };
  }

  /**
   * One perspective's own history with this contact; never a merged view, never consuming.
   * Pinned to the source's CID and last observed daemon source generation; a response is
   * released only while that same perspective is still current.
   */
  async history(contactCid: string, sourceCid: string, page: { before_seq?: number; limit?: number }): Promise<IdentityHistoryPage & { perspective: { sourceCid: string; kind: string; roleId?: string } }> {
    const contact = contactCid.toUpperCase(), source = sourceCid.toUpperCase();
    const perspective = this.deps.store.hasPerspective(contact, source);
    if (!perspective) throw new FleetError('resource_not_found', 'that identity is not a perspective of this channel');
    if (perspective.ended) throw new FleetError('capability_unavailable', 'this perspective has ended; its history is no longer available');
    let result: IdentityHistoryPage;
    try {
      result = await this.deps.reader.history({
        identity: perspective.name, expectedCid: source, peer_cid: contact,
        ...(perspective.generation ? { expectedProducerGeneration: perspective.generation } : {}),
        ...(page.before_seq !== undefined ? { before_seq: page.before_seq } : {}),
        ...(page.limit !== undefined ? { limit: page.limit } : {}),
      });
    } catch (error) {
      if (error instanceof IdentityReadError) {
        if (error.code === 'identity_not_found' || error.code === 'identity_mismatch') {
          void this.deps.indexer.sync();
          throw new FleetError('resource_not_found', 'this perspective is no longer available');
        }
        if (error.code === 'source_generation_changed') {
          // The daemon restarted under this perspective: re-observe it before paging again.
          this.deps.indexer.invalidate(source);
          throw new FleetError('conflict', 'the identity source changed; reload this history', { retryable: true });
        }
        if (error.code === 'source_changed') throw new FleetError('conflict', 'the identity changed during the read; retry', { retryable: true });
        throw new FleetError('capability_unavailable', error.message);
      }
      throw error;
    }
    // The perspective may have ended, left or been replaced while the read was in flight.
    const current = this.deps.store.hasPerspective(contact, source);
    if (!current) throw new FleetError('resource_not_found', 'this perspective is no longer available');
    if (current.ended) throw new FleetError('capability_unavailable', 'this perspective has ended; its history is no longer available');
    if (current.name !== perspective.name || current.generation !== perspective.generation)
      throw new FleetError('conflict', 'this perspective changed during the read; retry', { retryable: true });
    return { ...result, perspective: { sourceCid: source, kind: current.kind, ...(current.roleId ? { roleId: current.roleId } : {}) } };
  }
}
