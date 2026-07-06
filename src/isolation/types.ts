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
