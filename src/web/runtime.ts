import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, type FleetConfig } from '../config.js';
import { RoleRepository } from '../application/role-repository.js';
import { FleetQueryService } from '../application/fleet-query-service.js';
import { RoleSessionControlAdapter } from '../application/session-control.js';
import { StructuredLogService } from '../application/log-service.js';
import { RoleCommandService } from '../application/role-command-service.js';
import { RoleCreationService } from '../application/role-creation-service.js';
import { RoleRemovalService } from '../application/role-removal-service.js';
import { FleetError } from '../application/errors.js';
import { controlRequest, controlSocketPath } from '../session/control.js';
import { pickBackend } from '../supervisor/index.js';
import { realExec } from '../exec.js';
import { home, stateRoot } from '../paths.js';
import { AuditSink } from './audit.js';
import { FleetEventBus } from './events.js';
import { buildWebServer, type WebServer } from './server.js';
import { FleetConfigService } from './fleet-config-service.js';
import { mergeTopology } from './topology-model.js';
import { TopologyDraftStore } from './topology-draft-store.js';
import { TopologyPromoteService } from './topology-promote.js';
import { doctor } from '../doctor.js';
import { acquireWebServerLock } from './lock.js';
import { TrustedDeviceStore } from './device-store.js';
import { WebAuth } from './auth.js';
import { startWebControlServer, type WebControlServer } from './control.js';
import { WebAccessStore, validatePublicOrigin, type WebAccessConfig } from './access.js';
import { buildWatchdogFindings, cachedWatchdogFindingsProvider, WatchdogQueryService } from '../watchdog/query.js';
import { latestReport } from '../watchdog/store.js';
import { TaskRoomApplicationService } from '../application/task-room-service.js';

const CONFIG_CACHE_TTL_MS = 5_000;

/**
 * loadConfig re-parses YAML from disk on every call; the watchdog list/reports
 * routes get polled by the console UI, so cache the resolved config for a
 * short TTL rather than re-parsing per request. Runtime-only concern (not the
 * scheduler's), so a plain Date.now() clock is fine.
 */
function cachedConfigProvider(configPath: string | undefined): () => FleetConfig {
  let cached: { at: number; cfg: FleetConfig } | undefined;
  return () => {
    const now = Date.now();
    if (!cached || now - cached.at >= CONFIG_CACHE_TTL_MS) cached = { at: now, cfg: loadConfig(configPath) };
    return cached.cfg;
  };
}

export interface StartWebOptions {
  configPath?: string;
  port?: number;
  open?: boolean;
  binPath: string;
  log?(line: string): void;
  bind?: string;
  publicOrigin?: string;
  access?: WebAccessConfig;
}

export interface RunningWebConsole extends WebServer {
  address: string;
}

