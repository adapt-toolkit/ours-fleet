import type { AcpMcpServer } from '../harness/types.js';
import type {
  AcpBodyBrainProvider, AcpBodyBrainNotification, AcpCommandResult, AcpGenerationRequest,
  AcpLifecycleResult, AcpPermissionRequest, AcpRestoreRequest, AcpStartRequest, AcpSubmitRequest,
} from './acp-body-brain-transport.js';

const MAX_ARGV = 64;
const MAX_VALUE_BYTES = 4096;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/u;

export interface AcpBodyBrainLaunchTranslation {
  readonly model: string;
  readonly effort: string;
  readonly modeId?: string;
  readonly mcpServers?: readonly AcpMcpServer[];
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  readonly permissionMetadataSource?: 'codex-acp';
}

export interface AcpBodyBrainPreparedLaunch {
  readonly schemaVersion: 1;
  readonly adapterId: 'codex-acp' | 'claude-code-acp';
  readonly adapterVersion: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly translation: Readonly<AcpBodyBrainLaunchTranslation>;
}

export interface AcpBodyBrainDriverLaunchRequest {
  readonly launch: Readonly<AcpBodyBrainPreparedLaunch>;
  readonly lifecycle: Readonly<AcpStartRequest | AcpRestoreRequest>;
}

/** Narrow process-free seam implemented by an ACP protocol owner. */
export interface AcpBodyBrainInjectedDriver {
  subscribe(listener: (notification: unknown) => void): () => void;
  start(request: Readonly<AcpBodyBrainDriverLaunchRequest>): Promise<AcpLifecycleResult>;
  restore(request: Readonly<AcpBodyBrainDriverLaunchRequest>): Promise<AcpLifecycleResult>;
  submit(request: Readonly<Omit<AcpSubmitRequest, 'body'>>, body: Uint8Array): Promise<AcpCommandResult>;
  respondPermission(request: Readonly<AcpPermissionRequest>): Promise<AcpCommandResult>;
  cancel(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult>;
  forceTerminate(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult>;
  close(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult>;
  retire(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult>;
  cleanup(): Promise<void>;
}

/** Stable dependency-boundary error; never carries provider text or a cause. */
export class AcpBodyBrainProviderError extends Error {
  constructor() { super('ACP BodyBrain provider dependency is unavailable'); this.name = 'AcpBodyBrainProviderError'; }
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && !descriptor.get && !descriptor.set;
  });
}

function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_VALUE_BYTES
    && !/[\0\r\n]/u.test(value);
}

function cloneJson(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new TypeError('ACP launch data is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES || /\0/u.test(value))
      throw new TypeError('ACP launch data contains an invalid string');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 256) throw new TypeError('ACP launch data array is too large');
    return Object.freeze(value.map(child => cloneJson(child, depth + 1)));
  }
  if (!plain(value) || Object.keys(value).length > 256)
    throw new TypeError('ACP launch data must contain plain bounded JSON');
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (!bounded(key)) throw new TypeError('ACP launch data contains an invalid key');
    result[key] = cloneJson(value[key], depth + 1);
  }
  return Object.freeze(result);
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

