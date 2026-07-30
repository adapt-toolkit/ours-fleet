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

export interface SupervisorBackend {
  id: 'systemd' | 'launchd' | 'none';
  /** One-time host setup (unit template / dirs / linger). Returns human-readable messages. */
  init(binPath: string): Promise<string[]>;
  /** Ensure the role's unit exists and is enabled + started. */
  install(name: string, binPath: string): Promise<void>;
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
  uninstall(name: string): Promise<void>;
  /** Command the CLI execs (stdio inherited) to show logs. */
  logsArgs(name: string, follow: boolean): { cmd: string; args: string[] };
}
