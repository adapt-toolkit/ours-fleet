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

// Floors match src/security-versions.ts; refuse before any command, network access or write.
const floors = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const node = process.versions.node, parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(node)?.slice(1).map(Number), floor = parsed && floors[parsed[0]];
if (!floor || parsed[1] < floor[0] || (parsed[1] === floor[0] && parsed[2] < floor[1])) {
  console.error(`ours-fleet-codex-install: Node.js ${/^[0-9A-Za-z.+-]{1,64}$/.test(node) ? node : 'unrecognized'} is not permitted. Ours requires a patched supported Node.js release: 22.23.4+, 24.22.1+, 26.12.1+ within those release lines; prerelease, end-of-life and unreviewed release lines are refused. Earlier patch levels are affected by CVE-2026-111497 (Brotli decompression out-of-bounds write): https://nodejs.org/en/blog/vulnerability/october-2026-security-releases Update Node.js from https://nodejs.org/en/download or your package manager, then retry.`);
  process.exit(1);
}

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
