import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { replaceFileAtomically } from './atomic-file.js';
import { realExec, type Exec } from './exec.js';
import { stateRoot } from './paths.js';
import type { WorkspacePayload } from './workspace-enrollment.js';

const UNCHANGED = 'Nothing was changed and this host was not bound.';

/**
 * Check what the steps after the one-time root proof depend on, before that
 * proof is sent: a failure afterwards cannot be retried with a fresh command.
 */
export async function setupTunnelPreflight(
  { exec = realExec, platform = process.platform, node = process.versions.node }: { exec?: Exec; platform?: NodeJS.Platform; node?: string } = {},
): Promise<void> {
  const [major, minor] = node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13))
    throw Error(`Tunnel setup requires Node.js 22.13 or newer; this is ${node}. Update Node.js, then run a fresh tunnel setup command. ${UNCHANGED}`);
  if (platform === 'linux') {
    const manager = await exec('systemctl', ['--user', 'show-environment'], { timeout: 10_000 });
    if (manager.code !== 0)
      throw Error(`The user service manager is not reachable from this shell (${manager.stderr.trim().split('\n')[0] || `systemctl --user exited ${manager.code}`}). `
        + `Log in directly as ${userInfo().username} (not through su or sudo), or run: sudo loginctl enable-linger ${userInfo().username} && export XDG_RUNTIME_DIR=/run/user/${process.getuid?.()} `
        + `Then run a fresh tunnel setup command. ${UNCHANGED}`);
  }
  const help = await exec('cloudflared', ['tunnel', 'run', '--help'], { timeout: 10_000 });
  if (help.code === 127) throw Error(`cloudflared is not installed or not on PATH. Install it, then run a fresh tunnel setup command. ${UNCHANGED}`);
  if (help.code !== 0 || !`${help.stdout}\n${help.stderr}`.includes('--token-file'))
    throw Error(`This cloudflared is too old for tunnel setup (no --token-file support). Update cloudflared, then run a fresh tunnel setup command. ${UNCHANGED}`);
}

/** What the steps after the proof need, kept so they can be finished without a new command. */
export interface PendingTunnelSetup {
  appOrigin: string; origin: string; hostWorkspaceId: string; rootCid: string;
  challenge: WorkspacePayload['challenge'];
  /** Fleet configuration the setup started with; a resume must use the same one. */
  configuration: string;
  /** Port last sent to the account as the tunnel target. Its answer may have been lost, so the remote target is this port or the default. */
  attemptedPort?: number;
}
const pendingPath = (): string => join(stateRoot(), 'workspace', 'pending-setup.json');

export function savePendingTunnelSetup(pending: PendingTunnelSetup): void {
  replaceFileAtomically(pendingPath(), JSON.stringify(pending) + '\n', 0o600);
}
export function clearPendingTunnelSetup(): void { rmSync(pendingPath(), { force: true }); }
export function readPendingTunnelSetup(): PendingTunnelSetup {
  const path = pendingPath();
  if (!existsSync(path)) throw Error('No unfinished tunnel setup on this host. Run the tunnel setup command from the App.');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw Error('Unfinished tunnel setup record must be an owned private file');
  const pending = JSON.parse(readFileSync(path, 'utf8')) as PendingTunnelSetup;
  if (typeof pending?.appOrigin !== 'string' || typeof pending.origin !== 'string' || typeof pending.hostWorkspaceId !== 'string'
    || typeof pending.rootCid !== 'string' || !pending.challenge || !Number.isSafeInteger(pending.challenge.expiresAt) || typeof pending.configuration !== 'string'
    || (pending.attemptedPort !== undefined && !Number.isInteger(pending.attemptedPort))) throw Error('Unfinished tunnel setup record is invalid');
  return pending;
}

export const DEFAULT_TUNNEL_PORT = 49_271;
/**
 * The port the web service must bind when the account can no longer retarget
 * the tunnel. Unknown when a different port was requested and never confirmed.
 */
export function requiredPortAfterExpiry(pending: PendingTunnelSetup): number {
  if (pending.attemptedPort === undefined || pending.attemptedPort === DEFAULT_TUNNEL_PORT) return DEFAULT_TUNNEL_PORT;
  throw Error(`The setup window has expired and it is unknown whether the tunnel points at port ${pending.attemptedPort} or ${DEFAULT_TUNNEL_PORT}: the account's answer to the last port request was not received. This setup cannot be finished automatically`);
}
