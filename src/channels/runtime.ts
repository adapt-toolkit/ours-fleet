import { join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { attachOursClient } from '@ours.network/sdk/client';
import { readClientProfile } from '../client-profile.js';
import { loadConfig, splitRootFor } from '../config.js';
import { agentsRoot, stateRoot, tmpRoot } from '../paths.js';
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
  // Re-derive sources when one of their inputs commits, so new or stopped agents change
  // perspectives without polling. Bursts coalesce. The configuration scope also tracks the
  // manifest file itself; every wake is filtered to the actual inputs (never this index).
  const lifetime = new AbortController();
  const inputs = channelSourceInputs(options.configPath);
  let pending: ReturnType<typeof setTimeout> | undefined, relevant = false;
  observeFleetResources({
    configPath: options.configPath, retryWatchFailures: true,
    paths: [inputs.journals, inputs.rooms, inputs.splitRoot, inputs.permanentRoles, inputs.temporaryRoles],
    onInvalidated: path => { if (path === undefined || inputs.affects(path)) relevant = true; },
  }, () => {
    if (!relevant || pending || lifetime.signal.aborted) return;
    relevant = false;
    pending = setTimeout(() => { pending = undefined; sync(); }, 1_000);
    pending.unref?.();
  }, lifetime.signal);
  return {
    service,
    close() { lifetime.abort(); if (pending) clearTimeout(pending); indexer.stop(); void eventsClient?.close().catch(() => {}); store.close(); },
  };
}

/**
 * The files Channels source discovery reads: the manifest (Owner CID, roles), split role
 * definitions, permanent and temporary role definitions, agent journals and room records.
 * Conversation ledgers and other state under the role roots are not inputs.
 */
export function channelSourceInputs(configPath: string) {
  const config = resolve(configPath);
  const journals = resolve(privateRuntimeRoot()), rooms = resolve(stateRoot(), 'rooms'), splitRoot = resolve(splitRootFor(config));
  const permanentRoles = resolve(agentsRoot()), temporaryRoles = resolve(tmpRoot());
  const under = (path: string, root: string) => { const local = relative(root, path); return local !== '..' && !local.startsWith('..' + sep) && !local.startsWith(sep) ? local : undefined; };
  const affects = (changed: string): boolean => {
    const path = resolve(changed);
    if (path === config || under(path, journals) !== undefined || under(path, rooms) !== undefined || under(path, splitRoot) !== undefined) return true;
    for (const root of [permanentRoles, temporaryRoles]) {
      const local = under(path, root);
      if (local === undefined) continue;
      const parts = local.split(sep).filter(Boolean);
      // The roles directory, a role directory appearing/disappearing, or its definition.
      return parts.length <= 1 || (parts.length === 2 && parts[1] === 'role.yaml');
    }
    // Ancestor replacement of any input root.
    return [config, journals, rooms, splitRoot, permanentRoles, temporaryRoles].some(root => under(root, path) !== undefined);
  };
  return { journals, rooms, splitRoot, permanentRoles, temporaryRoles, affects };
}
