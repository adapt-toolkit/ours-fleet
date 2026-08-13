#!/usr/bin/env node
// Stub of an ours-fleet build cut AFTER after-tool interruption landed but
// BEFORE the version bump — same 0.16.0 semver, different capabilities.
// See ../../README.md.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const buildInfo = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'build-info.json'), 'utf8'));
const [cmd, arg] = process.argv.slice(2);

if (cmd === '--version' || cmd === '-V') {
  process.stdout.write(`${buildInfo.version}\n`);
  process.exit(0);
}
if (cmd === 'version') {
  process.stdout.write(arg === '--json'
    ? `${JSON.stringify(buildInfo)}\n`
    : `${buildInfo.version}+${buildInfo.buildId}\n`);
  process.exit(0);
}
if (cmd === 'config') {
  const text = readFileSync(arg, 'utf8');
  if (/interrupt:\s*after_tool/.test(text)
      && !buildInfo.capabilities.includes('monitor.interrupt.after_tool')) {
    process.stderr.write("monitor.interrupt: must be true or false\n");
    process.exit(1);
  }
  process.stdout.write('ok\n');
  process.exit(0);
}
process.stderr.write(`error: unknown command '${cmd}'\n`);
process.exit(1);