/** Validate, own and deeply freeze a launch/translation snapshot before any driver sees it. */
export function createAcpBodyBrainPreparedLaunch(raw: AcpBodyBrainPreparedLaunch): Readonly<AcpBodyBrainPreparedLaunch> {
  if (!plain(raw) || !exact(raw, ['schemaVersion', 'adapterId', 'adapterVersion', 'argv', 'env', 'translation'])
      || raw.schemaVersion !== 1 || !['codex-acp', 'claude-code-acp'].includes(raw.adapterId)
      || !bounded(raw.adapterVersion) || !TOKEN.test(raw.adapterVersion)
      || !Array.isArray(raw.argv) || raw.argv.length < 1 || raw.argv.length > MAX_ARGV
      || !raw.argv.every(bounded) || !plain(raw.env) || Object.keys(raw.env).length > 256
      || !Object.entries(raw.env).every(([key, value]) => bounded(key) && bounded(value))
      || !plain(raw.translation) || !exact(raw.translation, ['model', 'effort'], [
        'modeId', 'mcpServers', 'sessionMeta', 'permissionMetadataSource',
      ]) || !bounded(raw.translation.model) || !bounded(raw.translation.effort)
      || (raw.adapterId === 'codex-acp'
        ? !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(raw.translation.effort)
        : !['low', 'medium', 'high', 'xhigh', 'max'].includes(raw.translation.effort))
      || (raw.translation.modeId !== undefined && !bounded(raw.translation.modeId))
      || (raw.translation.permissionMetadataSource !== undefined
        && raw.translation.permissionMetadataSource !== 'codex-acp')
      || (raw.translation.mcpServers !== undefined && !Array.isArray(raw.translation.mcpServers))
      || (raw.translation.sessionMeta !== undefined && !plain(raw.translation.sessionMeta)))
    throw new TypeError('invalid ACP BodyBrain prepared launch');
  const env = Object.freeze(Object.fromEntries(Object.keys(raw.env).sort().map(key => [key, raw.env[key]!])));
  const translation = cloneJson(raw.translation) as Readonly<AcpBodyBrainLaunchTranslation>;
  return Object.freeze({
    schemaVersion: 1, adapterId: raw.adapterId, adapterVersion: raw.adapterVersion,
    argv: Object.freeze([...raw.argv]), env, translation,
  });
}

const unavailableLifecycle = (): AcpLifecycleResult => ({ state: 'failed', code: 'adapter_unavailable' });
const unavailableCommand = (): AcpCommandResult => ({ state: 'failed', code: 'adapter_unavailable' });

/**
 * One-listener, one-cleanup ownership bridge. It performs no I/O itself: all
 * protocol work belongs to the injected driver and every dependency exception
 * is reduced to a closed typed result.
 */
export class AcpBodyBrainInjectedProvider implements AcpBodyBrainProvider {
  private listener?: (notification: unknown) => void;
  private unsubscribe?: () => void;
  private state: 'new' | 'launching' | 'active' | 'closed' = 'new';
  private cleanupPromise?: Promise<void>;
  private generation?: string;
  readonly launch: Readonly<AcpBodyBrainPreparedLaunch>;

  private isClosed(): boolean { return this.state === 'closed'; }

  constructor(launch: AcpBodyBrainPreparedLaunch, private readonly driver: AcpBodyBrainInjectedDriver) {
    this.launch = createAcpBodyBrainPreparedLaunch(launch);
    let valid = false;
    try {
      valid = !!driver && typeof driver.subscribe === 'function' && typeof driver.start === 'function'
        && typeof driver.restore === 'function' && typeof driver.submit === 'function'
        && typeof driver.respondPermission === 'function' && typeof driver.cancel === 'function'
        && typeof driver.forceTerminate === 'function' && typeof driver.close === 'function'
        && typeof driver.retire === 'function' && typeof driver.cleanup === 'function';
    } catch { /* accessor-bearing dependency is invalid and redacted below */ }
    if (!valid) throw new AcpBodyBrainProviderError();
  }

  subscribe(listener: (notification: unknown) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (this.state === 'closed' || this.listener) throw new TypeError('ACP BodyBrain listener unavailable');
    let owned = true;
    this.listener = listener;
    try {
      const unsubscribe = this.driver.subscribe(value => {
        if (owned && this.state !== 'closed' && this.listener === listener) listener(value);
      });
      if (typeof unsubscribe !== 'function') throw new TypeError('driver subscription has no owner');
      this.unsubscribe = unsubscribe;
    } catch {
      owned = false; this.listener = undefined; this.unsubscribe = undefined; this.state = 'closed';
      throw new AcpBodyBrainProviderError();
    }
    return () => {
      if (!owned) return;
      owned = false; this.listener = undefined;
      const unsubscribe = this.unsubscribe; this.unsubscribe = undefined;
      try { unsubscribe?.(); } catch { /* delivery is already fenced */ }
    };
  }

