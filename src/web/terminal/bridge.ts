import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import { Tmux, tmuxArgs } from '../../tmux.js';
import { FleetError } from '../../application/errors.js';
import type { RoleRepository } from '../../application/role-repository.js';
import type { AuditSink } from '../audit.js';

const OUTPUT = 0x01;
const INPUT = 0x02;
const MAX_INPUT = 8 * 1024;
const RING_BYTES = 2 * 1024 * 1024;
const RING_FRAMES = 10_000;
const LEASE_MS = 30_000;

interface Frame { seq: bigint; bytes: Uint8Array }
interface Viewer {
  socket: WebSocket;
  sessionLabel: string;
  resyncPending: boolean;
  tokens: number;
  tokenAt: number;
}

interface HeadlessProjection {
  write(data: string | Uint8Array, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  serialize(): string;
}

type Constructor<T> = new (...args: any[]) => T;

/** Node exposes these CommonJS xterm packages under `default`; Vite may expose named exports. */
export function resolveModuleConstructor<T>(module: unknown, name: string): Constructor<T> {
  const record = module && typeof module === 'object' ? module as Record<string, unknown> : {};
  const fallback = record.default && typeof record.default === 'object'
    ? record.default as Record<string, unknown> : {};
  const value = record[name] ?? fallback[name];
  if (typeof value !== 'function')
    throw new FleetError('capability_unavailable', `${name} constructor is unavailable`);
  return value as Constructor<T>;
}

export interface TerminalBridgeManagerOptions {
  repository: RoleRepository;
  audit: AuditSink;
  tmux?: Tmux;
  maxBridges?: number;
  graceMs?: number;
  loadPty?: () => Promise<typeof import('node-pty')>;
}

export class TerminalBridgeManager {
  private readonly bridges = new Map<string, TerminalBridge>();
  private ptyModule?: typeof import('node-pty');
  private ptyError?: string;
  constructor(private readonly options: TerminalBridgeManagerOptions) {}

  async available(): Promise<boolean> {
    if (this.ptyModule) return true;
    if (this.ptyError) return false;
    try {
      this.ptyModule = await (this.options.loadPty?.() ?? import('node-pty'));
      return true;
    } catch (error) {
      this.ptyError = (error as Error).message;
      return false;
    }
  }
  diagnostic(): string | undefined { return this.ptyError; }

  async connect(socket: WebSocket, roleId: string, hello: Record<string, unknown>): Promise<void> {
    const role = await this.options.repository.get(roleId);
    if (!role) throw new FleetError('role_not_found', `no such role '${roleId}'`);
    if (role.configuredBackend !== 'tmux' && role.detectedBackend !== 'tmux')
      throw new FleetError('capability_unavailable', 'terminal is only available for tmux roles');
    if (!await this.available())
      throw new FleetError('capability_unavailable', `node-pty unavailable: ${this.ptyError ?? 'not installed'}`);
    let bridge = this.bridges.get(roleId);
    if (!bridge) {
      if (this.bridges.size >= (this.options.maxBridges ?? 12))
        throw new FleetError('rate_limited', 'terminal bridge limit reached');
      const tmux = this.options.tmux ?? new Tmux();
      if (!await tmux.has(roleId))
        throw new FleetError('offline', `tmux session '${roleId}' is offline`, { provesOffline: true });
      bridge = await TerminalBridge.create(
        roleId, tmux, this.ptyModule!, this.options.audit,
        () => this.bridges.delete(roleId), this.options.graceMs ?? 30_000);
      this.bridges.set(roleId, bridge);
    }
    bridge.add(socket, hello);
  }

  async close(): Promise<void> {
    for (const bridge of this.bridges.values()) bridge.dispose('server_shutdown');
    this.bridges.clear();
  }
}

class TerminalBridge {
  readonly id = randomUUID();
  private readonly viewers = new Map<WebSocket, Viewer>();
  private readonly ring: Frame[] = [];
  private ringBytes = 0;
  private seq = 0n;
  private cols = 120;
  private rows = 36;
  private lease?: { socket: WebSocket; id: string; expiresAt: number };
  private cleanupTimer?: NodeJS.Timeout;
  private disposed = false;

  private constructor(
    private readonly roleId: string,
    private readonly pty: IPty,
    private readonly projection: HeadlessProjection,
    private readonly audit: AuditSink,
    private readonly onDisposed: () => void,
    private readonly graceMs: number,
  ) {}

