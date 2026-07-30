import { Tmux } from '../tmux.js';
import { realExec, shq, type Exec } from '../exec.js';
import type { SupervisorBackend } from './types.js';

/**
 * No supervision: sessions are plain tmux, nothing survives a reboot and
 * nothing restarts on crash. Used for temp agents and CI tests
 * (OURS_FLEET_SUPERVISOR=none).
 */
export function makeNoneBackend(exec: Exec = realExec): SupervisorBackend {
  const tmux = new Tmux(exec);
  return {
    id: 'none',
    async init() { return ['no supervisor: sessions are plain tmux (no reboot survival)']; },
    async install(name, binPath) {
      const existed = await tmux.kill(name);        // true when a session was there
      await tmux.newSession(name, process.cwd(), `${shq(binPath)} _run ${shq(name)}`);
      return existed
        ? { created: false, detail: `replaced the existing tmux session '${name}'` }
        : { created: true, detail: `created tmux session '${name}'` };
    },
    async start(name) { throw new Error(`'${name}' has no unit under the none backend — use install/spawn`); },
    async stop(name) { await tmux.kill(name); },
    async restart(name) { throw new Error(`restart unsupported under the none backend — stop + install '${name}'`); },
    async status(name) { return (await tmux.has(name)) ? `tmux session '${name}' running` : `'${name}' not running`; },
    async liveness(name) {
      // Report the tmux probe directly: 0 = session exists, 1 = it does not.
      // Any other code (127 = no tmux binary) is a failed probe, not a stop.
      const r = await exec('tmux', ['has-session', '-t', name]);
      if (r.code === 0) return { state: 'running', detail: `tmux session '${name}' exists` };
      if (r.code === 1) return { state: 'stopped', detail: `no tmux session '${name}'` };
      return { state: 'unknown', detail: `tmux has-session '${name}' failed (${r.code}): ${r.stderr.trim() || 'no output'}` };
    },
    async uninstall(name) {
      const killed = await tmux.kill(name);         // idempotent
      return killed
        ? { removed: true, detail: `killed tmux session '${name}'` }
        : { removed: false, detail: `no tmux session '${name}'` };
    },
    logsArgs(name) { return { cmd: 'tmux', args: ['capture-pane', '-t', name, '-p'] }; },
  };
}