  start(request: Readonly<AcpStartRequest>): Promise<AcpLifecycleResult> {
    return this.launchSession('start', request);
  }
  restore(request: Readonly<AcpRestoreRequest>): Promise<AcpLifecycleResult> {
    return this.launchSession('restore', request);
  }
  private async launchSession(
    operation: 'start' | 'restore', request: Readonly<AcpStartRequest | AcpRestoreRequest>,
  ): Promise<AcpLifecycleResult> {
    if (this.state === 'closed') return { state: 'failed', code: 'closed' };
    if (this.state !== 'new') return { state: 'failed', code: 'already_started' };
    if (!this.listener) return { state: 'failed', code: 'listener_required' };
    this.state = 'launching'; this.generation = request.generation;
    const owned = Object.freeze({ launch: this.launch, lifecycle: cloneJson(request) as Readonly<AcpStartRequest | AcpRestoreRequest> });
    try {
      const result = await this.driver[operation](owned);
      if (this.isClosed()) return { state: 'failed', code: 'closed' };
      if (result?.state === 'accepted') { this.state = 'active'; return result; }
      await this.cleanup();
      return result?.state === 'failed' ? result : unavailableLifecycle();
    } catch { await this.cleanup(); return unavailableLifecycle(); }
  }

  submit(request: Readonly<Omit<AcpSubmitRequest, 'body'>>, body: Uint8Array): Promise<AcpCommandResult> {
    return this.command(request.generation, () => this.driver.submit(Object.freeze(cloneJson(request)) as typeof request, body));
  }
  respondPermission(request: Readonly<AcpPermissionRequest>): Promise<AcpCommandResult> {
    return this.command(request.generation,
      () => this.driver.respondPermission(Object.freeze(cloneJson(request)) as Readonly<AcpPermissionRequest>));
  }
  cancel(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult> { return this.control('cancel', request); }
  forceTerminate(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult> { return this.control('forceTerminate', request); }
  close(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult> { return this.control('close', request); }
  retire(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult> { return this.control('retire', request); }
  private control(
    operation: 'cancel' | 'forceTerminate' | 'close' | 'retire', request: Readonly<AcpGenerationRequest>,
  ): Promise<AcpCommandResult> {
    return this.command(request.generation,
      () => this.driver[operation](Object.freeze(cloneJson(request)) as Readonly<AcpGenerationRequest>));
  }
  private async command(generation: string, invoke: () => Promise<AcpCommandResult>): Promise<AcpCommandResult> {
    if (this.state === 'closed') return { state: 'failed', code: 'closed' };
    if (this.state !== 'active') return { state: 'failed', code: 'invalid_request' };
    if (generation !== this.generation) return { state: 'failed', code: 'generation_changed' };
    try {
      const result = await invoke();
      if (this.isClosed()) return { state: 'failed', code: 'closed' };
      return result?.state === 'accepted' || result?.state === 'failed' ? result : unavailableCommand();
    } catch { return unavailableCommand(); }
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.state = 'closed'; this.listener = undefined;
    const unsubscribe = this.unsubscribe; this.unsubscribe = undefined;
    this.cleanupPromise = (async () => {
      try { unsubscribe?.(); } catch { /* delivery is already fenced */ }
      try { await this.driver.cleanup(); } catch { /* cleanup is best-effort and redacted */ }
    })();
    return this.cleanupPromise;
  }
}

export const createAcpBodyBrainInjectedProvider = (
  launch: AcpBodyBrainPreparedLaunch, driver: AcpBodyBrainInjectedDriver,
): AcpBodyBrainProvider => new AcpBodyBrainInjectedProvider(launch, driver);

// Keep the notification type part of this bridge's public compile-time seam.
export type AcpBodyBrainInjectedNotification = AcpBodyBrainNotification;
