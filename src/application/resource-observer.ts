import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { lstatSync, statSync, readdirSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { splitRootFor } from '../config.js';
import { agentsRoot, tmpRoot, stateRoot, defaultConfigPath } from '../paths.js';

export interface FleetResourceState {
  protocolVersion: 1;
  producerGeneration: string;
  position: number;
  health: 'healthy' | 'failed' | 'unsupported';
}
export interface FleetResourceScope {
  configPath?: string;
  subscribeMutations?: (listener: () => void) => () => void;
  /** Durable notification owners may reinstall degraded watches without idle content polling. */
  retryWatchFailures?: boolean;
  roots?: string[];
  /** Overrides full Fleet discovery for narrow owners such as task delivery. */
  paths?: string[];
  /** Path routing precedes a coalesced committed callback. Undefined means
   * unknown/recovered coverage and requires conservative discovery. */
  onInvalidated?: (path: string | undefined) => void;
  watch?: (path: string, listener: (event: string, filename: string | null) => void) => Pick<FSWatcher, 'on' | 'close'>;
}
// Directory discovery is shared by payload and notification owners. Each owner
// has its own lifetime/coverage; the underlying OS watch is reference counted.
const sharedWatches = new Map<string, {handle:FSWatcher; clients:Set<EventEmitter>; listeners:Map<EventEmitter,(event:string,name:string|null)=>void>}>();
function sharedWatch(path:string,listener:(event:string,name:string|null)=>void):Pick<FSWatcher,'on'|'close'> {
  const key=`${path}:${identity(path, true)}`;
  let entry=sharedWatches.get(key);
  if(!entry){
    const clients=new Set<EventEmitter>(),listeners=new Map<EventEmitter,(event:string,name:string|null)=>void>();
    const handle=watch(path,{persistent:false},(event,name)=>{for(const fn of [...listeners.values()])fn(event,name);});
    entry={handle,clients,listeners};sharedWatches.set(key,entry);
    handle.on('error',error=>{for(const client of [...clients])client.emit('error',error);});
    handle.on('close',()=>{for(const client of [...clients])client.emit('close');});
  }
  const current=entry,client=new EventEmitter();let closed=false;
  current.clients.add(client);current.listeners.set(client,listener);
  return Object.assign(client,{close(){
    if(closed)return;closed=true;current.clients.delete(client);current.listeners.delete(client);
    if(!current.clients.size){sharedWatches.delete(key);current.handle.close();}
  }}) as unknown as Pick<FSWatcher,'on'|'close'>;
}
const commits = new Set<(path: string) => void>();
/** Only call after durable persistence succeeds. Observers cannot fail a commit. */
export function publishFleetResourceCommit(path: string): void {
  for (const listener of [...commits]) { try { listener(resolve(path)); } catch {} }
}
function directoryGone(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}
function identity(path: string, followLink = false): string | undefined {
  try { const value = followLink ? statSync(path) : lstatSync(path); if (value.isSymbolicLink()) throw Error('symbolic resource directory');
    return value.isDirectory() ? `${value.dev}:${value.ino}:${value.birthtimeMs}` : undefined;
  } catch (error) { if (directoryGone(error)) return; throw error; }
}
function within(path: string, root: string) { return path === root || path.startsWith(root + sep); }
/** Lock directories and the claim/reclaim entries derived from their names
 * (`<lock>.claim.<pid>.<uuid>`, `<lock>.reclaim`) are never resources. */
const lockClaim = /\.claim\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|\.reclaim$/;
function lockName(name: string) { return name === '.locks' || name.endsWith('.lock'); }
function lockArtifact(name: string) { return lockName(name) || (lockClaim.test(name) && lockName(name.replace(lockClaim, ''))); }
/** Full discovery is synchronous and lstats every covered directory. Wakes are
 * still delivered promptly, but discovery runs at most once per window. */
const DISCOVERY_WINDOW_MS = 100;

/** Native notifications cover supported local mounts. No idle content scan or
 * silent claim of coverage after watch failure. Parents survive atomic rename.
 * Discovery reads directory metadata only, never opens a controller or transcript. */
export function observeFleetResources(scope: FleetResourceScope, onCommitted: (state: FleetResourceState) => void, signal: AbortSignal) {
  const config = resolve(scope.configPath ?? defaultConfigPath());
  const roots = (scope.roots ?? [agentsRoot(), tmpRoot()]).map(p => resolve(p));
  const paths = (scope.paths ?? (scope.roots && !scope.configPath ? roots : [...roots, splitRootFor(config), join(stateRoot(), 'tasks'), join(stateRoot(), 'rooms'), join(stateRoot(), 'watchdogs'), join(stateRoot(), 'layouts'), join(stateRoot(), 'member-additions'), join(stateRoot(), 'subscriptions')])).map(p => resolve(p));
  // Explicit roots without config select discovery only (notification producers).
  const configEnabled = scope.configPath !== undefined || (!scope.paths && !scope.roots);
  const adoptedHomes = configEnabled ? [join(homedir(), '.claude'), join(homedir(), '.codex')] : [];
  if (configEnabled) paths.push(dirname(config), resolve(stateRoot()), ...adoptedHomes);
  // Explicit resource locations and their ancestors already belong to the
  // caller's read scope (e.g. /home -> /var/home or a linked state root).
  // Discovered descendants keep lstat validation and never traverse child links.
  const trustedPaths = new Set(paths);
  for (const path of paths) {
    let parent = path;
    for (let depth = 0; depth < 4 && dirname(parent) !== parent; depth++, parent = dirname(parent)) trustedPaths.add(parent);
  }
  const resourceIdentity = (path: string) => identity(path, trustedPaths.has(path));
  const locks = resolve(stateRoot(), 'locks');
  const ignored = (path: string) => within(path, locks) || path.split(sep).some(name => lockArtifact(name) || name.endsWith('.tmp'));
  let state: FleetResourceState = { protocolVersion: 1, producerGeneration: randomUUID(), position: 0, health: 'healthy' };
  let disposed = signal.aborted, queued = false, discoveredAt = -Infinity;
  let recovery: ReturnType<typeof setTimeout> | undefined, discovery: ReturnType<typeof setTimeout> | undefined;
  let installing = false, installFailure: NodeJS.ErrnoException | undefined;
  const cursors = new Set<{ accepts(path: string): boolean; position: number; dispose(): void }>();
  const watchers = new Map<string, { identity: string; handle: Pick<FSWatcher, 'on' | 'close'> }>();
  const release = () => { const old = [...watchers.values()]; watchers.clear(); for (const entry of old) entry.handle.close(); };
  const fail = (error: NodeJS.ErrnoException) => {
    if (installing) { installFailure = error; return; }
    if (disposed || state.health !== 'healthy') return;
    state = { ...state, position: state.position + 1, health: ['ENOSYS', 'ENOTSUP', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'].includes(error.code ?? '') ? 'unsupported' : 'failed' };
    release(); onCommitted({ ...state });
    recover();
  };
  const install = () => {
    installing = true; installFailure = undefined;
    let added = 0;
    try {
      const wanted = new Set<string>();
      const cover = (dir: string) => {
        const id = resourceIdentity(dir); if (!id) return;
        wanted.add(dir);
        const existing = watchers.get(dir);
        if (existing && existing.identity === id) return;
        if (existing) { watchers.delete(dir); existing.handle.close(); }
        let handle: Pick<FSWatcher, 'on' | 'close'>;
        try { handle = (scope.watch ?? sharedWatch)(dir, (_event, filename) => {
          if (watchers.get(dir)?.handle !== handle) return;
          // Ignore sibling noise from ancestor coverage, lock churn and delivery acknowledgements.
          const changed = filename === null ? dir : resolve(dir, String(filename));
          if (ignored(changed)) return;
          if (paths.some(path => within(changed, path) || within(path, changed)) || (configEnabled && changed === config) || filename === null) wake(filename === null ? undefined : changed);
        }); } catch (error) {
          // Parent coverage owns removal/recreation. Only verified disappearance
          // is benign; permissions, unsupported watches and other errors fail.
          if (directoryGone(error) && !resourceIdentity(dir)) return;
          throw error;
        }
        watchers.set(dir, { identity: id, handle }); added++;
        handle.on('error', (error: NodeJS.ErrnoException) => { if (watchers.get(dir)?.handle === handle) fail(error); });
        handle.on('close', () => { if (watchers.get(dir)?.handle === handle) fail(Error('resource watch closed')); });
        if (installFailure) throw installFailure;
      };
      const visit = (dir: string, depth: number) => {
        if (within(dir, locks)) return;
        const id = resourceIdentity(dir); if (!id) return;
        // Watch before enumerating children: creation before watch is covered by
        // this scan; creation after watch schedules another discovery pass.
        cover(dir);
        if (!depth) return;
        let entries: Dirent[];
        try { entries = readdirSync(dir, { withFileTypes: true }); }
        catch (error) { if (directoryGone(error) && !resourceIdentity(dir)) return; throw error; }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || lockArtifact(entry.name)) continue;
          visit(join(dir, entry.name), depth - 1);
        }
      };
      for (const path of paths) {
        // Enough ancestors to retain the subscription when its state root is replaced.
        let parent = path;
        for (let depth = 0; depth < 4 && dirname(parent) !== parent; depth++, parent = dirname(parent)) {
          if (resourceIdentity(parent)) { wanted.add(parent); cover(parent); }
        }
        visit(path, configEnabled && (path === dirname(config) || adoptedHomes.includes(path)) ? 0 : 3);
      }
      for (const [dir, entry] of watchers) {
        if (!wanted.has(dir) || resourceIdentity(dir) !== entry.identity) { watchers.delete(dir); entry.handle.close(); }
      }
      if (installFailure) throw installFailure;
      return added;
    } finally { installing = false; }
  };
  const recover = () => {
    if (disposed || state.health === 'healthy' || !scope.retryWatchFailures || recovery) return;
    recovery = setTimeout(() => {
      recovery = undefined;
      if (disposed) return;
      try { install(); }
      catch { release(); recover(); return; }
      state = { ...state, position: state.position + 1, health: 'healthy' };
      scope.onInvalidated?.(undefined);
      // Reinstallation precedes one checkpoint recovery pass; later work is
      // event driven again. Degraded retries inspect directory metadata only.
      onCommitted({ ...state });
    }, 3000);
    recovery.unref();
  };
  const wake = (path?: string) => {
    if (disposed || state.health !== 'healthy') return;
    scope.onInvalidated?.(path);
    state = { ...state, position: state.position + 1 };
    for (const cursor of cursors) if (path === undefined || cursor.accepts(path)) cursor.position = state.position;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed || state.health !== 'healthy') return;
      if (!discovery) {
        const wait = discoveredAt + DISCOVERY_WINDOW_MS - performance.now();
        if (wait <= 0) { discover(false); return; }
        discovery = setTimeout(() => { discovery = undefined; discover(true); }, wait); discovery.unref();
      }
      // Covered directories were watched before this wake; directories created
      // since the last pass are covered by the pending one.
      onCommitted({ ...state });
    });
  };
  const discover = (deferred: boolean) => {
    if (disposed || state.health !== 'healthy') return;
    discoveredAt = performance.now();
    let added: number;
    try { added = install(); } catch (error) { fail(error as NodeJS.ErrnoException); return; }
    // Every wake before a deferred pass was already delivered. Writes into
    // directories it newly covers have no event of their own: treat as unknown.
    if (deferred) {
      if (!added) return;
      state = { ...state, position: state.position + 1 };
      scope.onInvalidated?.(undefined);
      for (const cursor of cursors) cursor.position = state.position;
    }
    onCommitted({ ...state });
  };
  const direct = (path: string) => { if (paths.some(root => within(path, root)) || (configEnabled && path === config)) wake(path); };
  let detach:(()=>void)|undefined;
  const dispose = () => { if (disposed) return; disposed = true; clearTimeout(recovery); recovery = undefined; clearTimeout(discovery); discovery = undefined; detach?.(); for (const cursor of [...cursors]) cursor.dispose(); commits.delete(direct); signal.removeEventListener('abort', dispose); release(); };
  if (!disposed) {
    commits.add(direct); detach=scope.subscribeMutations?.(wake); signal.addEventListener('abort', dispose, { once: true });
    try { install(); } catch (error) { fail(error as NodeJS.ErrnoException); }
  }
  const snapshot = () => ({ ...state, ...(disposed ? { health: 'failed' as const } : {}) });
  // View-local cursors share coverage and health, but unrelated file commits
  // cannot invalidate a capture. Unknown wakes remain conservative.
  const cursor = (accepts: (path: string) => boolean, lifetime: AbortSignal) => {
    const entry = { accepts, position: state.position, dispose() { cursors.delete(entry); lifetime.removeEventListener('abort', entry.dispose); } };
    if (!disposed && !lifetime.aborted) { cursors.add(entry); lifetime.addEventListener('abort', entry.dispose, { once: true }); }
    return { snapshot: () => ({ ...snapshot(), position: entry.position }), dispose: entry.dispose };
  };
  return { snapshot, cursor, dispose };
}
