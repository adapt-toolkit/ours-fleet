import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { stringify } from 'yaml';
import { stateRoot } from '../paths.js';
import { withFileLock } from '../atomic-file.js';
import { readClientProfile } from '../client-profile.js';
import { FleetError } from '../application/errors.js';
import { assertLayoutFile, validLayoutKey } from './layout-config.js';
import { canonicalJson } from '../canonical-json.js';
import { LAYOUT_BINDING_ACTIONS, layoutBindingOrigin, type LayoutBindingRequest } from './layout-binding-client.js';
import type { LayoutInstance, LayoutSupervisor } from './layout.js';
import { createCoworkAdapter, type CoworkAdapter } from './cowork-adapter.js';

type Grant = { version: 1; digest: string; instance: LayoutInstance; daemonInstanceId: string };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
function privatePath(path: string, directory = false): void {
  assertLayoutFile(path, directory);
  if (lstatSync(path).mode & 0o077) throw new FleetError('forbidden', 'layout grants require owner-only permissions');
}
const allowedId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);

/** Private authorization records in the existing Fleet state; no foreign lifecycle port. */
export class LayoutBindingGrants {
  constructor(private supervisor: LayoutSupervisor, private options: {
    root?: string; daemonInstanceId?: () => string; cowork?: () => CoworkAdapter;
  } = {}) {}
  private get root(): string { return this.options.root ?? join(stateRoot(), 'layout-bindings'); }
  private daemonInstanceId(): string { return this.options.daemonInstanceId?.() ?? readClientProfile().expectedInstanceId; }
  private path(id: string): string {
    if (!allowedId(id)) throw new FleetError('invalid_request', 'invalid layout binding grant');
    return join(this.root, `${id}.json`);
  }
  async share(instance: LayoutInstance, origin: string, output: string, participant: string): Promise<{ grant_id: string; file: string }> {
    layoutBindingOrigin(origin);
    if (!validLayoutKey(participant) || instance.remote || instance.supervisor !== this.supervisor.id)
      throw new FleetError('invalid_request', 'only an exact local standalone instance can be shared');
    await this.supervisor.verify(instance);
    const daemonInstanceId = this.daemonInstanceId();
    const token = randomBytes(32).toString('base64url'), id = randomUUID();
    const credential = `${output}.token`;
    // Create-only publication: never replace another binding or credential.
    if (existsSync(output) || existsSync(credential)) throw new FleetError('conflict', 'binding output already exists');
    mkdirSync(this.root, { recursive: true, mode: 0o700 }); privatePath(this.root, true);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); assertLayoutFile(dirname(output), true);
    const grant: Grant = { version: 1, digest: digest(token), instance, daemonInstanceId };
    writeFileSync(this.path(id), JSON.stringify(grant), { mode: 0o600, flag: 'wx' });
    let tokenWritten = false;
    try {
      writeFileSync(credential, `${token}\n`, { mode: 0o600, flag: 'wx' }); tokenWritten = true;
      writeFileSync(output, stringify({ [participant]: { ...instance, remote: {
        url: layoutBindingOrigin(origin), grant_id: id, credential_file: basename(credential), daemon_instance_id: daemonInstanceId,
      } } }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      rmSync(this.path(id), { force: true }); if (tokenWritten) rmSync(credential, { force: true }); throw error;
    }
    return { grant_id: id, file: output };
  }
  async revoke(id: string): Promise<void> {
    const path = this.path(id);
    if (!existsSync(this.root)) return;
    privatePath(this.root, true);
    await withFileLock(path + '.lock', () => { rmSync(path, { force: true }); });
  }
  async control(id: string, authorization: string | undefined, raw: unknown): Promise<unknown> {
    const path = this.path(id);
    if (!existsSync(path)) throw new FleetError('unauthorized', 'layout binding is unavailable');
    privatePath(this.root, true);
    return withFileLock(path + '.lock', async () => {
      if (!existsSync(path)) throw new FleetError('unauthorized', 'layout binding is unavailable');
      privatePath(path);
      const grant = JSON.parse(readFileSync(path, 'utf8')) as Grant;
      const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!token || grant.version !== 1 || typeof grant.digest !== 'string' || !/^[a-f0-9]{64}$/.test(grant.digest)
          || !timingSafeEqual(Buffer.from(digest(token)), Buffer.from(grant.digest)))
        throw new FleetError('unauthorized', 'layout binding is unavailable');
      const request = raw as LayoutBindingRequest & { instance?: LayoutInstance; daemonInstanceId?: string };
      if (!request || !LAYOUT_BINDING_ACTIONS.includes(request.action as typeof LAYOUT_BINDING_ACTIONS[number])
          || Object.keys(request).some(k => !['action', 'instance', 'roomId', 'roomRole', 'roomCid', 'assignment', 'daemonInstanceId'].includes(k)))
        throw new FleetError('invalid_request', 'unsupported layout binding operation');
      if (request.daemonInstanceId !== grant.daemonInstanceId || grant.daemonInstanceId !== this.daemonInstanceId()
          || canonicalJson(request.instance) !== canonicalJson(grant.instance))
        throw new FleetError('forbidden', 'layout binding does not match the granted instance');
      try {
        await this.supervisor.verify(grant.instance);
        let result: unknown;
        if (request.action === 'join') {
          if (!request.roomId || !request.roomCid || !request.roomRole) throw Error('room ID, CID and role required');
          const cowork = this.options.cowork?.() ?? createCoworkAdapter();
          const room = await cowork.getRoom(request.roomId);
          if (!room || !['provisioning', 'active'].includes(room.state) || room.identity_cid !== request.roomCid)
            throw Error('known mutable Cowork room required');
          // Never redeem a caller-supplied contact invitation. Cowork owns this receipt.
          const invitation = await cowork.issueInvite(request.roomId, { mode: 'one_time', role: request.roomRole, min_accepts: 1 });
          await this.supervisor.join(grant.instance, invitation.invite, request.roomCid);
        } else if (request.action === 'assign') {
          const a = request.assignment;
          if (!a?.room_id || !a.room_cid || !a.room_role) throw Error('assignment required');
          const room = await (this.options.cowork?.() ?? createCoworkAdapter()).getRoom(a.room_id);
          if (room?.state !== 'active' || room.identity_cid !== a.room_cid
              || !room.seats.some(s => s.identity_cid === grant.instance.cid && s.role === a.room_role && s.seat_state === 'active'))
            throw Error('active granted membership required');
          result = await this.supervisor.assign(grant.instance, a);
        }
        await this.supervisor.verify(grant.instance);
        return { instance: grant.instance, result };
      } catch { throw new FleetError('rejected', 'layout binding operation rejected or unconfirmed; inspect before retry'); }
    });
  }
}
