import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from '../paths.js';
import { FleetError } from '../application/errors.js';
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Only failure of the enrolled device check may invalidate the App's saved credential. */
export class WorkspaceDeviceAuthError extends FleetError {
  constructor(message = 'workspace device is missing, expired, or revoked') { super('unauthorized', message); }
}
/** A spent refresh credential came back after its replacement was in use: the link is revoked, whoever presented it. */
export class WorkspaceRefreshReuseError extends WorkspaceDeviceAuthError {
  constructor(readonly revoked: string[]) { super('workspace refresh credential was already replaced; this device link is revoked'); }
}
/**
 * Credential lifetimes of an App browser link. Rotation is not expiry: every refresh replaces the
 * refresh credential, each one lapses when unused for REFRESH_IDLE_TTL, and no rotation moves a
 * link past the FAMILY_TTL fixed when it was created.
 */
export const ACCESS_TTL = 5 * 60_000;
export const REFRESH_IDLE_TTL = 7 * 86_400_000;
export const FAMILY_TTL = 30 * 86_400_000;
/** How long after this store first runs rotating credentials the earlier fixed bearer is still accepted. */
export const LEGACY_BEARER_WINDOW = 30 * 86_400_000;
const ACCESS_PREFIX = 'owa.', REFRESH_PREFIX = 'owr.';
const refreshShaped = (value: unknown): value is string => typeof value === 'string' && value.startsWith(REFRESH_PREFIX) && value.length <= 128;
export interface WorkspaceDevice { id: string; label: string; createdAt: number; lastUsedAt: number; expiresAt: number; revokedAt: number | null }
export interface WorkspaceCredentials {
  device: WorkspaceDevice; workspaceId: string;
  accessToken: string; accessExpiresAt: number;
  refreshToken: string; refreshExpiresAt: number; familyExpiresAt: number;
}
/** An authenticated device and the moment the presented credential stops authorizing anything. */
export type AuthenticatedWorkspaceDevice = WorkspaceDevice & { authorizedUntil: number; rotating: boolean };
interface LiveDevice extends WorkspaceDevice { hash: string; familyExpiresAt: number | null }
/** This host's workspace identity as already recorded, read without creating or changing the store. */
export function recordedHostWorkspaceId(dir = join(stateRoot(), 'web')): string | undefined {
  const path = join(dir, 'workspace-devices.db');
  if (!existsSync(path)) return;
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try { const row = db.prepare("SELECT value FROM metadata WHERE key='workspaceId'").get(); return typeof row?.value === 'string' ? row.value : undefined; }
  catch { return; }
  finally { db.close(); }
}
export class WorkspaceDeviceStore {
  private readonly db: SQLiteDatabase;
  readonly workspaceId: string;
  /** After this moment a fixed bearer no longer authenticates and no new one is issued. */
  readonly legacySunsetAt: number;
  private readonly rotationKey: Buffer;
  constructor(dir = join(stateRoot(), 'web'), private readonly now: () => number = Date.now) {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    mkdirSync(dir,{recursive:true,mode:0o700}); chmodSync(dir,0o700);
    const path=join(dir,'workspace-devices.db'); this.db=new DatabaseSync(path); chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,hash TEXT NOT NULL,label TEXT NOT NULL,createdAt INTEGER NOT NULL,lastUsedAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,revokedAt INTEGER);
      CREATE TABLE IF NOT EXISTS enrollments(hash TEXT PRIMARY KEY,expiresAt INTEGER NOT NULL,issuer TEXT);`);
    // A device row is one browser link. A rotating link keeps no bearer hash: its credentials are the rows below.
    const columns=this.db.prepare('PRAGMA table_info(devices)').all().map(column=>column.name);
    if(!columns.includes('familyExpiresAt'))this.db.exec('ALTER TABLE devices ADD COLUMN familyExpiresAt INTEGER');
    if(!columns.includes('issuer'))this.db.exec('ALTER TABLE devices ADD COLUMN issuer TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS refresh_tokens(hash TEXT PRIMARY KEY,deviceId TEXT NOT NULL,issuedAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,consumedAt INTEGER,confirmedAt INTEGER,parent TEXT);
      CREATE INDEX IF NOT EXISTS refresh_tokens_device ON refresh_tokens(deviceId);
      CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_parent ON refresh_tokens(parent) WHERE parent IS NOT NULL;
      CREATE TABLE IF NOT EXISTS access_tokens(hash TEXT PRIMARY KEY,deviceId TEXT NOT NULL,expiresAt INTEGER NOT NULL,refresh TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS access_tokens_device ON access_tokens(deviceId);`);
    const metadata=(key: string, initial: string) => { this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run(key,initial); return String(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)!.value); };
    this.legacySunsetAt=Number(metadata('legacySunsetAt',String(this.now()+LEGACY_BEARER_WINDOW)));
    // Derives each refresh credential's one successor from the credential itself; it never leaves
    // this host and is useless without a current credential. It lives and dies with this
    // database: a lost or replaced file ends every link, which then needs a new link code.
    this.rotationKey=Buffer.from(metadata('rotationKey',opaque()),'base64url');
    this.workspaceId=metadata('workspaceId',opaque());
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=run(); this.db.exec('COMMIT'); return result; }
    catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  mint(issuer: string | null = null): { enrollment: string; workspaceId: string; expiresAt: number } {
    const now=this.now(), enrollment=opaque(), expiresAt=now+5*60000;
    return this.transaction(() => {
      this.db.prepare('DELETE FROM enrollments WHERE expiresAt<=?').run(now);
      const count=Number(this.db.prepare('SELECT count(*) AS n FROM enrollments').get()!.n);
      if(count>=32) throw new FleetError('rate_limited','too many pending device links');
      this.db.prepare('INSERT INTO enrollments VALUES(?,?,?)').run(hash(enrollment),expiresAt,issuer);
      return {enrollment,workspaceId:this.workspaceId,expiresAt};
    });
  }
  /** Link a browser with rotating credentials. */
  enroll(enrollment: string, workspaceId: string, label: string, rotating: true): WorkspaceCredentials;
  /** The fixed bearer of earlier App versions; refused once the legacy window has closed. */
  enroll(enrollment: string, workspaceId: string, label: string, rotating?: false): { token: string; device: WorkspaceDevice; workspaceId: string };
  enroll(enrollment: string, workspaceId: string, label: string, rotating = false): WorkspaceCredentials | { token: string; device: WorkspaceDevice; workspaceId: string } {
    if(workspaceId!==this.workspaceId || typeof enrollment!=='string' || !/^[\w-]{43}$/.test(enrollment)) throw new FleetError('unauthorized','invalid device enrollment');
    if(typeof label!=='string' || !label.trim() || label.length>100 || /[\x00-\x1f\x7f]/.test(label)) throw new FleetError('invalid_request','device name must contain 1–100 printable characters');
    const now=this.now(),id=opaque(),token=`${id}.${opaque()}`;
    if(!rotating && now>=this.legacySunsetAt) throw new FleetError('invalid_request','this workspace no longer issues fixed device credentials; update the App');
    return this.transaction(() => {
      const code=this.db.prepare('DELETE FROM enrollments WHERE hash=? AND expiresAt>? RETURNING issuer').get(hash(enrollment),now);
      if(!code) throw new FleetError('unauthorized','device enrollment is expired or already used');
      if(code.issuer && !this.live(String(code.issuer),now)) throw new FleetError('unauthorized','issuing device has been revoked');
      const count=Number(this.db.prepare('SELECT count(*) AS n FROM devices WHERE revokedAt IS NULL AND expiresAt>?').get(now)!.n);
      if(count>=128) throw new FleetError('rate_limited','authorized device limit reached');
      const issuer=code.issuer===null ? null : String(code.issuer);
      if(!rotating) {
        const device={id,label:label.trim(),createdAt:now,lastUsedAt:now,expiresAt:now+90*86400000,revokedAt:null};
        this.db.prepare('INSERT INTO devices(id,hash,label,createdAt,lastUsedAt,expiresAt,revokedAt,issuer) VALUES(?,?,?,?,?,?,NULL,?)').run(id,hash(token),device.label,now,now,device.expiresAt,issuer);
        return {token,device,workspaceId};
      }
      const familyExpiresAt=now+FAMILY_TTL,refreshToken=REFRESH_PREFIX+opaque(),refreshExpiresAt=Math.min(now+REFRESH_IDLE_TTL,familyExpiresAt);
      const device={id,label:label.trim(),createdAt:now,lastUsedAt:now,expiresAt:refreshExpiresAt,revokedAt:null};
      this.db.prepare('INSERT INTO devices(id,hash,label,createdAt,lastUsedAt,expiresAt,revokedAt,familyExpiresAt,issuer) VALUES(?,?,?,?,?,?,NULL,?,?)').run(id,'',device.label,now,now,refreshExpiresAt,familyExpiresAt,issuer);
      this.db.prepare('INSERT INTO refresh_tokens VALUES(?,?,?,?,NULL,NULL,NULL)').run(hash(refreshToken),id,now,refreshExpiresAt);
      return this.grant(device,familyExpiresAt,refreshToken,refreshExpiresAt,now);
    });
  }
  /** Inside a transaction: an access credential beside the given current refresh credential. */
  private grant(device: WorkspaceDevice, familyExpiresAt: number, refreshToken: string, refreshExpiresAt: number, now: number): WorkspaceCredentials {
    const accessToken=ACCESS_PREFIX+opaque(),accessExpiresAt=Math.min(now+ACCESS_TTL,familyExpiresAt);
    this.db.prepare('DELETE FROM access_tokens WHERE expiresAt<=?').run(now);
    this.db.prepare('DELETE FROM refresh_tokens WHERE deviceId IN (SELECT id FROM devices WHERE revokedAt IS NOT NULL OR expiresAt<=?)').run(now);
    this.db.prepare('INSERT INTO access_tokens VALUES(?,?,?,?)').run(hash(accessToken),device.id,accessExpiresAt,hash(refreshToken));
    return {device,workspaceId:this.workspaceId,accessToken,accessExpiresAt,refreshToken,refreshExpiresAt,familyExpiresAt};
  }
  private live(id: string, now: number): LiveDevice | undefined {
    const row=this.db.prepare('SELECT * FROM devices WHERE id=? AND revokedAt IS NULL AND expiresAt>?').get(id,now);
    if(!row || (row.familyExpiresAt===null && now>=this.legacySunsetAt)) return undefined;
    return {id:String(row.id),hash:String(row.hash),label:String(row.label),createdAt:Number(row.createdAt),lastUsedAt:Number(row.lastUsedAt),expiresAt:Number(row.expiresAt),revokedAt:null,familyExpiresAt:row.familyExpiresAt===null ? null : Number(row.familyExpiresAt)};
  }
  private device(row: LiveDevice, changes: Partial<WorkspaceDevice> = {}): WorkspaceDevice {
    return {id:row.id,label:row.label,createdAt:row.createdAt,lastUsedAt:row.lastUsedAt,expiresAt:row.expiresAt,revokedAt:null,...changes};
  }
  /**
   * Replace a refresh credential. It has exactly one successor, derived on this host. Until that
   * successor is seen in use (presented itself, or an access credential issued with it
   * authenticates), the spent credential is answered again with the same successor: a lost
   * answer, a closed tab or a restart converge on one value and extend nothing. Once the successor
   * is in use, the spent credential is a replay and ends the link and the links it issued.
   */
  refresh(refreshToken: string): WorkspaceCredentials {
    const outcome=this.transaction(() => this.rotate(refreshToken,false));
    if(Array.isArray(outcome)) throw new WorkspaceRefreshReuseError(outcome);
    return outcome;
  }
  /**
   * A link code for another browser, issued by this link. It is a lasting grant, so it takes the
   * link's current, unspent refresh credential and rotates it in the same step, with the successor
   * counted as in use at once: whoever else holds the spent credential is a replay on their next
   * refresh, which also ends the link made from this code. An answer lost here is not retried.
   */
  link(refreshToken: string): WorkspaceCredentials & { enrollment: string; enrollmentExpiresAt: number } {
    const now=this.now(),enrollment=opaque(),enrollmentExpiresAt=now+5*60000;
    const outcome=this.transaction(() => {
      const rotated=this.rotate(refreshToken,true);
      if(Array.isArray(rotated)) return rotated;
      this.db.prepare('DELETE FROM enrollments WHERE expiresAt<=?').run(now);
      if(Number(this.db.prepare('SELECT count(*) AS n FROM enrollments').get()!.n)>=32) throw new FleetError('rate_limited','too many pending device links');
      this.db.prepare('INSERT INTO enrollments VALUES(?,?,?)').run(hash(enrollment),enrollmentExpiresAt,rotated.device.id);
      return {...rotated,enrollment,enrollmentExpiresAt};
    });
    if(Array.isArray(outcome)) throw new WorkspaceRefreshReuseError(outcome);
    return outcome;
  }
  /** Inside a transaction. Returns new credentials, or the devices ended by a replay. `strict` allows no repeat and confirms the successor. */
  private rotate(refreshToken: string, strict: boolean): WorkspaceCredentials | string[] {
    if(!refreshShaped(refreshToken)) throw new WorkspaceDeviceAuthError();
    const now=this.now(),key=hash(refreshToken);
    const row=this.db.prepare('SELECT * FROM refresh_tokens WHERE hash=?').get(key);
    const device=row && this.live(String(row.deviceId),now);
    if(!row || !device || device.familyExpiresAt===null) throw new WorkspaceDeviceAuthError();
    const next=REFRESH_PREFIX+createHmac('sha256',this.rotationKey).update(`ours.fleet.workspace-refresh.v1\0${device.id}\0${refreshToken}`).digest('base64url');
    if(row.consumedAt===null) {
      if(Number(row.expiresAt)<=now) throw new WorkspaceDeviceAuthError();
      const expiresAt=Math.min(now+REFRESH_IDLE_TTL,device.familyExpiresAt);
      this.db.prepare('UPDATE refresh_tokens SET consumedAt=?,confirmedAt=coalesce(confirmedAt,?) WHERE hash=?').run(now,now,key);
      this.db.prepare('INSERT INTO refresh_tokens VALUES(?,?,?,?,NULL,?,?)').run(hash(next),device.id,now,expiresAt,strict ? now : null,key);
      // The link itself lapses with its newest refresh credential.
      this.db.prepare('UPDATE devices SET expiresAt=?,lastUsedAt=? WHERE id=?').run(expiresAt,now,device.id);
      return this.grant(this.device(device,{expiresAt,lastUsedAt:now}),device.familyExpiresAt,next,expiresAt,now);
    }
    const successor=this.db.prepare('SELECT * FROM refresh_tokens WHERE parent=?').get(key);
    if(strict || !successor || successor.confirmedAt!==null || successor.consumedAt!==null) return this.revokeRows(device.id,now,true);
    if(Number(successor.expiresAt)<=now) throw new WorkspaceDeviceAuthError();
    return this.grant(this.device(device),device.familyExpiresAt,next,Number(successor.expiresAt),now);
  }
  /**
   * One-time move of a fixed bearer to rotating credentials. The device keeps its identity, the
   * bearer stops working in the same transaction, and the link ends no later than it would have.
   */
  exchange(token: string): WorkspaceCredentials {
    const now=this.now();
    return this.transaction(() => {
      const legacy=this.legacy(token,now);
      const familyExpiresAt=Math.min(legacy.expiresAt,now+FAMILY_TTL),refreshToken=REFRESH_PREFIX+opaque(),refreshExpiresAt=Math.min(now+REFRESH_IDLE_TTL,familyExpiresAt);
      this.db.prepare('UPDATE devices SET hash=?,familyExpiresAt=?,expiresAt=?,lastUsedAt=? WHERE id=?').run('',familyExpiresAt,refreshExpiresAt,now,legacy.id);
      this.db.prepare('INSERT INTO refresh_tokens VALUES(?,?,?,?,NULL,NULL,NULL)').run(hash(refreshToken),legacy.id,now,refreshExpiresAt);
      return this.grant({...legacy,expiresAt:refreshExpiresAt,lastUsedAt:now},familyExpiresAt,refreshToken,refreshExpiresAt,now);
    });
  }
  private legacy(token: string, now: number): WorkspaceDevice {
    const row=this.live(typeof token==='string' ? token.split('.')[0] : '',now);
    const supplied=Buffer.from(hash(typeof token==='string' ? token : '')),expected=Buffer.from(row?.hash || '0'.repeat(64));
    if(!row || row.familyExpiresAt!==null || !timingSafeEqual(supplied,expected)) throw new WorkspaceDeviceAuthError();
    return this.device(row);
  }
  /** The device behind an access credential, or behind a fixed bearer while those are still accepted. */
  authenticate(token: string): AuthenticatedWorkspaceDevice {
    const now=this.now();
    if(typeof token==='string' && token.startsWith(ACCESS_PREFIX)) {
      const access=token.length<=128 ? this.db.prepare('SELECT * FROM access_tokens WHERE hash=? AND expiresAt>?').get(hash(token),now) : undefined;
      const device=access && this.live(String(access.deviceId),now);
      if(!access || !device || device.familyExpiresAt===null) throw new WorkspaceDeviceAuthError();
      this.db.prepare('UPDATE devices SET lastUsedAt=? WHERE id=?').run(now,device.id);
      // Use of this credential shows its refresh credential reached the browser.
      this.db.prepare('UPDATE refresh_tokens SET confirmedAt=? WHERE hash=? AND confirmedAt IS NULL').run(now,String(access.refresh));
      return {...this.device(device,{lastUsedAt:now}),authorizedUntil:Number(access.expiresAt),rotating:true};
    }
    const device=this.legacy(token,now);
    this.db.prepare('UPDATE devices SET lastUsedAt=? WHERE id=?').run(now,device.id);
    return {...device,lastUsedAt:now,authorizedUntil:Math.min(device.expiresAt,this.legacySunsetAt),rotating:false};
  }
  /** End the link a refresh credential belongs to, named by its SHA-256: a hash can end a link, never use it. */
  revokeByRefreshHash(refreshHash: string): string | undefined {
    if(typeof refreshHash!=='string' || !/^[a-f0-9]{64}$/.test(refreshHash)) return undefined;
    const row=this.db.prepare('SELECT deviceId FROM refresh_tokens WHERE hash=?').get(refreshHash);
    if(!row) return undefined;
    this.revoke(String(row.deviceId)); return String(row.deviceId);
  }
  /** Inside a transaction. With cascade, links issued from this one end too. Returns every device ended. */
  private revokeRows(id: string, now: number, cascade = false): string[] {
    const ended: string[]=[],pending=[id];
    while(pending.length) {
      const current=pending.pop()!; if(ended.includes(current)) continue; ended.push(current);
      this.db.prepare('UPDATE devices SET revokedAt=? WHERE id=? AND revokedAt IS NULL').run(now,current);
      this.db.prepare('DELETE FROM enrollments WHERE issuer=?').run(current);
      this.db.prepare('DELETE FROM access_tokens WHERE deviceId=?').run(current);
      this.db.prepare('DELETE FROM refresh_tokens WHERE deviceId=?').run(current);
      if(cascade) for(const child of this.db.prepare('SELECT id FROM devices WHERE issuer=? AND revokedAt IS NULL').all(current)) pending.push(String(child.id));
    }
    return ended;
  }
  valid(id: string): boolean {return Boolean(this.live(id,this.now()));}
  list(): WorkspaceDevice[] {return this.db.prepare('SELECT id,label,createdAt,lastUsedAt,expiresAt,revokedAt FROM devices ORDER BY createdAt DESC LIMIT 256').all().map(row=>({id:String(row.id),label:String(row.label),createdAt:Number(row.createdAt),lastUsedAt:Number(row.lastUsedAt),expiresAt:Number(row.expiresAt),revokedAt:row.revokedAt===null ? null : Number(row.revokedAt)}));}
  revoke(id: string): void {this.transaction(() => this.revokeRows(id,this.now()));}
  /** Retire account links without changing the installation's stable host ID or other data. */
  revokeAll(): void {
    this.transaction(() => { this.db.prepare('UPDATE devices SET revokedAt=? WHERE revokedAt IS NULL').run(this.now()); this.db.exec('DELETE FROM enrollments; DELETE FROM access_tokens; DELETE FROM refresh_tokens'); });
  }
  close(): void {this.db.close();}
}
