import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { home } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { SupervisorBackend } from './types.js';

export const UNIT_TEMPLATE = 'ours-fleet-agent@.service';
export const unitFor = (name: string) => `ours-fleet-agent@${name}.service`;

export function makeSystemdBackend(exec: Exec = realExec): SupervisorBackend {
  const ctl = (...args: string[]) => exec('systemctl', ['--user', ...args]);
  return {
    id: 'systemd',

    async init(binPath: string) {
      const msgs: string[] = [];
      const unitDir = join(home(), '.config', 'systemd', 'user');
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, UNIT_TEMPLATE), `[Unit]
Description=ours-fleet agent %i
After=default.target

[Service]
Type=simple
ExecStart=${binPath} _run %i
Restart=always
RestartSec=2
TimeoutStopSec=15

[Install]
WantedBy=default.target
`);
      msgs.push(`installed ${join(unitDir, UNIT_TEMPLATE)}`);
      await ctl('daemon-reload');
      const linger = await exec('loginctl', ['enable-linger', userInfo().username]);
      msgs.push(linger.code === 0
        ? 'linger enabled (roles survive logout + reboot)'
        : `warning: could not enable linger (${linger.stderr.trim() || 'permission'}) — run: sudo loginctl enable-linger ${userInfo().username}`);
      return msgs;
    },

    async install(name) {
      const r = await ctl('enable', '--now', unitFor(name));
      if (r.code !== 0) throw new Error(`systemctl enable --now ${unitFor(name)} failed: ${r.stderr.trim()}`);
    },
    async start(name) { await ctl('start', unitFor(name)); },
    async stop(name) {
      const r = await ctl('stop', unitFor(name));
      if (r.code !== 0) throw new Error(`systemctl stop ${unitFor(name)} failed: ${r.stderr.trim()}`);
    },
    async restart(name) {
      const r = await ctl('restart', unitFor(name));
      if (r.code !== 0) throw new Error(`systemctl restart ${unitFor(name)} failed: ${r.stderr.trim()}`);
    },
    async status(name) {
      const r = await ctl('status', unitFor(name), '--no-pager');
      return r.stdout || r.stderr;
    },
    async uninstall(name) { await ctl('disable', '--now', unitFor(name)); },
    logsArgs(name, follow) {
      return { cmd: 'journalctl', args: ['--user', '-u', unitFor(name), ...(follow ? ['-f'] : ['-n', '200'])] };
    },
  };
}
