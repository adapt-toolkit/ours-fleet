/** Isolation backend selector. `auto` probes bubblewrap then podman; `none` disables wrapping. */
export type IsolationBackendId = 'auto' | 'bubblewrap' | 'podman' | 'none';
/** What to do when the requested backend is unavailable. */
export type OnUnavailable = 'warn' | 'strict';
/** Network posture inside the sandbox. */
export type NetworkMode = 'broker' | 'deny' | 'allow' | 'allowlist';

export const BACKENDS: IsolationBackendId[] = ['auto', 'bubblewrap', 'podman', 'none'];
export const ON_UNAVAILABLE: OnUnavailable[] = ['warn', 'strict'];
export const NETWORK_MODES: NetworkMode[] = ['broker', 'deny', 'allow', 'allowlist'];

export interface IsolationFs {
  /** Extra read-only bind mounts (host paths). */
  read?: string[];
  /** Extra read-write bind mounts (host paths). */
  write?: string[];
}

export interface IsolationResources {
  /** Cores, e.g. "1.5" → CPUQuota=150%. */
  cpu?: string;
  /** Memory, e.g. "2G" → MemoryMax=2G. */
  mem?: string;
  /** Max processes → TasksMax. */
  pids?: number;
}

/** Raw `isolation:` block as it appears in fleet.yaml (all fields optional). */
export interface IsolationConfig {
  backend?: IsolationBackendId;
  on_unavailable?: OnUnavailable;
  fs?: IsolationFs;
  network?: NetworkMode;
  allow_hosts?: string[];
  resources?: IsolationResources;
  secrets?: string[];
}

/** A single bind mount in the resolved sandbox. */
export interface Mount { src: string; dst: string; mode: 'ro' | 'rw' }

/**
 * Runtime facts the pure resolver needs to compute the durable mount set (§5.2):
 * the agent's state dir, its working dir, the fleet user's home, and (if the ours
 * broker exposes one) a unix-socket endpoint to bind in.
 */
export interface WrapContext {
  stateDir: string;
  runCwd: string;
  home: string;
  brokerEndpoint?: string;
}

/**
 * The validated, defaults-filled isolation policy consumed by a backend's wrap().
 * Pure output of resolveIsolation — no I/O, no backend probing.
 */
export interface ResolvedIsolation {
  backend: IsolationBackendId;
  onUnavailable: OnUnavailable;
  network: NetworkMode;
  allowHosts: string[];
  resources: IsolationResources;
  /** rw + ro bind mounts: durable set, fs.* extras, secrets. */
  mounts: Mount[];
  /** read-only system dirs exposed under the allowlist model (/usr, /bin, …). */
  system: string[];
  /** ephemeral scratch tmpfs mounts (/tmp, ~/.cache). */
  tmpfs: string[];
  /** sensitive host paths guaranteed absent from the sandbox (observability). */
  blocklist: string[];
}

/** A pluggable isolation backend (bubblewrap, podman, none). */
export interface IsolationBackend {
  id: 'bubblewrap' | 'podman' | 'none';
  /** Probe host support; feeds `doctor` and `auto` selection. */
  available(): Promise<{ ok: boolean; detail: string }>;
  /** Wrap the agent argv into a sandbox-launcher argv given the resolved policy. */
  wrap(argv: string[], policy: ResolvedIsolation, ctx: WrapContext): string[];
}
