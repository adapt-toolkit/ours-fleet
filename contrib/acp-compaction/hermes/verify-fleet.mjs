#!/usr/bin/env node
// Read-only artifact inspection. Never starts an ACP session or imports Hermes runtime configuration.
import { inspectHermesCompatibility } from '../../../dist/harness/hermes-compatibility.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const target = process.argv[2];
if (!target || process.argv.length !== 3) throw new Error('Usage: node verify-fleet.mjs TARGET');
const home = mkdtempSync(join(tmpdir(), 'fleet-hermes-verify-'));
try {
  const report = await inspectHermesCompatibility({
    argv: [join(resolve(target), 'bin/hermes-acp')],
    env: { PATH: process.env.PATH ?? '', HOME: home, HERMES_HOME: home }, home,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(home, { recursive: true, force: true });
}
