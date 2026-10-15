import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { loadConfig, ROLE_NAME_RE, splitRootFor, type SessionBackendId } from '../config.js';
import { agentsRoot, defaultConfigPath, tmpRoot } from '../paths.js';
import { controlSocketPath } from '../session/control.js';

export interface ConversationRoleState {
  roleId: string;
  /** Connection-owned ordering; never a session stateRevision. */
  roleRevision: number;
  roleLifetime: string;
  availability: 'available' | 'unavailable' | 'missing';
  fallbackHarness?: string;
  backend?: SessionBackendId;
  stateDir?: string;
  health: 'healthy' | 'unsupported' | 'failed';
  failure?: 'watch-unsupported' | 'watch-error' | 'watch-closed' | 'role-read-failed' | 'observer-disposed';
}
export interface ConversationRoleObservation {
  snapshot(): ConversationRoleState;
  subscribe(listener: (state: ConversationRoleState) => void): { snapshot: ConversationRoleState; unsubscribe(): void };
  dispose(): void;
}
export type ObserveConversationRole = (listener: (state: ConversationRoleState) => void) => ConversationRoleObservation;
export interface ConversationRoleObserverOptions {
  roleId: string;
  configPath?: string;
  permanentRoot?: string;
  temporaryRoot?: string;
  watch?: (path: string, listener: (event: string, filename: string | null) => void) => Pick<FSWatcher, 'on' | 'close'>;
  subscribeMutations?: (listener: () => void) => () => void;
}
function identity(path: string): string | undefined {
  try { const s = lstatSync(path); return `${s.dev}:${s.ino}:${s.birthtimeMs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}

/** Native directory notifications are assumed reliable on qualified host/mount setups.
 * No periodic reads or claim of detecting every silently dropped filesystem event.
 */
export class ConversationRoleObserver implements ConversationRoleObservation {
  private state: ConversationRoleState;
  private watchers = new Map<string, { identity: string; names: Set<string> | null; handle: Pick<FSWatcher, 'on' | 'close'> }>();
  private detach?: () => void;
  private disposed = false;
  private readonly listeners = new Set<(state: ConversationRoleState) => void>();
  private queued = false;
  private fingerprint?: string;
  private readonly configPath: string;
  private readonly permanent: string;
  private readonly temporary: string;
  constructor(private readonly options: ConversationRoleObserverOptions, private readonly listener: (state: ConversationRoleState) => void) {
    if (!ROLE_NAME_RE.test(options.roleId)) throw new Error('invalid role id');
    this.configPath = resolve(options.configPath ?? defaultConfigPath());
    this.permanent = resolve(options.permanentRoot ?? agentsRoot(), options.roleId);
    this.temporary = resolve(options.temporaryRoot ?? tmpRoot(), options.roleId);
    this.state = { roleId: options.roleId, roleRevision: 0, roleLifetime: randomUUID(), availability: 'missing', health: 'healthy' };
    this.refresh();
    if (this.state.health === 'healthy') this.detach = options.subscribeMutations?.(() => this.schedule());
  }
  snapshot(): ConversationRoleState {
    return this.disposed ? { ...this.state, health: 'failed', failure: 'observer-disposed' } : { ...this.state };
  }
  subscribe(listener: (state: ConversationRoleState) => void) {
    if (!this.disposed) this.listeners.add(listener);
    return { snapshot: this.snapshot(), unsubscribe: () => { this.listeners.delete(listener); } };
  }
  private publish() {
    this.listener(this.snapshot());
    for (const listener of this.listeners) listener(this.snapshot());
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.listeners.clear();
  }
  private release() {
    const retired = [...this.watchers.values()];
    // Retire before close: native close events may arrive synchronously or later.
    this.watchers.clear();
    for (const watcher of retired) watcher.handle.close();
    this.detach?.(); this.detach = undefined;
  }
  private fail(failure: NonNullable<ConversationRoleState['failure']>) {
    if (this.disposed || this.state.health !== 'healthy') return;
    this.state = { ...this.state, roleRevision: this.state.roleRevision + 1, health: failure === 'watch-unsupported' ? 'unsupported' : 'failed', failure };
    this.release(); this.publish();
  }
  private schedule() {
    if (this.queued || this.disposed || this.state.health !== 'healthy') return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (!this.disposed && this.state.health === 'healthy') this.refresh(); });
  }
  private refresh() {
    try {
      // Install parents before reading, including absent children, so atomic rename
      // and recreation cannot strand us watching an unlinked inode.
      this.install();
      if (this.state.health !== 'healthy') return;
      let configured: ReturnType<typeof loadConfig>['roles'][number] | undefined;
      const split = splitRootFor(this.configPath);
      if (identity(this.configPath) && identity(split) && identity(join(split, 'agents')))
        configured = loadConfig(this.configPath).roles.find(role => role.name === this.options.roleId);
      const permanentId = identity(this.permanent), temporaryId = identity(this.temporary);
      const stateDir = temporaryId ? realpathSync(this.temporary) : permanentId ? realpathSync(this.permanent) : undefined;
      let temporary: { harness?: string; session?: SessionBackendId } | undefined;
      if (!configured && temporaryId && identity(join(this.temporary, 'role.yaml'))) {
        const raw = parse(readFileSync(join(this.temporary, 'role.yaml'), 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
            || (raw.session !== undefined && raw.session !== 'acp' && raw.session !== 'codex-app-server')) throw new Error('invalid temporary role snapshot');
        temporary = { session: raw.session ?? 'acp', harness: typeof raw.harness === 'string' ? raw.harness : 'claude-code' };
      }
      const backend = configured?.session ?? temporary?.session;
      const fallbackHarness = configured?.harness ?? temporary?.harness;
      const socket = stateDir ? identity(controlSocketPath(stateDir)) : undefined;
      const tokenPath = stateDir && join(stateDir, '.control-token');
      const token = tokenPath && identity(tokenPath) ? createHash('sha256').update(readFileSync(tokenPath)).digest('hex') : undefined;
      const exists = Boolean(configured || permanentId || temporaryId);
      const availability = !exists ? 'missing' : stateDir && socket && token && backend ? 'available' : 'unavailable';
      const fingerprint = JSON.stringify([Boolean(configured), permanentId, temporaryId, backend, socket, token]);
      const lifetime = this.fingerprint === fingerprint ? this.state.roleLifetime : randomUUID();
      this.fingerprint = fingerprint;
      const next: ConversationRoleState = { roleId: this.options.roleId, roleRevision: this.state.roleRevision, roleLifetime: lifetime,
        availability, fallbackHarness, backend, stateDir, health: 'healthy' };
      if (JSON.stringify(next) !== JSON.stringify(this.state)) {
        this.state = { ...next, roleRevision: this.state.roleRevision + 1 };
        this.publish();
      }
    } catch { this.fail('role-read-failed'); }
  }
  private install() {
    const wanted = new Map<string, Set<string> | null>();
    const add = (dir: string, child?: string) => {
      if (child === undefined) wanted.set(dir, null);
      else if (wanted.get(dir) !== null) { const names = wanted.get(dir) ?? new Set<string>(); names.add(child); wanted.set(dir, names); }
    };
    const parents = (path: string, boundary: string) => {
      while (path !== boundary && dirname(path) !== path) { add(dirname(path), basename(path)); path = dirname(path); }
    };
    const configRoot = splitRootFor(this.configPath);
    const configBoundary = dirname(dirname(this.configPath));
    parents(this.configPath, configBoundary);
    for (const dir of [configRoot, ...['agents', 'brains', 'roles', 'agent_templates'].map(kind => join(configRoot, kind))]) {
      parents(dir, configBoundary); add(dir);
    }
    for (const dir of [this.permanent, this.temporary]) {
      parents(dir, dirname(dirname(dirname(dir))));
      for (const name of ['role.yaml', '.control-token', '.control.sock']) add(dir, name);
      const socket = controlSocketPath(dir);
      parents(socket, dirname(dirname(socket)));
    }
    for (const [dir, current] of this.watchers) {
      if (!wanted.has(dir) || identity(dir) !== current.identity) { this.watchers.delete(dir); current.handle.close(); }
    }
    for (const [dir, names] of wanted) {
      const id = identity(dir); if (!id) continue;
      const existing = this.watchers.get(dir);
      if (existing) { existing.names = names; continue; }
      try {
        const handle = (this.options.watch ?? ((path, listener) => watch(path, { persistent: false }, listener)))(dir, (_event, filename) => {
          const entry = this.watchers.get(dir);
          if (filename === null || !entry?.names || entry.names.has(String(filename)) || String(filename) === basename(dir)) this.schedule();
        });
        this.watchers.set(dir, { identity: id, names, handle });
        handle.on('error', (error: NodeJS.ErrnoException) => {
          if (this.watchers.get(dir)?.handle === handle) this.watchFailure(error);
        });
        handle.on('close', () => {
          if (this.watchers.get(dir)?.handle !== handle) return;
          this.watchers.delete(dir);
          this.fail('watch-closed');
        });
      } catch (error) { this.watchFailure(error as NodeJS.ErrnoException); return; }
    }
  }
  private watchFailure(error: NodeJS.ErrnoException) {
    this.fail(['ENOSYS', 'ENOTSUP', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'].includes(error.code ?? '') ? 'watch-unsupported' : 'watch-error');
  }
}
