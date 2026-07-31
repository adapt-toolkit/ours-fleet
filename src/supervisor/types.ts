/**
 * Typed liveness verdict. `stopped` is a *definite* stop — the only state that
 * lets a caller discard session context. `unknown` means the probe itself did
 * not answer (bus unreachable, missing binary, unrecognised state) and must be
 * treated as "may still be running".
 */
export type LivenessState = 'running' | 'stopped' | 'unknown';

export interface Liveness {
  state: LivenessState;
  /** The backend's own words: native state tokens, or the probe failure. */
  detail: string;
}

/** Whether `install` had to create the registration, or found it already there. */
export interface InstallOutcome { created: boolean; detail: string }
export interface UninstallOutcome { removed: boolean; detail: string }
export interface SupervisorInspection extends Liveness {
  backend: 'systemd' | 'launchd' | 'none';
  nativeState?: string;
}

export interface SupervisorBackend {
  id: 'systemd' | 'launchd' | 'none';
  /** One-time host setup (unit template / dirs / linger). Returns human-readable messages. */
  init(binPath: string): Promise<string[]>;
  /**
   * Ensure the role's unit exists and is enabled + started. Idempotent, and
   * EXPLICIT about whether it created the registration: rollback may only
   * remove what this transaction made, so "did I create this?" has to be
   * answerable rather than assumed (6.2).
   */
  install(name: string, binPath: string): Promise<InstallOutcome>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  status(name: string): Promise<string>;
  /**
   * Classify the role's liveness from the backend's own native result — never
   * by matching prose in `status()`. Implementations must not throw: a failed
   * probe is `unknown` with the failure in `detail`.
   */
  liveness(name: string): Promise<Liveness>;
  /** Structured machine-derived status for application-service consumers. */
  inspect?(name: string): Promise<SupervisorInspection>;
  /** Remove the registration. Idempotent; reports whether anything was there. */
  uninstall(name: string): Promise<UninstallOutcome>;
  /** Command the CLI execs (stdio inherited) to show logs. */
  logsArgs(name: string, follow: boolean): { cmd: string; args: string[] };
}
