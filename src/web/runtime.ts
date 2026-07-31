import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { RoleRepository } from '../application/role-repository.js';
import { FleetQueryService } from '../application/fleet-query-service.js';
import { AcpRoleSessionAdapter, TmuxRoleSessionAdapter } from '../application/session-control.js';
import { StructuredLogService } from '../application/log-service.js';
import { RoleCommandService } from '../application/role-command-service.js';
import { RoleCreationService } from '../application/role-creation-service.js';
import { FleetError } from '../application/errors.js';
import { controlRequest, controlSocketPath } from '../session/control.js';
import { Tmux } from '../tmux.js';
import { pickBackend } from '../supervisor/index.js';
import { realExec } from '../exec.js';
import { home, stateRoot } from '../paths.js';
import { AuditSink } from './audit.js';
import { FleetEventBus } from './events.js';
import { buildWebServer, type WebServer } from './server.js';
import { TerminalBridgeManager } from './terminal/bridge.js';
import { acquireWebServerLock } from './lock.js';
import { TrustedDeviceStore } from './device-store.js';
import { WebAuth } from './auth.js';
import { startWebControlServer, type WebControlServer } from './control.js';

export interface StartWebOptions {
  configPath?: string;
  port?: number;
  open?: boolean;
  binPath: string;
  log?(line: string): void;
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
  const auth = new WebAuth(
    `http://127.0.0.1:${requestedPort}`, `127.0.0.1:${requestedPort}`,
    Date.now, new TrustedDeviceStore(webDir),
  );
  const tmux = new Tmux();
  const backend = pickBackend();
  const repository = new RoleRepository({
    configPath: options.configPath,
    probeBackend: async name => {
      let acp = false;
      const permanent = resolve(home(), '.ours-fleet', 'agents', name);
      const temporary = resolve(home(), '.ours-fleet', 'tmp', name);
      for (const dir of [permanent, temporary]) {
        if (!existsSync(controlSocketPath(dir))) continue;
        try { acp = (await controlRequest(dir, { command: 'snapshot' }, 500)).ok; }
        catch { /* stale socket is evidence, not reachability */ }
      }
      return { acp, tmux: await tmux.has(name).catch(() => false) };
    },
  });
  const events = new FleetEventBus();
  const audit = new AuditSink();
  const terminals = new TerminalBridgeManager({ repository, audit, tmux });
  const terminalAvailable = await terminals.available();
  const query = new FleetQueryService({
    repository, supervisor: backend, tmux,
    capabilityContext: { terminalPtyAvailable: terminalAvailable },
  });
  const ops = { backend, binPath: options.binPath, log: options.log ?? (() => {}) };
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
  let server: WebServer;
  try {
    server = await buildWebServer({
    query, repository, logs, commands, creation, audit, events,
    terminalUpgrade: terminalAvailable
      ? async (socket, _request, roleId, _ticket, hello) => terminals.connect(socket, roleId, hello)
      : undefined,
    async session(roleId) {
      const role = await repository.get(roleId);
      if (!role) throw new FleetError('role_not_found', `no such role '${roleId}'`);
      if (role.configuredBackend === 'acp') {
        const dir = repository.stateDir(role);
        if (!dir) throw new FleetError('control_unavailable', 'role state directory is unavailable');
        return new AcpRoleSessionAdapter(dir);
      }
      if (role.configuredBackend === 'tmux' || role.detectedBackend === 'tmux')
        return new TmuxRoleSessionAdapter(roleId, tmux);
      throw new FleetError('capability_unavailable', 'role session backend is unavailable');
    },
    }, { origin: `http://127.0.0.1:${requestedPort}`, host: `127.0.0.1:${requestedPort}` }, { auth });
  } catch (error) {
    lock.release();
    throw error;
  }
  let address: string;
  try { address = await server.app.listen({ host: '127.0.0.1', port: requestedPort }); }
  catch (error) { await server.close(); lock.release(); throw error; }
  const actual = new URL(address);
  if (actual.hostname !== '127.0.0.1') {
    await server.close();
    lock.release();
    throw new FleetError('forbidden', 'web console refused a non-loopback bind');
  }
  const host = `127.0.0.1:${actual.port}`;
  server.auth.setBoundary(`http://${host}`, host);
  let control: WebControlServer;
  try {
    control = await startWebControlServer({
      dir: webDir,
      onOpen() {
        const url = `http://${host}/#bootstrap=${server.auth.mintBootstrap()}`;
        openBrowser(url);
      },
      onRevokeAll() { server.auth.revokeAllTrustedDevices(); },
    });
  } catch (error) {
    await server.close();
    lock.release();
    throw error;
  }
  if (options.open !== false)
    openBrowser(`http://${host}/#bootstrap=${server.auth.bootstrapSecret}`);
  return {
    ...server, address: `http://${host}`,
    async close() {
      try { await control.close(); await terminals.close(); await server.close(); }
      finally { lock.release(); }
    },
  };
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => undefined);
  child.unref();
}
