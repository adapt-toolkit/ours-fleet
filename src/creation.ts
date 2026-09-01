import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  attachOursClient, type AttachOursClientOptions, type OursClient,
} from '@ours.network/sdk/client';
import { replaceFileAtomically, withFileLock, type LockDeps } from './atomic-file.js';
import { stateRoot } from './paths.js';
import { buildInfo, UNKNOWN_BUILD } from './provenance.js';
import type { ResolvedRole } from './config.js';

/**
 * One creation transaction: role name and ours identity reserved together,
 * every artifact journalled, and everything undone in reverse on failure.
 *
 * The problem this replaces is a check followed by a create. `assertNameFree()`
 * read the config and the agent dirs, returned, and only then did the caller
 * start writing — so two concurrent spawns of the same name both passed the
 * check, both wrote, and the second silently overwrote the first's fleet.d file
 * while inheriting its half-built state. Nothing was atomic and nothing was
 * undone.
 */

/** Where host-wide creation state lives. One directory, so it is easy to inspect. */
const creationRoot = () => join(stateRoot(), 'creation');
const creationLock = () => join(creationRoot(), '.lock');
const reservationsDir = () => join(creationRoot(), 'reservations');

/** A reservation is one file; its existence IS the claim. */
const reservationPath = (kind: ReservationKind, name: string) =>
  join(reservationsDir(), `${kind}-${encodeURIComponent(name)}`);

export type ReservationKind = 'role' | 'identity';

export interface Reservation {
  kind: ReservationKind;
  name: string;
}

export class CreationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreationConflictError';
  }
}

/**
 * Artifacts a transaction created, newest last. Rollback walks this in reverse,
 * and may only delete what THIS transaction made — an object that already
 * existed is never touched.
 */
export interface JournalEntry {
  stage: string;
  undo(): void | Promise<void>;
}

export interface CreationDeps {
  lock?: LockDeps;
  log?(line: string): void;
  /** Reserve the ours identity name. Injectable so tests need no daemon. */
  identityRegistry?: IdentityRegistry;
  /** Verify/create the ours identity. Injectable so tests need no daemon. */
  identityProvisioner?: IdentityProvisioner;
  /** Descriptive progress around the existing transaction; never a second workflow. */
  onStage?(stage: CreationCoreStage, evidence?: Record<string, string | boolean>): void;
}

export type CreationCoreStage =
  | 'reserving' | 'checking_identity' | 'writing_role'
  | 'registering_supervisor' | 'starting_temp';

/**
 * The contract the ours daemon must satisfy for identity names to be reserved
 * atomically across ALL of its clients, not just across fleet processes.
 *
 * `check-then-create` is not atomic across processes, which is the whole point:
 * two spawns can both observe a free identity name and both create it. The
 * daemon is the only component that sees every client, so only the daemon can
 * make the reservation authoritative.
 */
export interface IdentityRegistry {
  /** Claim `name`. Returns false if it is already taken or reserved. */
  reserve(name: string): Promise<boolean>;
  /** Give the claim back (rollback). Must be safe to call on an unheld name. */
  release(name: string): Promise<void>;
}

/**
 * Host-local identity reservation: atomic across every ours-fleet process on
 * this host, because it is taken under the same host-wide creation lock as the
 * role name.
 *
 * It is NOT atomic against other clients of the same ours daemon — another tool
 * creating the identity between our reservation and our creation would still
 * win. Closing that needs a reserve/commit/release operation in the daemon
 * itself; see the release notes.
 */
export const hostLocalIdentityRegistry: IdentityRegistry = {
  async reserve(name: string) {
    const p = reservationPath('identity', name);
    if (existsSync(p)) return false;
    mkdirSync(reservationsDir(), { recursive: true });
    writeFileSync(p, `${process.pid} ${new Date().toISOString()}\n`);
    return true;
  },
  async release(name: string) {
    rmSync(reservationPath('identity', name), { force: true });
  },
};

/** Is this role name already reserved by an in-flight transaction? */
const roleReserved = (name: string) => existsSync(reservationPath('role', name));

export interface CreationTransaction {
  /** Record an artifact this transaction created, with how to undo it. */
  record(entry: JournalEntry): void;
  /** Stages recorded so far, in order. */
  readonly stages: string[];
}

