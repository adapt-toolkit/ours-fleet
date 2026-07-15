#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const run = (command, args, { optional = false } = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    if (optional) return false;
    const detail = result.error?.message ?? `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed (${detail})`);
  }
  return true;
};

try {
  if (!run('codex', ['--version'], { optional: true }))
    throw new Error('Codex CLI is not installed or not on PATH');

  console.log('Installing ours-fleet CLI and the ours Codex runtime...');
  run('npm', ['install', '--global', '@ours.network/fleet', '@ours.network/codex']);
  run('ours-codex-install', []);

  console.log('Installing the ours-fleet native Codex plugin...');
  if (!run('codex', ['plugin', 'marketplace', 'add', 'adapt-toolkit/ours-codex-marketplace'], { optional: true }))
    run('codex', ['plugin', 'marketplace', 'upgrade', 'ours-codex-marketplace']);
  run('codex', ['plugin', 'add', 'ours-fleet@ours-codex-marketplace']);

  console.log('ours-fleet Codex support installed. Start a new Codex session, then ask: "spawn an ours agent".');
} catch (error) {
  console.error(`ours-fleet-codex-install: ${error.message}`);
  process.exitCode = 1;
}
