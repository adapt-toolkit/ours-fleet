import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { home, logsRoot } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { SupervisorBackend } from './types.js';

export const labelFor = (name: string) => `network.ours.fleet.${name}`;
const agentsDir = () => join(home(), 'Library', 'LaunchAgents');
const plistPath = (name: string) => join(agentsDir(), `${labelFor(name)}.plist`);

function plist(name: string, binPath: string): string {
  const log = join(logsRoot(), `${name}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${labelFor(name)}</string>
  <key>ProgramArguments</key>
  <array><string>${binPath}</string><string>_run</string><string>${name}</string></array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

export function makeLaunchdBackend(exec: Exec = realExec, uid: number = process.getuid?.() ?? 501): SupervisorBackend {
  const domain = `gui/${uid}`;
  return {
    id: 'launchd',

    async init() {
      mkdirSync(agentsDir(), { recursive: true });
      mkdirSync(logsRoot(), { recursive: true });
      return [
        `LaunchAgents dir ready: ${agentsDir()}`,
        'note: launchd agents start at login (macOS has no linger equivalent)',
      ];
    },

    async install(name, binPath) {
      mkdirSync(agentsDir(), { recursive: true });
      mkdirSync(logsRoot(), { recursive: true });
      writeFileSync(plistPath(name), plist(name, binPath));
      await exec('launchctl', ['bootout', `${domain}/${labelFor(name)}`]); // best-effort refresh
      const r = await exec('launchctl', ['bootstrap', domain, plistPath(name)]);
      if (r.code !== 0) throw new Error(`launchctl bootstrap ${labelFor(name)} failed: ${r.stderr.trim()}`);
    },
    async start(name) {
      const r = await exec('launchctl', ['bootstrap', domain, plistPath(name)]);
      if (r.code !== 0) await exec('launchctl', ['kickstart', `${domain}/${labelFor(name)}`]);
    },
    async stop(name) {
      const r = await exec('launchctl', ['bootout', `${domain}/${labelFor(name)}`]);
      if (r.code !== 0) throw new Error(`launchctl bootout ${labelFor(name)} failed: ${r.stderr.trim()}`);
    },
    async restart(name) {
      const r = await exec('launchctl', ['kickstart', '-k', `${domain}/${labelFor(name)}`]);
      if (r.code !== 0) throw new Error(`launchctl kickstart ${labelFor(name)} failed: ${r.stderr.trim()}`);
    },
    async status(name) {
      const r = await exec('launchctl', ['print', `${domain}/${labelFor(name)}`]);
      if (r.code !== 0) return `not loaded (${labelFor(name)})`;
      return r.stdout.split('\n').slice(0, 12).join('\n');
    },
    async uninstall(name) {
      await exec('launchctl', ['bootout', `${domain}/${labelFor(name)}`]);
      rmSync(plistPath(name), { force: true });
    },
    logsArgs(name, follow) {
      const log = join(logsRoot(), `${name}.log`);
      return { cmd: 'tail', args: follow ? ['-f', log] : ['-n', '200', log] };
    },
  };
}