/**
 * Run `body` inside a creation transaction.
 *
 * Under one host-wide lock: both names are reserved, then `body` builds the
 * role. If anything throws, every recorded stage is undone in reverse order and
 * both reservations are released, so the names can be reused immediately. On
 * success the reservations are released too — the role's own config and state
 * are the durable record from then on.
 *
 * Rollback errors are collected and reported, never allowed to hide the failure
 * that caused the rollback.
 */
export async function withCreationTransaction<T>(
  names: { role: string; identity: string },
  body: (tx: CreationTransaction) => Promise<T>,
  deps: CreationDeps = {},
): Promise<T> {
  const log = deps.log ?? (() => {});
  const registry = deps.identityRegistry ?? hostLocalIdentityRegistry;
  mkdirSync(creationRoot(), { recursive: true });

  const journal: JournalEntry[] = [];
  const tx: CreationTransaction = {
    record: entry => { journal.push(entry); },
    get stages() { return journal.map(e => e.stage); },
  };

  // Both names, one boundary. Reserving the role and then the identity without
  // a shared lock would let two spawns each win one.
  const held = await withFileLock(creationLock(), async () => {
    if (roleReserved(names.role))
      throw new CreationConflictError(
        `role '${names.role}' is being created by another process right now`);
    if (!await registry.reserve(names.identity))
      throw new CreationConflictError(
        `ours identity '${names.identity}' is already taken or being created right now`);
    mkdirSync(reservationsDir(), { recursive: true });
    writeFileSync(reservationPath('role', names.role), `${process.pid} ${new Date().toISOString()}\n`);
    return true;
  }, deps.lock);

  if (!held) throw new CreationConflictError('could not take the creation lock');

  const releaseAll = async () => {
    rmSync(reservationPath('role', names.role), { force: true });
    await registry.release(names.identity).catch(() => undefined);
  };

  try {
    const result = await body(tx);
    await releaseAll();
    return result;
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const entry of [...journal].reverse()) {
      try { await entry.undo(); }
      catch (e) { rollbackFailures.push(`${entry.stage}: ${(e as Error).message}`); }
    }
    await releaseAll();
    const original = error instanceof Error ? error : new Error(String(error));
    if (rollbackFailures.length) {
      log(`creation rollback incomplete: ${rollbackFailures.join('; ')}`);
      original.message += ` (rollback also failed: ${rollbackFailures.join('; ')})`;
    }
    throw original;
  }
}

/** Forget reservations left behind by a process that died mid-transaction. */
export function clearStaleReservations(olderThanMs = 60_000, now = Date.now()): number {
  const dir = reservationsDir();
  if (!existsSync(dir)) return 0;
  let cleared = 0;
  for (const f of readdirSyncSafe(dir)) {
    const p = join(dir, f);
    try {
      const stamp = Date.parse(readFileSync(p, 'utf8').trim().split(/\s+/)[1] ?? '');
      if (Number.isFinite(stamp) && now - stamp > olderThanMs) { rmSync(p, { force: true }); cleared++; }
    } catch { /* unreadable: leave it for a human */ }
  }
  return cleared;
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); }
  catch { return []; }
}

/**
 * Identity provisioning. The fleet must know — before the harness starts
 * — whether the role's identity exists, and create it when it does not.
 *
 * `exists()` is answered through the typed SDK daemon inventory. `create()` is
 * intentionally still a seam: fleet preserves application-owned identity
 * creation/binding, especially the session-owned lifetime of temporary roles.
 * Its absence is reported rather than papered over.
 */
export interface IdentityProvisioner {
  /** Does this identity exist? `unknown` when the daemon could not be asked. */
  exists(name: string): Promise<boolean | 'unknown'>;
  /** Create it, publishing bio/persona through the same path. Absent = cannot. */
  create?(name: string, profile: IdentityProvisionProfile): Promise<void>;
  /**
   * Undo a `create` during rollback. Only ever called for an identity THIS
   * transaction created; absent means "cannot", and the orphan is reported.
   */
  remove?(name: string): Promise<void>;
}

export interface IdentityProvisionProfile {
  bio?: string;
  persona?: string;
  /** Permanent role identities are locally discoverable; control identities opt out. */
  exposeLocal?: boolean;
  /** Permanent role identities accept sibling introductions; control identities opt out. */
  localAutoAccept?: boolean;
}

export type IdentityGuarantee =
  | { state: 'verified'; evidence: 'verified'; detail: string }
  | { state: 'created'; evidence: 'missing'; detail: string }
  | { state: 'unverified'; evidence: 'missing' | 'unknown'; detail: string };