  static async create(
    roleId: string, tmux: Tmux, ptyModule: typeof import('node-pty'), audit: AuditSink,
    onDisposed: () => void, graceMs: number,
  ): Promise<TerminalBridge> {
    const [headless, serialization] = await Promise.all([
      import('@xterm/headless'), import('@xterm/addon-serialize'),
    ]);
    const Terminal = resolveModuleConstructor<{
      write(data: string | Uint8Array, callback?: () => void): void;
      resize(cols: number, rows: number): void;
      loadAddon(addon: unknown): void;
      dispose(): void;
    }>(headless, 'Terminal');
    const SerializeAddon = resolveModuleConstructor<{
      serialize(): string; dispose(): void;
    }>(serialization, 'SerializeAddon');
    const terminal = new Terminal({ cols: 120, rows: 36, scrollback: 5_000, allowProposedApi: true });
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    const history = await tmux.captureHistory(roleId, 5_000).catch(() => '');
    if (history) await new Promise<void>(resolve => terminal.write(history, resolve));
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const pty = ptyModule.spawn('tmux', tmuxArgs(roleId, ['attach-session', '-t', roleId]), {
      name: 'xterm-256color', cols: 120, rows: 36,
      cwd: process.env.HOME ?? process.cwd(), env: { ...env, TERM: 'xterm-256color' },
    });
    const projection: HeadlessProjection = {
      write: (data, callback) => terminal.write(data, callback),
      resize: (cols, rows) => terminal.resize(cols, rows),
      dispose: () => { serialize.dispose(); terminal.dispose(); },
      serialize: () => serialize.serialize(),
    };
    const bridge = new TerminalBridge(roleId, pty, projection, audit, onDisposed, graceMs);
    pty.onData(data => bridge.output(new TextEncoder().encode(data)));
    pty.onExit(() => bridge.dispose('tmux_client_exit'));
    await audit.record({ roleId, action: 'terminal.bridge_open', result: 'succeeded' });
    return bridge;
  }

  add(socket: WebSocket, hello: Record<string, unknown>): void {
    if (this.disposed) throw new FleetError('stale_state', 'terminal bridge exited');
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    const viewer: Viewer = {
      socket, sessionLabel: randomUUID().slice(0, 8), resyncPending: false,
      tokens: 32 * 1024, tokenAt: Date.now(),
    };
    this.viewers.set(socket, viewer);
    const lastSeq = parseSeq(hello.lastSeq);
    const bridgeMatches = hello.bridgeId === this.id;
    const first = this.ring[0]?.seq ?? this.seq;
    if (bridgeMatches && lastSeq !== undefined && lastSeq >= first - 1n && lastSeq <= this.seq) {
      for (const frame of this.ring) if (frame.seq > lastSeq) socket.send(binaryFrame(frame));
    } else {
      socket.send(JSON.stringify({
        type: 'snapshot', atSeq: this.seq.toString(), encoding: 'utf8',
        data: this.projection.serialize(),
      }));
    }
    socket.send(JSON.stringify({
      type: 'ready', bridgeId: this.id, firstSeq: first.toString(), lastSeq: this.seq.toString(),
      mode: this.lease?.socket === socket ? 'controller' : 'viewer',
      leaseExpiresAt: this.lease ? new Date(this.lease.expiresAt).toISOString() : null,
    }));
    socket.on('message', (data, binary) => this.message(viewer, data, binary));
    socket.on('close', () => this.remove(socket));
    void this.audit.record({ roleId: this.roleId, action: 'terminal.viewer_open', result: 'succeeded' });
  }

  private output(bytes: Uint8Array): void {
    if (this.disposed || bytes.byteLength === 0) return;
    this.seq++;
    const frame = { seq: this.seq, bytes };
    this.ring.push(frame); this.ringBytes += bytes.byteLength;
    while (this.ring.length > RING_FRAMES || this.ringBytes > RING_BYTES) {
      this.ringBytes -= this.ring.shift()!.bytes.byteLength;
    }
    this.projection.write(bytes);
    const payload = binaryFrame(frame);
    for (const viewer of this.viewers.values()) {
      if (viewer.socket.bufferedAmount > 4 * 1024 * 1024) {
        viewer.socket.close(4408, 'slow consumer'); continue;
      }
      if (viewer.socket.bufferedAmount > 1024 * 1024) { viewer.resyncPending = true; continue; }
      if (viewer.resyncPending) {
        viewer.socket.send(JSON.stringify({ type: 'resync.required', reason: 'slow_consumer' }));
        viewer.resyncPending = false;
        continue;
      }
      viewer.socket.send(payload);
    }
  }

