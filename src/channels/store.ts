import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PerspectiveSource } from './sources.js';

/** One local identity's view of one external contact. Metadata only, never bodies. */
export interface ChannelEdge {
  contactCid: string;
  contactName: string;
  lastActivity: string;
  rootCid?: string;
  rootName?: string;
  roleId?: string;
}
export interface ChannelPerspective {
  sourceCid: string;
  sourceName: string;
  kind: 'owner' | 'agent';
  roleId?: string;
  ended: boolean;
  stale: boolean;
  contactName: string;
  lastActivity: string;
  claimedRoot?: { rootCid: string; rootName: string; roleId: string };
}
export interface ChannelRow {
  cid: string;
  name: string;
  lastActivity: string;
  /** Present only when every perspective with a claim agrees. Signed claim, not verified. */
  claimedRoot?: { rootCid: string; rootName: string };
  conflictingRootClaims: boolean;
  perspectives: number;
  ownerConnected: boolean;
}
export interface ChannelPage { channels: ChannelRow[]; nextCursor: string | null }

/** Rows whose perspectives have all ended drop out of Recent after this long. */
export const ENDED_RETENTION_MS = 30 * 86_400_000;

export const CHANNELS_DB = 'channels.db';

/**
 * Durable Channels projection. Edges are keyed (source, contact) and replaced
 * per source in one transaction; the per-contact row is recomputed from its
 * edges, so the same external contact known to several identities is one row
 * with several perspectives, and two contacts sharing a root stay two rows.
 */