const requireGuaranteedIdentity = (
  role: ResolvedRole, identity: string, result: IdentityGuarantee,
): Exclude<IdentityGuarantee, { state: 'unverified' }> => {
  if (result.state !== 'unverified') return result;
  throw new Error(
    `role '${role.name}': could not establish permanent ours identity '${identity}' before launch: ${result.detail}`);
};

/** Reconcile every permanent identity a role's supervisor owns before launch. */
export async function reconcilePermanentRoleIdentities(
  role: ResolvedRole,
  provisioner: IdentityProvisioner = daemonIdentityProvisioner(),
  log: (line: string) => void = () => {},
  knownRoleGuarantee?: IdentityGuarantee['state'],
): Promise<'verified' | 'created'> {
  const roleResult = knownRoleGuarantee
    ? {
        state: knownRoleGuarantee,
        evidence: knownRoleGuarantee === 'verified' ? 'verified' : 'missing',
        detail: `identity was ${knownRoleGuarantee} by the creation transaction`,
      } as IdentityGuarantee
    : await ensureIdentity(role.identity, {
        bio: role.bio,
        persona: role.persona,
        exposeLocal: true,
        localAutoAccept: true,
      }, provisioner, log);
  const roleGuarantee = requireGuaranteedIdentity(role, role.identity, roleResult);

  if (role.owner_channel) {
    const channelIdentity = role.owner_channel.identity;
    const channel = await ensureIdentity(channelIdentity, {
      bio: `Authenticated owner channel for the ours-fleet ${role.name} role.`,
      exposeLocal: false,
      localAutoAccept: false,
    }, provisioner, log);
    requireGuaranteedIdentity(role, channelIdentity, channel);
  }
  return roleGuarantee.state;
}

/**
 * Establish the identity before the role's service is enabled.
 *
 * Returns what was actually GUARANTEED, so the generated briefing can say
 * something true instead of asserting a "predefined" identity nobody checked —
 * the failure a real agent hit on its first boot, having been told to bind an
 * identity that did not exist.
 */
export async function ensureIdentity(
  name: string,
  profile: IdentityProvisionProfile,
  provisioner: IdentityProvisioner | undefined,
  log: (line: string) => void = () => {},
): Promise<IdentityGuarantee> {
  if (!provisioner)
    return {
      state: 'unverified', evidence: 'unknown',
      detail: 'no identity provisioner is configured',
    };

  let present: boolean | 'unknown';
  try { present = await provisioner.exists(name); }
  catch (e) {
    present = 'unknown';
    log(`identity '${name}': could not be verified (${(e as Error).message})`);
  }

  if (present === true)
    return {
      state: 'verified', evidence: 'verified',
      detail: 'the ours daemon reports it exists',
    };
  if (present === 'unknown')
    return {
      state: 'unverified', evidence: 'unknown',
      detail: 'the ours daemon could not be asked',
    };

  if (!provisioner.create) {
    // Loud, and named. Permanent lifecycle callers fail closed here; temporary
    // callers preserve connector-owned first-boot creation semantics.
    log(`identity '${name}' does not exist and this provisioner cannot create one automatically`);
    return {
      state: 'unverified', evidence: 'missing',
      detail: 'it does not exist and cannot be created here',
    };
  }
  await provisioner.create(name, profile);
  return {
    state: 'created', evidence: 'missing',
    detail: 'created during spawn, with its bio and persona published',
  };
}

/**
 * Ask the running ours daemon whether an identity exists through SDK 2's
 * coherence-checking attach path. Answers `unknown` rather than guessing when
 * the daemon cannot be reached — an unreachable daemon is not evidence that
 * the identity is missing.
 *
 * Permanent identities can be created before a harness starts. Creation binds
 * the provisioning lease, so it is always released before the role or channel
 * takes ownership. Temporary callers disable creation: a temporary identity is
 * owned and deleted by the exact connector lease that created it, and there is
 * no safe lease-transfer operation in the current SDK.
 */
type IdentityInventoryClient = Pick<OursClient, 'identities'>
  & Partial<Pick<OursClient,
    'listIdentities' | 'createIdentity' | 'setPersona' | 'releaseLease'>>;

export interface DaemonIdentityProvisionerOptions {
  /** False for temporary roles/watchdogs whose connector must own creation. */
  createPermanent?: boolean;
  /** True only for inventory checks performed by a temporary lifecycle. */
  acceptTemporaryExisting?: boolean;
}

