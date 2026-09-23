import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachOursClient } from '@ours.network/sdk/client';
import { ApplicationIdentityStore } from '@ours.network/mcp/application-identities';
import { readClientProfile } from '../client-profile.js';
import { stateRoot } from '../paths.js';
import { createCoworkAdapter } from '../rooms-tasks/cowork-adapter.js';
import type { ResolvedRole } from '../config.js';
import { RuntimeController } from './controller.js';
import { atomicPrivateWrite, binderKey } from './state.js';
import { AgentOursRuntime, type RoomAdmission } from './runtime.js';
import { startMcpEndpoint } from './mcp-endpoint.js';

export const privateRuntimeRoot = () => join(stateRoot(), 'private-ours');
export interface ManagedAgentService {
  runtime: AgentOursRuntime;
  descriptor: string;
  privatePaths: string[];
  close(terminal: boolean): Promise<void>;
}
function roomSecretPath(role: ResolvedRole): string {
  const startup = role.roomMemberStartup!;
  return join(privateRuntimeRoot(), 'room-inputs',
    binderKey(startup.room_identity_cid, JSON.stringify([role.name, startup.invite_id])) + '.json');
}
function matchesRoomSecret(secret: Record<string, unknown>, role: ResolvedRole): boolean {
  const startup = role.roomMemberStartup!;
  return secret.room_id === startup.room_id && secret.room_identity_cid === startup.room_identity_cid
    && secret.invite_id === startup.invite_id && secret.identity_name === role.identity
    && secret.role === startup.role;
}
/** Only trusted launch orchestration may write this descriptor, never the child. */
export function storeRoomSecret(role: ResolvedRole): void {
  const startup = role.roomMemberStartup;
  if (!startup?.invite) return;
  if (startup.identity_name !== role.identity) throw Error('ROOM_SECRET_MISMATCH');
  const root = join(privateRuntimeRoot(), 'room-inputs');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Failed attempts retain private evidence. A new invite must never overwrite
  // or consume a previous attempt's descriptor.
  const path = roomSecretPath(role);
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !matchesRoomSecret(old, role) || old.invite !== startup.invite
    )
      throw Error('ROOM_SECRET_COLLISION');
    return;
  }
  atomicPrivateWrite(path, startup);
}
export function storeTemporaryLaunch(role: ResolvedRole, action: string): void {
  const root = join(privateRuntimeRoot(), 'launches');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  atomicPrivateWrite(join(root, binderKey('temporary', role.name) + '.json'), {
    role: role.name,
    identity: role.identity,
    action,
  });
}
export async function prepareManagedAgent(
  role: ResolvedRole,
  stateDir: string,
  temporary: boolean,
): Promise<ManagedAgentService> {
  if (role.owner_channel?.identity === role.identity) throw Error('OWNER_AGENT_IDENTITY_COLLISION');
  const profile = readClientProfile({ ...process.env, ...role.env });
  if (!profile) throw Error('MANAGED_OURS_REQUIRES_EXPLICIT_DAEMON_PROFILE');
  const root = privateRuntimeRoot(),
    key = binderKey(profile.expectedInstanceId, role.identity),
    dir = join(root, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const instancePath = join(dir, 'instance.json');
  const launch = temporary
    ? JSON.parse(
        readFileSync(join(root, 'launches', binderKey('temporary', role.name) + '.json'), 'utf8'),
      )
    : undefined;
  if (
    launch &&
    (launch.role !== role.name ||
      launch.identity !== role.identity ||
      typeof launch.action !== 'string')
  )
    throw Error('INVALID_TEMP_LAUNCH');
  let instance: string;
  if (existsSync(instancePath)) {
    const old = JSON.parse(readFileSync(instancePath, 'utf8'));
    if (old.role !== role.name || old.temporary !== temporary)
      throw Error('IDENTITY_ASSIGNED_TO_OTHER_ROLE');
    instance = old.instance;
  } else {
    instance = randomUUID();
    try {
      writeFileSync(instancePath, JSON.stringify({ instance, role: role.name, temporary }), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const old = JSON.parse(readFileSync(instancePath, 'utf8'));
      if (old.role !== role.name || old.temporary !== temporary)
        throw Error('IDENTITY_ASSIGNED_TO_OTHER_ROLE');
      instance = old.instance;
    }
  }
  const controller = await RuntimeController.acquire(
    root,
    profile.expectedInstanceId,
    role.identity,
    instance,
  );
  let closeClient: (() => Promise<void>) | undefined;
  let partialEndpoint: { close(): Promise<void> } | undefined;
  try {
    let prior = controller.journal.read();
    if (prior?.phase === 'RELEASED') {
      if (temporary && launch.action === prior.action)
        throw Error('TERMINAL_TEMP_REQUIRES_NEW_LAUNCH');
      instance = controller.successor();
      atomicPrivateWrite(instancePath, { instance, role: role.name, temporary });
      if (temporary && existsSync(join(dir, 'identity-pin.json')))
        unlinkSync(join(dir, 'identity-pin.json'));
      prior = undefined;
    }
    const generation = prior ? controller.resumeGeneration() : 1;
    const tokenPath = join(dir, 'owner.json');
    let token: string;
    if (existsSync(tokenPath)) {
      const owner = JSON.parse(readFileSync(tokenPath, 'utf8'));
      if (owner.instance !== instance || typeof owner.token !== 'string')
        throw Error('OWNER_RECORD_MISMATCH');
      token = owner.token;
    } else {
      if (prior) throw Error('OWNER_RECORD_MISSING');
      token = randomBytes(32).toString('hex');
      atomicPrivateWrite(tokenPath, { instance, token });
    }
    const client = await attachOursClient({
      endpoint: profile.endpoint,
      expectedInstanceId: profile.expectedInstanceId,
      credentialPath: profile.credentialPath,
      sessionMode: 'external',
      leaseToken: token,
      requiredCapabilities: ['external-sessions-v1', 'root-first-identities-v1'],
    });
    closeClient = () => client.close();
    const pinPath = join(dir, 'identity-pin.json');
    const pin = existsSync(pinPath) ? JSON.parse(readFileSync(pinPath, 'utf8')) : undefined;
    if (
      pin &&
      (pin.daemon !== profile.expectedInstanceId ||
        pin.name !== role.identity ||
        typeof pin.cid !== 'string')
    )
      throw Error('INVALID_IDENTITY_PIN');
    const runtime = new AgentOursRuntime(
      {
        instance,
        generation,
        daemon: profile.expectedInstanceId,
        name: role.identity,
        lifetime: temporary ? 'temporary' : 'permanent',
        action: launch?.action ?? prior?.action ?? randomUUID(),
        expectedCid: pin?.cid,
        allowCreate: true,
        bio: role.bio ?? '',
      },
      {
        client,
        journal: controller.journal,
        assertFence: controller.assertFence,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    );
    let room: RoomAdmission | undefined;
    if (role.roomMemberStartup) {
      const startup = role.roomMemberStartup;
      const legacyPath = join(
        root,
        'room-inputs',
        binderKey(startup.room_identity_cid, role.name) + '.json',
      );
      const currentPath = roomSecretPath(role);
      const path = existsSync(currentPath) ? currentPath : legacyPath;
      const cowork = createCoworkAdapter();
      room = {
        id: startup.room_id,
        cid: startup.room_identity_cid,
        seat: startup.invite_id,
        action: startup.invite_id,
        redeem: async (attached) => {
          const secret = JSON.parse(readFileSync(path, 'utf8'));
          if (
            !matchesRoomSecret(secret, role)
          )
            throw Error('ROOM_SECRET_MISMATCH');
          return attached.addContact({ invite: secret.invite });
        },
        observe: async (agentCid) => {
          const [contacts, observed] = await Promise.all([
            client.listContacts(),
            cowork.getRoom(startup.room_id),
          ]);
          if (!observed || observed.identity_cid !== startup.room_identity_cid) return 'mismatch';
          const seat = observed.seats.find((s) => s.invite_id === startup.invite_id);
          if (seat && (seat.identity_cid !== agentCid || seat.role !== startup.role))
            return 'mismatch';
          return seat?.seat_state === 'active' &&
            contacts.contacts.some((c) => c.container_id === startup.room_identity_cid)
            ? 'established'
            : 'pending';
        },
        discardSecret: async () => {
          if (existsSync(path)) unlinkSync(path);
        },
      };
    }
    await runtime.prepare(room);
    if (role.roomMemberStartup) {
      const startup = role.roomMemberStartup;
      atomicPrivateWrite(
        join(root, 'room-inputs', binderKey(startup.room_identity_cid, role.name) + '.ready.json'),
        { room: startup.room_id, invite: startup.invite_id, cid: runtime.snapshot.cid, generation },
      );
    }
    if (!pin)
      atomicPrivateWrite(pinPath, {
        daemon: profile.expectedInstanceId,
        name: role.identity,
        cid: runtime.snapshot.cid,
      });
    const identities = new ApplicationIdentityStore(
      { instanceId: profile.expectedInstanceId },
      { path: join(dir, 'application.json') },
    );
    await identities.add(role.identity);
    const bridgeDir = join(stateDir, '.ours-bridge');
    mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
    const capability = randomBytes(32).toString('hex'),
      socket = join(bridgeDir, `g${generation}.sock`);
    const endpoint = await startMcpEndpoint({
      socket,
      capability,
      generation,
      runtime,
      client,
      identities,
      remoteDaemonFiles: true,
    });
    partialEndpoint = endpoint;
    const descriptor = join(bridgeDir, 'descriptor.json');
    atomicPrivateWrite(descriptor, { socket, capability, generation });
    return {
      runtime,
      descriptor,
      privatePaths: [root, profile.configPath, profile.credentialPath],
      close: async (terminal) => {
        try {
          await endpoint.close();
          if (terminal) await runtime.terminal();
          else await runtime.suspend();
        } finally {
          try {
            await client.close();
          } finally {
            controller.unlock();
          }
        }
      },
    };
  } catch (error) {
    try {
      await partialEndpoint?.close();
    } finally {
      try {
        await closeClient?.();
      } finally {
        controller.unlock();
      }
    }
    throw error;
  }
}

/** Explicit trusted inventory migration: read and pin existing permanent CID, never bind. */
export async function preparePermanentAssignment(
  role: ResolvedRole,
): Promise<'verified' | 'unverified'> {
  const profile = readClientProfile({ ...process.env, ...role.env });
  if (!profile) throw Error('MANAGED_OURS_REQUIRES_EXPLICIT_DAEMON_PROFILE');
  const client = await attachOursClient({
    endpoint: profile.endpoint,
    expectedInstanceId: profile.expectedInstanceId,
    credentialPath: profile.credentialPath,
    sessionMode: 'local',
    requiredCapabilities: ['local-pid-v1', 'root-first-identities-v1'],
  });
  try {
    const rows = await client.listIdentities(),
      row = rows.find((r) => r.name === role.identity);
    if (!row) return 'unverified';
    if (!('cid' in row) || row.kind !== 'role' || row.temp)
      throw Error('PERMANENT_ASSIGNMENT_NOT_A_ROLE');
    const dir = join(privateRuntimeRoot(), binderKey(profile.expectedInstanceId, role.identity));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'identity-pin.json');
    if (existsSync(path)) {
      const old = JSON.parse(readFileSync(path, 'utf8'));
      if (
        old.cid !== row.cid ||
        old.daemon !== profile.expectedInstanceId ||
        old.name !== role.identity
      )
        throw Error('PERMANENT_ASSIGNMENT_PIN_MISMATCH');
    } else
      atomicPrivateWrite(path, {
        daemon: profile.expectedInstanceId,
        name: role.identity,
        cid: row.cid,
      });
    return 'verified';
  } finally {
    await client.close();
  }
}
export function readRoomReadiness(
  roomCid: string,
  name: string,
): { room: string; invite: string; cid: string; generation: number } | undefined {
  try {
    return JSON.parse(
      readFileSync(
        join(privateRuntimeRoot(), 'room-inputs', binderKey(roomCid, name) + '.ready.json'),
        'utf8',
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/** Explicit logical-instance termination, independent of harness/bridge transport. */
export async function releaseManagedAgent(role: ResolvedRole): Promise<void> {
  const profile = readClientProfile({ ...process.env, ...role.env });
  if (!profile) throw Error('MANAGED_OURS_REQUIRES_EXPLICIT_DAEMON_PROFILE');
  const root = privateRuntimeRoot(),
    dir = join(root, binderKey(profile.expectedInstanceId, role.identity));
  if (!existsSync(join(dir, 'instance.json'))) return;
  const instance = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8'));
  if (instance.role !== role.name) throw Error('IDENTITY_ASSIGNED_TO_OTHER_ROLE');
  const controller = await RuntimeController.acquire(
    root,
    profile.expectedInstanceId,
    role.identity,
    instance.instance,
  );
  try {
    const state = controller.journal.read();
    if (!state || state.phase === 'RELEASED') return;
    const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'));
    if (owner.instance !== state.instance) throw Error('OWNER_RECORD_MISMATCH');
    const client = await attachOursClient({
      endpoint: profile.endpoint,
      expectedInstanceId: profile.expectedInstanceId,
      credentialPath: profile.credentialPath,
      sessionMode: 'external',
      leaseToken: owner.token,
      requiredCapabilities: ['external-sessions-v1', 'root-first-identities-v1'],
    });
    try {
      const runtime = new AgentOursRuntime(
        {
          instance: state.instance,
          generation: state.generation,
          daemon: state.daemon,
          name: state.name,
          lifetime: state.lifetime,
          action: state.action,
          allowCreate: false,
          bio: '',
        },
        {
          client,
          journal: controller.journal,
          assertFence: controller.assertFence,
          now: Date.now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
      );
      await runtime.terminal();
    } finally {
      await client.close();
    }
  } finally {
    controller.unlock();
  }
}
