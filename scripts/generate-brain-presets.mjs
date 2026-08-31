import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(readFileSync(join(root, 'presets/brain-catalog.json'), 'utf8'));
if (catalog.schema_version !== 1 || !Number.isInteger(catalog.catalog_revision))
  throw new Error('unsupported Brain catalog manifest');
const directory = join(root, 'presets/fleet/brains');
const idFor = ({ harness, model }, effort) => `${harness === 'claude-code' ? 'claude' : 'codex'}-${model
  .replace(/^claude-/, '').replace(/\./g, '-').toLowerCase()}-${effort}`;
const expected = new Map();
const entries = new Set();
for (const entry of catalog.models) {
  const entryKey = JSON.stringify([entry.harness, entry.session, entry.model]);
  if (entries.has(entryKey)) throw new Error(`duplicate Brain catalog entry: ${entry.harness}/${entry.session}/${entry.model}`);
  entries.add(entryKey);
  for (const effort of entry.efforts) {
    const id = idFor(entry, effort);
    const filename = `${id}.yaml`;
    if (expected.has(filename)) throw new Error(`duplicate derived Brain preset id: ${id}`);
    const body = [`# Generated from presets/brain-catalog.json revision ${catalog.catalog_revision}.`,
      `harness: ${entry.harness}`, `session: ${entry.session}`, `model: ${entry.model}`, `effort: ${effort}`, ''].join('\n');
    expected.set(filename, body);
  }
}
const generated = readdirSync(directory).filter(name =>
  /^(codex|claude)-.*\.yaml$/.test(name) && name !== 'claude-default.yaml');
if (process.argv.includes('--check')) {
  const wrong = [...new Set([...generated, ...expected.keys()])].filter(name =>
    !expected.has(name) || !generated.includes(name)
    || readFileSync(join(directory, name), 'utf8') !== expected.get(name));
  if (wrong.length) throw new Error(`generated Brain presets are stale: ${wrong.join(', ')}`);
} else {
  for (const name of generated) unlinkSync(join(directory, name));
  for (const [name, body] of expected) writeFileSync(join(directory, name), body);
}