export function daemonIdentityProvisioner(
  env: NodeJS.ProcessEnv = process.env,
  attachClient: (
    options: AttachOursClientOptions,
  ) => Promise<IdentityInventoryClient> = attachOursClient,
  options: DaemonIdentityProvisionerOptions = {},
): IdentityProvisioner {
  const provisioner: IdentityProvisioner = {
    async exists(name: string) {
      try {
        const client = await attachClient({
          env, leaseToken: `ours-fleet-identity-preflight-${process.pid}`, clientPid: process.pid,
        });
        const identities = await client.identities();
        if (!Array.isArray(identities)) return 'unknown';
        const existing = identities.find(identity => identity.name === name);
        if (!existing) return false;
        // A session-owned temporary identity cannot satisfy a permanent role
        // invariant. Report it as absent so create() can reject the collision
        // explicitly after inspecting the authoritative identity tree.
        if (existing.temporary && options.acceptTemporaryExisting !== true) return false;
        return true;
      } catch {
        return 'unknown';
      }
    },
  };
  if (options.createPermanent === false) return provisioner;

  provisioner.create = async (name, profile) => {
    const client = await attachClient({
      env, leaseToken: `ours-fleet-identity-create-${process.pid}-${randomUUID()}`,
      clientPid: process.pid,
    });
    if (!client.listIdentities || !client.createIdentity || !client.releaseLease)
      throw new Error('the selected ours SDK client cannot create permanent identities');

    try {
      const before = await client.listIdentities();
      const existing = before.find(identity => identity.name === name);
      if (existing) {
        if (existing.temp)
          throw new Error(`identity '${name}' exists but is temporary; refusing to convert or adopt it`);
        return; // another reconciler won the create race
      }
      if (!before.some(identity => identity.kind === 'root'))
        throw new Error(
          `cannot create role identity '${name}': this host has no Human identity; run ours onboarding first`);

      let createdHere = false;
      try {
        await client.createIdentity({
          name,
          bio: profile.bio ?? '',
          exposeLocal: profile.exposeLocal ?? true,
          localAutoAccept: profile.localAutoAccept ?? true,
        });
        createdHere = true;
      } catch (error) {
        // Creation is daemon-atomic. If a concurrent reconciler won by name,
        // accept only the compatible permanent identity now visible.
        const after = await client.listIdentities();
        const raced = after.find(identity => identity.name === name);
        if (!raced || raced.temp) throw error;
      }
      if (createdHere && profile.persona && client.setPersona)
        await client.setPersona({ persona: profile.persona });
    } finally {
      // createIdentity binds this lease. The managed role/channel is the next
      // owner, so never leave the short-lived provisioning client holding it.
      await client.releaseLease();
    }
  };
  return provisioner;
}

/** Inventory-only variant for session-owned temporary identity lifecycles. */
export function daemonIdentityInventoryProvisioner(
  env: NodeJS.ProcessEnv = process.env,
  attachClient: (
    options: AttachOursClientOptions,
  ) => Promise<IdentityInventoryClient> = attachOursClient,
): IdentityProvisioner {
  return daemonIdentityProvisioner(env, attachClient, {
    createPermanent: false,
    acceptTemporaryExisting: true,
  });
}

/** Atomically write a bare Agent file, journalling it for rollback. */
export function writeRoleFile(tx: CreationTransaction, file: string, contents: string): void {
  const existed = existsSync(file);
  replaceFileAtomically(file, contents, 0o644);
  tx.record({
    stage: `Agent file ${file}`,
    // Only remove what THIS transaction created; never delete a file the
    // operator already had.
    undo: () => { if (!existed) rmSync(file, { force: true }); },
  });
}

// ─── Creation provenance ───────────────────────────────────────────────

/** Where a setting's effective value came from. */
export type ProvenanceSource = 'cli' | 'agent-template' | 'fleet-default' | 'caller-role' | 'built-in';

export interface ProvenanceEntry {
  value: unknown;
  source: ProvenanceSource;
}

