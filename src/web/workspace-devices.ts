import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from '../paths.js';
import { FleetError } from '../application/errors.js';
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Only failure of the enrolled device check may invalidate the App's saved credential. */
export class WorkspaceDeviceAuthError extends FleetError {
  constructor(message = 'workspace device is missing, expired, or revoked') { super('unauthorized', message); }
}
export interface WorkspaceDevice { id: string; label: string; createdAt: number; lastUsedAt: number; expiresAt: number; revokedAt: number | null }
export class WorkspaceDeviceStore {
  private readonly db: SQLiteDatabase;
  readonly workspaceId: string;
  constructor(dir = join(stateRoot(), 'web'), private readonly now: () => number = Date.now) {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    mkdirSync(dir,{recursive:true,mode:0o700}); chmodSync(dir,0o700);
    const path=join(dir,'workspace-devices.db'); this.db=new DatabaseSync(path); chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,hash TEXT NOT NULL,label TEXT NOT NULL,createdAt INTEGER NOT NULL,lastUsedAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,revokedAt INTEGER);
      CREATE TABLE IF NOT EXISTS enrollments(hash TEXT PRIMARY KEY,expiresAt INTEGER NOT NULL,issuer TEXT);`);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('workspaceId',opaque());
    this.workspaceId=String(this.db.prepare('SELECT value FROM metadata WHERE key=?').get('workspaceId')!.value);
  }
  mint(issuer: string | null = null): { enrollment: string; workspaceId: string; expiresAt: number } {
    const now=this.now(), enrollment=opaque(), expiresAt=now+5*60000;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM enrollments WHERE expiresAt<=?').run(now);
      const count=Number(this.db.prepare('SELECT count(*) AS n FROM enrollments').get()!.n);
      if(count>=32) throw new FleetError('rate_limited','too many pending device links');
      this.db.prepare('INSERT INTO enrollments VALUES(?,?,?)').run(hash(enrollment),expiresAt,issuer);
      this.db.exec('COMMIT'); return {enrollment,workspaceId:this.workspaceId,expiresAt};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  enroll(enrollment: string, workspaceId: string, label: string): { token: string; device: WorkspaceDevice; workspaceId: string } {
    if(workspaceId!==this.workspaceId || typeof enrollment!=='string' || !/^[\w-]{43}$/.test(enrollment)) throw new FleetError('unauthorized','invalid device enrollment');
    if(typeof label!=='string' || !label.trim() || label.length>100 || /[\x00-\x1f\x7f]/.test(label)) throw new FleetError('invalid_request','device name must contain 1–100 printable characters');
    const now=this.now(),id=opaque(),token=`${id}.${opaque()}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const code=this.db.prepare('DELETE FROM enrollments WHERE hash=? AND expiresAt>? RETURNING issuer').get(hash(enrollment),now);
      if(!code) throw new FleetError('unauthorized','device enrollment is expired or already used');
      if(code.issuer && !this.db.prepare('SELECT id FROM devices WHERE id=? AND revokedAt IS NULL AND expiresAt>?').get(code.issuer,now)) throw new FleetError('unauthorized','issuing device has been revoked');
      const count=Number(this.db.prepare('SELECT count(*) AS n FROM devices WHERE revokedAt IS NULL AND expiresAt>?').get(now)!.n);
      if(count>=128) throw new FleetError('rate_limited','authorized device limit reached');
      const device={id,label:label.trim(),createdAt:now,lastUsedAt:now,expiresAt:now+90*86400000,revokedAt:null};
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,NULL)').run(id,hash(token),device.label,now,now,device.expiresAt);
      this.db.exec('COMMIT'); return {token,device,workspaceId};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  authenticate(token: string): WorkspaceDevice {
    const id=typeof token==='string' ? token.split('.')[0] : '', now=this.now();
    const row=this.db.prepare('SELECT * FROM devices WHERE id=? AND revokedAt IS NULL AND expiresAt>?').get(id,now);
    const supplied=Buffer.from(hash(token || '')),expected=Buffer.from(String(row?.hash || '0'.repeat(64)));
    if(!row || !timingSafeEqual(supplied,expected)) throw new WorkspaceDeviceAuthError();
    this.db.prepare('UPDATE devices SET lastUsedAt=? WHERE id=?').run(now,id);
    return {id,label:String(row.label),createdAt:Number(row.createdAt),lastUsedAt:now,expiresAt:Number(row.expiresAt),revokedAt:null};
  }
  valid(id: string): boolean {return Boolean(this.db.prepare('SELECT id FROM devices WHERE id=? AND revokedAt IS NULL AND expiresAt>?').get(id,this.now()));}
  list(): WorkspaceDevice[] {return this.db.prepare('SELECT id,label,createdAt,lastUsedAt,expiresAt,revokedAt FROM devices ORDER BY createdAt DESC LIMIT 256').all().map(row=>({id:String(row.id),label:String(row.label),createdAt:Number(row.createdAt),lastUsedAt:Number(row.lastUsedAt),expiresAt:Number(row.expiresAt),revokedAt:row.revokedAt===null ? null : Number(row.revokedAt)}));}
  revoke(id: string): void {this.db.prepare('UPDATE devices SET revokedAt=? WHERE id=? AND revokedAt IS NULL').run(this.now(),id);this.db.prepare('DELETE FROM enrollments WHERE issuer=?').run(id);}
  /** Retire account links without changing the installation's stable host ID or other data. */
  revokeAll(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('UPDATE devices SET revokedAt=? WHERE revokedAt IS NULL').run(this.now()); this.db.exec('DELETE FROM enrollments'); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void {this.db.close();}
}