  private message(viewer: Viewer, data: import('ws').RawData, binary: boolean): void {
    try {
      if (binary) {
        const bytes = new Uint8Array(data as ArrayBuffer);
        if (bytes.byteLength < 9 || bytes[0] !== INPUT || bytes.byteLength - 9 > MAX_INPUT)
          throw new FleetError('invalid_request', 'invalid terminal input frame');
        if (!this.validLease(viewer.socket)) throw new FleetError('forbidden', 'writer lease required');
        const input = bytes.slice(9);
        if (!this.consume(viewer, input.byteLength))
          throw new FleetError('rate_limited', 'terminal input rate exceeded');
        this.pty.write(new TextDecoder().decode(input));
        this.renewLease();
        return;
      }
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === 'lease.request') this.requestLease(viewer);
      else if (message.type === 'lease.release') this.releaseLease(viewer.socket);
      else if (message.type === 'resize') this.resize(viewer, message);
      else throw new FleetError('invalid_request', 'unknown terminal control message');
    } catch (error) {
      const fleet = error instanceof FleetError ? error : new FleetError('invalid_request', (error as Error).message);
      viewer.socket.send(JSON.stringify({ type: 'error', code: fleet.code, message: fleet.message }));
      if (fleet.code === 'rate_limited') viewer.socket.close(4408, fleet.message);
    }
  }

  private requestLease(viewer: Viewer): void {
    const now = Date.now();
    if (this.lease && this.lease.expiresAt > now && this.lease.socket !== viewer.socket) {
      viewer.socket.send(JSON.stringify({
        type: 'error', code: 'lease_held',
        message: `controlled by viewer ${this.viewers.get(this.lease.socket)?.sessionLabel ?? 'unknown'}`,
      }));
      return;
    }
    this.lease = { socket: viewer.socket, id: randomUUID(), expiresAt: now + LEASE_MS };
    viewer.socket.send(JSON.stringify({
      type: 'lease.granted', leaseId: this.lease.id,
      leaseExpiresAt: new Date(this.lease.expiresAt).toISOString(),
    }));
    void this.audit.record({ roleId: this.roleId, action: 'terminal.lease_acquire', result: 'succeeded' });
  }

  private releaseLease(socket: WebSocket): void {
    if (this.lease?.socket !== socket) return;
    this.lease = undefined;
    socket.send(JSON.stringify({ type: 'lease.released' }));
    void this.audit.record({ roleId: this.roleId, action: 'terminal.lease_release', result: 'succeeded' });
  }

  private resize(viewer: Viewer, message: Record<string, unknown>): void {
    if (!this.validLease(viewer.socket) || message.leaseId !== this.lease?.id)
      throw new FleetError('forbidden', 'writer lease required');
    const cols = clamp(Number(message.cols), 80, 240);
    const rows = clamp(Number(message.rows), 24, 80);
    this.cols = cols; this.rows = rows;
    this.pty.resize(cols, rows); this.projection.resize(cols, rows); this.renewLease();
  }

  private validLease(socket: WebSocket): boolean {
    if (this.lease && this.lease.expiresAt <= Date.now()) this.lease = undefined;
    return this.lease?.socket === socket;
  }
  private renewLease(): void {
    if (this.lease) this.lease.expiresAt = Date.now() + LEASE_MS;
  }
  private consume(viewer: Viewer, amount: number): boolean {
    const now = Date.now();
    viewer.tokens = Math.min(32 * 1024, viewer.tokens + (now - viewer.tokenAt) * 16);
    viewer.tokenAt = now;
    if (amount > viewer.tokens) return false;
    viewer.tokens -= amount; return true;
  }
  private remove(socket: WebSocket): void {
    this.releaseLease(socket);
    this.viewers.delete(socket);
    void this.audit.record({ roleId: this.roleId, action: 'terminal.viewer_close', result: 'succeeded' });
    if (!this.viewers.size)
      this.cleanupTimer = setTimeout(() => this.dispose('idle_grace_expired'), this.graceMs);
  }
  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    for (const viewer of this.viewers.values()) {
      if (viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'terminal.exit', reason }));
        viewer.socket.close(1001, reason);
      }
    }
    this.viewers.clear();
    try { this.pty.kill(); } catch { /* already exited */ }
    this.projection.dispose();
    this.onDisposed();
    void this.audit.record({ roleId: this.roleId, action: 'terminal.bridge_close', result: reason });
  }
}

function binaryFrame(frame: Frame): Uint8Array {
  const payload = new Uint8Array(9 + frame.bytes.byteLength);
  payload[0] = OUTPUT;
  new DataView(payload.buffer).setBigUint64(1, frame.seq);
  payload.set(frame.bytes, 9);
  return payload;
}
function parseSeq(value: unknown): bigint | undefined {
  try { return value === undefined ? undefined : BigInt(String(value)); }
  catch { return undefined; }
}
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new FleetError('invalid_request', 'terminal size must be numeric');
  return Math.min(Math.max(Math.trunc(value), min), max);
}