export interface CreationProvenance {
  version: 1;
  /** The command that created the role, without its arguments. */
  command: string;
  fleetVersion: string;
  /**
   * Build id of the artifact that created the role. Two installs can report the
   * same fleetVersion and resolve the same fleet.yaml differently, so the semver
   * alone does not identify what actually ran. `unknown` for a pre-provenance build.
   */
  fleetBuild: string;
  createdAt: string;
  lifetime: 'permanent' | 'temporary';
  role: string;
  /** Additive correlation for non-CLI creation surfaces; never contains request data. */
  surface?: 'cli' | 'web' | 'agent';
  creationActionId?: string;
  /** Managed role which requested creation through its supervisor proxy. */
  callerRole?: string;
  /** Effective settings, each tagged with where its value came from. */
  settings: Record<string, ProvenanceEntry>;
}

export const CREATION_PROVENANCE_FILE = 'creation.json';

/**
 * Record HOW a role was created, so nobody has to remember.
 *
 * Six months on, "why does this role have `approval: allow`?" is unanswerable:
 * the resolved config shows the value but not whether an operator typed it, a
 * fleet default supplied it, or it fell through to a built-in. Those have very
 * different implications for whether it is safe to change.
 *
 * Deliberately excluded: `env`, `bio`, `persona`, and `harness_options`. The
 * first two can carry credentials, and this file exists to be read — it must
 * never become a place secrets accumulate.
 */
export function buildProvenance(o: {
  role: string;
  lifetime: 'permanent' | 'temporary';
  fleetVersion: string;
  now?: Date;
  settings: Record<string, ProvenanceEntry>;
  surface?: 'cli' | 'web' | 'agent';
  creationActionId?: string;
  callerRole?: string;
}): CreationProvenance {
  return {
    version: 1,
    command: 'ours-fleet spawn',
    fleetVersion: o.fleetVersion,
    fleetBuild: buildInfo().buildId,
    createdAt: (o.now ?? new Date()).toISOString(),
    lifetime: o.lifetime,
    role: o.role,
    surface: o.surface ?? 'cli',
    creationActionId: o.creationActionId,
    callerRole: o.callerRole,
    settings: o.settings,
  };
}

/** Write the provenance record atomically, before the role is started. */
export function writeProvenance(stateDir: string, p: CreationProvenance): void {
  replaceFileAtomically(join(stateDir, CREATION_PROVENANCE_FILE), JSON.stringify(p, null, 2) + '\n', 0o600);
}

/** Read the provenance a role was created with, if it has one. */
export function readProvenance(stateDir: string): CreationProvenance | undefined {
  try {
    return JSON.parse(readFileSync(join(stateDir, CREATION_PROVENANCE_FILE), 'utf8')) as CreationProvenance;
  } catch { return undefined; }
}

/**
 * One line when the artifact reporting on a role is not the one that created it.
 *
 * A role carries its creating build in creation.json. If a different build now
 * manages it, the role's fleet.yaml may mean something different than it did at
 * creation — and because both can report the same semver, nothing else says so.
 */
export function creationBuildNote(p: CreationProvenance): string | undefined {
  const now = buildInfo();
  const created = p.fleetBuild ?? UNKNOWN_BUILD;
  if (created === now.buildId && p.fleetVersion === now.version) return undefined;
  return `created by ours-fleet ${p.fleetVersion}+${created}, reported by ${now.version}+${now.buildId}`
    + (created === UNKNOWN_BUILD
      ? ' — the creating build predates build provenance and cannot be identified'
      : ' — different artifact, so its resolved settings may differ');
}

/** One concise line per non-built-in setting, for the post-creation summary. */
export function formatProvenance(p: CreationProvenance): string[] {
  const mark = {
    cli: 'explicit', 'fleet-default': 'fleet default', 'caller-role': 'caller role',
    'agent-template': 'Agent Template', 'built-in': 'built-in',
  } as const;
  return Object.entries(p.settings)
    .filter(([, e]) => e.value !== undefined)
    .map(([k, e]) => `    ${k.padEnd(12)} ${e.value && typeof e.value === 'object'
      ? JSON.stringify(e.value) : String(e.value)}  (${mark[e.source]})`);
}

/** Classify one setting: an explicit CLI value, a fleet default, or built-in. */
export function provenanceOf(
  cliValue: unknown, fleetDefault: unknown, builtIn?: unknown,
): ProvenanceEntry {
  if (cliValue !== undefined && cliValue !== null && cliValue !== '')
    return { value: cliValue, source: 'cli' };
  if (fleetDefault !== undefined && fleetDefault !== null)
    return { value: fleetDefault, source: 'fleet-default' };
  return { value: builtIn, source: 'built-in' };
}
