/** Where each configured definition came from, compared with the packaged presets.
 * A definition is `predefined` when it has the same value as the shipped preset of
 * the same name, `changed` when a preset of that name exists but the value differs,
 * and `custom` otherwise. Values are compared after parsing, so the formatting the
 * configuration editor writes does not count as a change. Preset text is returned
 * so users can see exactly what ships; it contains no host data.
 */
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parse } from 'yaml';
import { defaultConfigPath } from '../paths.js';
import { splitRootFor } from '../config.js';
import { packagedPresetRoot } from '../preset-bootstrap.js';

export const PROVENANCE_KINDS = { role: 'roles', brain: 'brains', template: 'agent_templates', layout: 'room_layouts' } as const;
export type ProvenanceKind = keyof typeof PROVENANCE_KINDS;
export type ProvenanceStatus = 'predefined' | 'changed' | 'custom';
export interface ProvenanceEntry { status: ProvenanceStatus; preset?: string }
export type Provenance = Record<ProvenanceKind, Record<string, ProvenanceEntry>>;

const MAX_BYTES = 256 * 1024;

/** Regular, bounded YAML files of one directory, by definition name. Anything else is skipped. */
function yamlFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return files;
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    const path = join(dir, file), stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    files.set(basename(file, extname(file)), readFileSync(path, 'utf8'));
  }
  return files;
}

const parsed = (text: string): unknown => { try { return parse(text); } catch { return Symbol('unparseable'); } };

export class PresetProvenance {
  constructor(private configPath?: string, private presetRoot = join(packagedPresetRoot(), 'fleet')) {}

  read(): Provenance {
    const split = splitRootFor(this.configPath ?? defaultConfigPath());
    const result = {} as Provenance;
    for (const [kind, dir] of Object.entries(PROVENANCE_KINDS) as Array<[ProvenanceKind, string]>) {
      const presets = yamlFiles(join(this.presetRoot, dir)), installed = yamlFiles(join(split, dir));
      result[kind] = Object.fromEntries([...installed].map(([name, text]) => {
        const preset = presets.get(name);
        if (preset === undefined) return [name, { status: 'custom' }];
        return [name, { status: isDeepStrictEqual(parsed(text), parsed(preset)) ? 'predefined' : 'changed', preset }];
      }));
    }
    return result;
  }
}
