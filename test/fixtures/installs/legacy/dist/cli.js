#!/usr/bin/env node
// Stub of a pre-provenance ours-fleet 0.16.0 build (see ../../README.md).
// Knows only --version and `config <file>`; `monitor.interrupt: after_tool`
// does not exist yet, so it is rejected with the message that build printed.
import { readFileSync } from 'node:fs';

const [cmd, arg] = process.argv.slice(2);

if (cmd === '--version' || cmd === '-V') {
  process.stdout.write('0.16.0\n');
  process.exit(0);
}
if (cmd === 'config') {
  const text = readFileSync(arg, 'utf8');
  if (/interrupt:\s*after_tool/.test(text)) {
    process.stderr.write("monitor.interrupt: must be true or false\n");
    process.exit(1);
  }
  process.stdout.write('ok\n');
  process.exit(0);
}
process.stderr.write(`error: unknown command '${cmd}'\n`);
process.exit(1);
