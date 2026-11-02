import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { attachOursClient } from '@ours.network/sdk/client';
import { readClientProfile } from '../client-profile.js';
import { loadConfig, splitRootFor } from '../config.js';
import { stateRoot } from '../paths.js';
import { observeFleetResources, publishFleetResourceCommit } from '../application/resource-observer.js';
import type { RoleRepository } from '../application/role-repository.js';
import { listRoomRecords } from '../rooms-tasks/room-state.js';
import { privateRuntimeRoot } from '../agent-ours/service.js';
import { createIdentityReader } from './identity-reads.js';
import { ChannelsIndexer, type ResourceEventSource } from './indexer.js';
import { ChannelsService } from './service.js';
import { readAgentRecords, resolveSources, type ChannelSources, type DaemonIdentityRow } from './sources.js';
import { ChannelsStore } from './store.js';

export const channelsPrivateDir = () => join(stateRoot(), 'private-channels');

/**
 * Build the Fleet-side Channels service over the workspace's ordinary daemon
 * client profile: identity discovery, passive resource events and lease-free
 * identity reads. No identity is ever bound. Returns undefined when this host
 * has no daemon profile.
 */
export function createChannels(options: { configPath: string; repository: RoleRepository; log?: (message: string) => void }): { service: ChannelsService; close(): void } | undefined {
  let profile: ReturnType<typeof readClientProfile>;
  try { profile = readClientProfile(); } catch { return undefined; }
  const log = options.log ?? (message => console.warn(message));
  const store = new ChannelsStore(channelsPrivateDir());
  const reader = createIdentityReader({ endpoint: profile.endpoint, credentialPath: profile.credentialPath });
  const attach = () => attachOursClient({
    endpoint: profile.endpoint, expectedInstanceId: profile.expectedInstanceId, credentialPath: profile.credentialPath,
    sessionMode: 'external', leaseToken: `ours-fleet-channels-${process.pid}-${randomUUID()}`, env: {},
  });
  let eventsClient: Awaited<ReturnType<typeof attach>> | undefined;
  const events: ResourceEventSource = {
    async *resourceEvents(identity, opts) {
      eventsClient ??= await attach();
      yield* eventsClient.resourceEvents(identity, opts);
    },
  };

  let last: ChannelSources | undefined;
  const discover = async (): Promise<ChannelSources> => {
    const ownerCid = loadConfig(options.configPath).rooms?.owner.expected_cid;
    const roleByIdentity = new Map<string, string>();
    for (const role of await options.repository.list(true)) if (role.config?.identity) roleByIdentity.set(role.config.identity, role.id);
    const client = await attach();
    let identities: DaemonIdentityRow[];
    try { identities = (await client.listIdentities()) as DaemonIdentityRow[]; }
    finally { await client.close().catch(() => {}); }
    const found = resolveSources({
      ownerCid: ownerCid ?? '',
      identities,
      agents: readAgentRecords(privateRuntimeRoot()),
      roleByIdentity,
      roomCids: listRoomRecords().map(room => room.room_identity_cid).filter((cid): cid is string => typeof cid === 'string'),
    });
    if (!ownerCid) found.internal.delete('');
    last = found;
    return found;
  };

  const indexer = new ChannelsIndexer({ store, reader, events, discover, log, onChange: () => publishFleetResourceCommit(store.path) });
  const sync = () => { void indexer.sync().catch(error => log(`channels: sync failed: ${(error as Error).message}`)); };
  const service = new ChannelsService({ store, reader, indexer, ownerRoot: () => last?.rootCid, ready: () => last !== undefined });
  sync();
  // Re-derive sources when an agent journal, room record or role definition commits, so
  // new or stopped agents change perspectives without polling. Bursts coalesce. Explicit
  // paths only: the default scope covers the whole state root, including this index.
  const lifetime = new AbortController();
  let pending: ReturnType<typeof setTimeout> | undefined;
  observeFleetResources({ retryWatchFailures: true, paths: [privateRuntimeRoot(), join(stateRoot(), 'rooms'), splitRootFor(options.configPath)] }, () => {
    if (pending || lifetime.signal.aborted) return;
    pending = setTimeout(() => { pending = undefined; sync(); }, 1_000);
    pending.unref?.();
  }, lifetime.signal);
  return {
    service,
    close() { lifetime.abort(); if (pending) clearTimeout(pending); indexer.stop(); void eventsClient?.close().catch(() => {}); store.close(); },
  };
}
