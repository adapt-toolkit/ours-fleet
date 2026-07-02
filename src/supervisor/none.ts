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
      await tmux.kill(name);
      await tmux.newSession(name, process.cwd(), `${shq(binPath)} _run ${shq(name)}`);
    },
    async start(name) { throw new Error(`'${name}' has no unit under the none backend — use install/spawn`); },
    async stop(name) { await tmux.kill(name); },
    async restart(name) { throw new Error(`restart unsupported under the none backend — stop + install '${name}'`); },
    async status(name) { return (await tmux.has(name)) ? `tmux session '${name}' running` : `'${name}' not running`; },
    async uninstall(name) { await tmux.kill(name); },
    logsArgs(name) { return { cmd: 'tmux', args: ['capture-pane', '-t', name, '-p'] }; },
  };
}