export class ChannelsStore {
  private readonly db: SQLiteDatabase;
  readonly path: string;
  constructor(dir: string, private readonly now: () => number = Date.now) {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.path = join(dir, CHANNELS_DB); this.db = new DatabaseSync(this.path); chmodSync(this.path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sources(cid TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,role_id TEXT,ended INTEGER NOT NULL DEFAULT 0,stale INTEGER NOT NULL DEFAULT 1,observed_at INTEGER);
      CREATE TABLE IF NOT EXISTS edges(source_cid TEXT NOT NULL,contact_cid TEXT NOT NULL,contact_name TEXT NOT NULL,last_activity TEXT NOT NULL,root_cid TEXT,root_name TEXT,role_id TEXT,PRIMARY KEY(source_cid,contact_cid));
      CREATE INDEX IF NOT EXISTS edges_contact ON edges(contact_cid);
      CREATE TABLE IF NOT EXISTS channels(cid TEXT PRIMARY KEY,name TEXT NOT NULL,last_activity TEXT NOT NULL,root_cid TEXT,root_name TEXT,conflicting INTEGER NOT NULL,perspectives INTEGER NOT NULL,owner_connected INTEGER NOT NULL,live_perspectives INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS channels_recent ON channels(last_activity DESC,cid);
      CREATE INDEX IF NOT EXISTS channels_root ON channels(root_cid,last_activity DESC,cid);`);
    // The daemon source lifetime each source was last observed at (pins later history reads).
    const columns = new Set((this.db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>).map(c => c.name));
    if (!columns.has('generation')) this.db.exec('ALTER TABLE sources ADD COLUMN generation TEXT');
    if (!columns.has('position')) this.db.exec('ALTER TABLE sources ADD COLUMN position INTEGER');
  }
  close(): void { this.db.close(); }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Reconcile the source set: unknown sources and their edges are removed, ended ones keep metadata. */
  setSources(sources: PerspectiveSource[]): void {
    this.transaction(() => {
      const keep = new Set(sources.map(s => s.cid));
      const touched = new Set<string>();
      for (const row of this.db.prepare('SELECT cid FROM sources').all() as Array<{ cid: string }>) {
        if (keep.has(row.cid)) continue;
        for (const edge of this.db.prepare('SELECT contact_cid FROM edges WHERE source_cid=?').all(row.cid) as Array<{ contact_cid: string }>) touched.add(edge.contact_cid);
        this.db.prepare('DELETE FROM edges WHERE source_cid=?').run(row.cid);
        this.db.prepare('DELETE FROM sources WHERE cid=?').run(row.cid);
      }
      for (const s of sources) {
        this.db.prepare(`INSERT INTO sources(cid,name,kind,role_id,ended) VALUES(?,?,?,?,?)
          ON CONFLICT(cid) DO UPDATE SET name=excluded.name,kind=excluded.kind,role_id=excluded.role_id,ended=excluded.ended`)
          .run(s.cid, s.name, s.kind, s.roleId ?? null, s.ended ? 1 : 0);
        for (const edge of this.db.prepare('SELECT contact_cid FROM edges WHERE source_cid=?').all(s.cid) as Array<{ contact_cid: string }>) touched.add(edge.contact_cid);
      }
      for (const cid of touched) this.recompute(cid);
    });
  }

  /** Replace one source's edges from a fresh observation at the given daemon source position. */
  replaceEdges(sourceCid: string, edges: ChannelEdge[], observed?: { producerGeneration: string; position: number }): void {
    this.transaction(() => {
      const touched = new Set<string>(edges.map(e => e.contactCid));
      for (const row of this.db.prepare('SELECT contact_cid FROM edges WHERE source_cid=?').all(sourceCid) as Array<{ contact_cid: string }>) touched.add(row.contact_cid);
      this.db.prepare('DELETE FROM edges WHERE source_cid=?').run(sourceCid);
      const insert = this.db.prepare('INSERT INTO edges(source_cid,contact_cid,contact_name,last_activity,root_cid,root_name,role_id) VALUES(?,?,?,?,?,?,?)');
      for (const e of edges) insert.run(sourceCid, e.contactCid, e.contactName, e.lastActivity, e.rootCid ?? null, e.rootName ?? null, e.roleId ?? null);
      this.db.prepare('UPDATE sources SET stale=0,observed_at=?,generation=?,position=? WHERE cid=?')
        .run(this.now(), observed?.producerGeneration ?? null, observed?.position ?? null, sourceCid);
      for (const cid of touched) this.recompute(cid);
    });
  }

  /**
   * Drop every edge to a now-internal identity, from every source including ended ones,
   * whose cached edges are never re-observed. Local SQL only.
   */
  excludeContacts(internal: Set<string>): void {
    if (!internal.size) return;
    this.transaction(() => {
      const cids = [...internal];
      const marks = cids.map(() => '?').join(',');
      const touched = (this.db.prepare(`SELECT DISTINCT contact_cid FROM edges WHERE contact_cid IN (${marks})`).all(...cids) as Array<{ contact_cid: string }>).map(r => r.contact_cid);
      if (!touched.length) return;
      this.db.prepare(`DELETE FROM edges WHERE contact_cid IN (${marks})`).run(...cids);
      for (const cid of touched) this.recompute(cid);
    });
  }

  markStale(sourceCid: string): void {
    this.db.prepare('UPDATE sources SET stale=1 WHERE cid=?').run(sourceCid);
  }

  private recompute(contactCid: string): void {
    const edges = this.db.prepare(`SELECT e.*,s.kind,s.ended FROM edges e JOIN sources s ON s.cid=e.source_cid WHERE e.contact_cid=?`)
      .all(contactCid) as Array<{ contact_name: string; last_activity: string; root_cid: string | null; root_name: string | null; kind: string; ended: number }>;
    if (!edges.length) { this.db.prepare('DELETE FROM channels WHERE cid=?').run(contactCid); return; }
    const newest = edges.reduce((a, b) => (b.last_activity > a.last_activity ? b : a));
    const claims = new Map<string, string>();
    for (const e of edges) if (e.root_cid) claims.set(e.root_cid, e.root_name ?? '');
    const single = claims.size === 1 ? [...claims.entries()][0] : undefined;
    this.db.prepare(`INSERT INTO channels(cid,name,last_activity,root_cid,root_name,conflicting,perspectives,owner_connected,live_perspectives) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cid) DO UPDATE SET name=excluded.name,last_activity=excluded.last_activity,root_cid=excluded.root_cid,root_name=excluded.root_name,
      conflicting=excluded.conflicting,perspectives=excluded.perspectives,owner_connected=excluded.owner_connected,live_perspectives=excluded.live_perspectives`)
      .run(contactCid, newest.contact_name, newest.last_activity, single?.[0] ?? null, single?.[1] ?? null, claims.size > 1 ? 1 : 0,
        edges.length, edges.some(e => e.kind === 'owner' && !e.ended) ? 1 : 0, edges.filter(e => !e.ended).length);
  }

  /**
   * Keyset-paginated channel rows, newest activity first. `root` narrows to rows
   * claiming that root; `q` matches contact name, root name or CID prefix.
   */
  list(options: { cursor?: string; limit?: number; q?: string; root?: string } = {}): ChannelPage {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const where: string[] = ['(live_perspectives>0 OR last_activity>=?)'];
    const args: Array<string | number> = [new Date(this.now() - ENDED_RETENTION_MS).toISOString()];
    if (options.root) { where.push('root_cid=?'); args.push(options.root.toUpperCase()); }
    if (options.q) {
      const q = options.q.trim().toLowerCase();
      where.push(`(instr(lower(name),?)>0 OR instr(lower(coalesce(root_name,'')),?)>0 OR cid LIKE ?)`);
      args.push(q, q, `${q.toUpperCase().replace(/[%_]/g, '')}%`);
    }
    if (options.cursor) {
      const [at, cid] = decodeCursor(options.cursor);
      where.push('(last_activity<? OR (last_activity=? AND cid>?))'); args.push(at, at, cid);
    }
    const rows = this.db.prepare(`SELECT * FROM channels WHERE ${where.join(' AND ')} ORDER BY last_activity DESC,cid ASC LIMIT ?`)
      .all(...args, limit + 1) as Array<Record<string, any>>;
    const more = rows.length > limit; if (more) rows.pop();
    const last = rows.at(-1);
    return { channels: rows.map(toRow), nextCursor: more && last ? encodeCursor(last.last_activity, last.cid) : null };
  }

  /** One channel with every perspective; null when unknown. */
  get(cid: string): { channel: ChannelRow; perspectives: ChannelPerspective[] } | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE cid=?').get(cid.toUpperCase()) as Record<string, any> | undefined;
    if (!row) return null;
    const edges = this.db.prepare(`SELECT e.*,s.name AS source_name,s.kind,s.role_id AS source_role,s.ended,s.stale FROM edges e JOIN sources s ON s.cid=e.source_cid
      WHERE e.contact_cid=? ORDER BY e.last_activity DESC,s.kind DESC`).all(row.cid) as Array<Record<string, any>>;
    return {
      channel: toRow(row),
      perspectives: edges.map(e => ({
        sourceCid: e.source_cid, sourceName: e.source_name, kind: e.kind, ...(e.source_role ? { roleId: e.source_role } : {}),
        ended: !!e.ended, stale: !!e.stale, contactName: e.contact_name, lastActivity: e.last_activity,
        ...(e.root_cid ? { claimedRoot: { rootCid: e.root_cid, rootName: e.root_name ?? '', roleId: e.role_id ?? '' } } : {}),
      })),
    };
  }

  /** Whether `sourceCid` is a recorded perspective of `contactCid`. */
  hasPerspective(contactCid: string, sourceCid: string): { name: string; kind: string; roleId?: string; ended: boolean; generation?: string } | null {
    const row = this.db.prepare(`SELECT s.name,s.kind,s.role_id,s.ended,s.generation FROM edges e JOIN sources s ON s.cid=e.source_cid WHERE e.contact_cid=? AND e.source_cid=?`)
      .get(contactCid.toUpperCase(), sourceCid.toUpperCase()) as Record<string, any> | undefined;
    return row ? { name: row.name, kind: row.kind, ...(row.role_id ? { roleId: row.role_id } : {}), ended: !!row.ended, ...(row.generation ? { generation: row.generation } : {}) } : null;
  }

  sourcesSummary(): Array<{ cid: string; name: string; kind: string; ended: boolean; stale: boolean }> {
    return (this.db.prepare('SELECT cid,name,kind,ended,stale FROM sources ORDER BY kind DESC,name').all() as Array<Record<string, any>>)
      .map(s => ({ cid: s.cid, name: s.name, kind: s.kind, ended: !!s.ended, stale: !!s.stale }));
  }
}

function toRow(row: Record<string, any>): ChannelRow {
  return {
    cid: row.cid, name: row.name, lastActivity: row.last_activity,
    ...(row.root_cid ? { claimedRoot: { rootCid: row.root_cid, rootName: row.root_name ?? '' } } : {}),
    conflictingRootClaims: !!row.conflicting, perspectives: Number(row.perspectives), ownerConnected: !!row.owner_connected,
  };
}
const encodeCursor = (at: string, cid: string) => Buffer.from(JSON.stringify([at, cid])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'string')) return value as [string, string];
  } catch { /* fall through */ }
  throw new Error('invalid channels cursor');
}