export async function startWebConsole(options: StartWebOptions): Promise<RunningWebConsole> {
  const requestedPort = options.port ?? 49_271;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535)
    throw new FleetError('invalid_request', 'port must be between 0 and 65535');
  const lock = acquireWebServerLock();
  const webDir = resolve(stateRoot(), 'web');
  const bind = options.bind ?? '127.0.0.1';
  const publicOrigin = options.publicOrigin ? validatePublicOrigin(options.publicOrigin) : undefined;
  if (!isLoopback(bind) && !publicOrigin) {
    lock.release();
    throw new FleetError('forbidden', 'a non-loopback bind requires an explicit --public-origin');
  }
  const access = options.access ?? new WebAccessStore(webDir).read();
  const auth = new WebAuth(
    publicOrigin?.origin ?? `http://127.0.0.1:${requestedPort}`,
    publicOrigin?.host ?? `127.0.0.1:${requestedPort}`,
    Date.now, new TrustedDeviceStore(webDir),
    access,
  );
  const backend = pickBackend();
  const repository = new RoleRepository({
    configPath: options.configPath,
    probeBackend: async name => {
      let backend: import('../config.js').SessionBackendId | undefined;
      const permanent = resolve(home(), '.ours-fleet', 'agents', name);
      const temporary = resolve(home(), '.ours-fleet', 'tmp', name);
      for (const dir of [permanent, temporary]) {
        if (!existsSync(controlSocketPath(dir))) continue;
        try {
          const response = await controlRequest(dir, { command: 'snapshot' }, 500);
          const snapshot = response.result as { backend?: unknown } | undefined;
          if (response.ok && (snapshot?.backend === 'acp'
              || snapshot?.backend === 'codex-app-server')) backend = snapshot.backend;
        }
        catch { /* stale socket is evidence, not reachability */ }
      }
      return { backend };
    },
  });
  const events = new FleetEventBus();
  const audit = new AuditSink();
  const watchdogConfigProvider = cachedConfigProvider(options.configPath);
  const log = options.log ?? (() => {});
  let loggedWatchdogFindingsError = false;
  // Needs-attention integration: worst per-role watchdog finding,
  // rebuilt from stored reports. A store hiccup (corrupt state, unreadable
  // report) must never break the fleet list, so it degrades to an empty map
  // and logs once rather than repeating on every poll. status() calls this
  // once per role, so list()'s O(roles) sweep would otherwise cost
  // O(roles x watchdogs) disk reads every 1-3s of console polling —
  // cachedWatchdogFindingsProvider memoizes the whole build behind the same
  // TTL as the config cache above.
  const watchdogFindings = cachedWatchdogFindingsProvider(() => {
    try {
      return buildWatchdogFindings(watchdogConfigProvider(), latestReport);
    } catch (error) {
      if (!loggedWatchdogFindingsError) {
        loggedWatchdogFindingsError = true;
        log(`watchdog findings unavailable: ${(error as Error).message}`);
      }
      return new Map();
    }
  }, CONFIG_CACHE_TTL_MS);
  const query = new FleetQueryService({
    repository, supervisor: backend,
    capabilityContext: {},
    watchdogFindings,
  });
  const ops = { backend, binPath: options.binPath, log };
  const creation = new RoleCreationService({
    configPath: options.configPath, ops, binPath: options.binPath,
    allowedCwdRoots: [realpathSync(home()), realpathSync(process.cwd())],
    probeReady: async name => {
      const detail = await query.detail(name).catch(() => undefined);
      return detail?.status.overall === 'ready' || detail?.status.overall === 'busy'
        ? 'ready' : detail?.status.overall === 'attention' ? 'attention' : 'unknown';
    },
    onProgress: action => {
      events.publish('creation.changed', action, action.roleId);
      void audit.record({
        roleId: action.roleId, action: `creation.${action.state}`,
        result: action.error?.code ?? action.state,
      });
    },
  });
  const removal = new RoleRemovalService({
    configPath: options.configPath, ops,
    currentControlRole: process.env.OURS_FLEET_PROXY_CALLER,
  });
  const commands = new RoleCommandService({
    repository, ops, configPath: options.configPath,
    status: async roleId => (await query.detail(roleId)).status,
    onProgress: receipt => {
      events.publish('action.changed', receipt, receipt.roleId);
      void audit.record({
        roleId: receipt.roleId, action: `lifecycle.${receipt.action}`,
        result: receipt.state, errorCode: receipt.error?.code,
      });
    },
  });
  const logs = new StructuredLogService(backend, realExec);
  const watchdogs = new WatchdogQueryService(watchdogConfigProvider);
  const configuration = new FleetConfigService({
    configPath: options.configPath,
    preflight: path => doctor({ configPath: path, yamlMode: 'strict' }),
  });
  const topologyDrafts = new TopologyDraftStore({ dir: webDir });
  const readTopology = async () => mergeTopology(
    loadConfig(options.configPath), await query.list(), topologyDrafts.read());
  const topologyPromote = new TopologyPromoteService({
    drafts: topologyDrafts, configuration, topology: readTopology,
  });
  let server: WebServer;
  try {
    server = await buildWebServer({
    query, repository, logs, commands, creation, removal, audit, events, watchdogs, configuration,
    taskRooms: new TaskRoomApplicationService(options.configPath),
    topology: readTopology, topologyDrafts, topologyPromote,
    async session(roleId) {
      const role = await repository.get(roleId);
      if (!role) throw new FleetError('role_not_found', `no such role '${roleId}'`);
      if (role.configuredBackend === 'acp'
          || role.configuredBackend === 'codex-app-server') {
        const dir = repository.stateDir(role);
        if (!dir) throw new FleetError('control_unavailable', 'role state directory is unavailable');
        return new RoleSessionControlAdapter(dir);
      }
      throw new FleetError('capability_unavailable', 'role session backend is unavailable');
    },
    }, { origin: `http://127.0.0.1:${requestedPort}`, host: `127.0.0.1:${requestedPort}` }, { auth });
  } catch (error) {
    lock.release();
    throw error;
  }
  let address: string;
  try { address = await server.app.listen({ host: bind, port: requestedPort }); }
  catch (error) { await server.close(); lock.release(); throw error; }
  const actual = new URL(address);
  const localHost = `127.0.0.1:${actual.port}`;
  const browserOrigin = publicOrigin?.origin ?? `http://${localHost}`;
  const browserHost = publicOrigin?.host ?? localHost;
  server.auth.setBoundary(browserOrigin, browserHost, publicOrigin ? {
    // nginx's safe default uses the loopback upstream as Host. The declared
    // browser Origin remains mandatory for auth/mutations and WebSocket hello,
    // so operators do not need a fragile Host-rewrite incantation.
    hosts: [localHost, `localhost:${actual.port}`],
  } : {
    hosts: [`localhost:${actual.port}`], origins: [`http://localhost:${actual.port}`],
  });
  let control: WebControlServer;
  try {
    control = await startWebControlServer({
      dir: webDir,
      onOpen() {
        const url = access.mode === 'pairing'
          ? `${browserOrigin}/#bootstrap=${server.auth.mintBootstrap()}` : `${browserOrigin}/`;
        openBrowser(url);
      },
      onRevokeAll() { server.auth.revokeAllTrustedDevices(); },
    });
  } catch (error) {
    await server.close();
    lock.release();
    throw error;
  }
  if (options.open !== false) openBrowser(access.mode === 'pairing'
    ? `${browserOrigin}/#bootstrap=${server.auth.bootstrapSecret}` : `${browserOrigin}/`);
  return {
    ...server, address: browserOrigin,
    async close() {
      try { await control.close(); await server.close(); }
      finally { lock.release(); }
    },
  };
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => undefined);
  child.unref();
}
