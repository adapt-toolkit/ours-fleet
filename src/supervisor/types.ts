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
  uninstall(name: string): Promise<void>;
  /** Command the CLI execs (stdio inherited) to show logs. */
  logsArgs(name: string, follow: boolean): { cmd: string; args: string[] };
}
