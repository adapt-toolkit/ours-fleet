/** Web authoring of `fleet/room_layouts/<name>.yaml`.
 * Writes are revision-guarded (sha256 of the file bytes) and validated with the
 * same parser the CLI uses. Retained layout runs keep their own snapshots, so
 * editing or deleting a definition never changes an existing run.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { stringify } from 'yaml';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { parseFleetDocument } from '../config-yaml.js';
import { defaultConfigPath } from '../paths.js';
import { loadConfig, splitRootFor } from '../config.js';
import { assertLayoutFile, validLayoutKey, validateRoomLayout, type RoomLayoutDefinition } from '../rooms-tasks/layout-config.js';
import { FleetError } from './errors.js';
import { layoutDefinitionHash } from './task-layouts.js';

export const ABSENT_REVISION = 'absent';
export type LayoutDefinitionBody = Omit<RoomLayoutDefinition, 'sourceFile'>;
export type LayoutListEntry =
  | { name: string; revision: string; file: string; definition: LayoutDefinitionBody; issues: string[]; definition_hash: string }
  | { name: string; revision: string; file: string; error: string };

const revisionOf = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export class RoomLayoutDefinitions {
  constructor(private configPath?: string, private deps: { loadConfiguration?: typeof loadConfig } = {}) {}

  private root(): string { return join(splitRootFor(this.configPath ?? defaultConfigPath()), 'room_layouts'); }

  private pathFor(name: string): string {
    if (!validLayoutKey(name)) throw new FleetError('invalid_request', 'layout name must start with a letter and use letters, digits, - or _');
    return join(this.root(), `${name}.yaml`);
  }

  private currentRevision(path: string): string {
    if (!existsSync(path)) return ABSENT_REVISION;
    assertLayoutFile(path);
    return revisionOf(readFileSync(path));
  }

  /** Agent-template references that do not resolve in the current Fleet configuration. */
  private templateIssues(definition: LayoutDefinitionBody): string[] {
    let templates: Record<string, unknown> = {};
    try { templates = (this.deps.loadConfiguration ?? loadConfig)(this.configPath).agentTemplates ?? {}; }
    catch (error) { return [`fleet configuration unavailable: ${(error as Error).message}`]; }
    return Object.entries(definition.participants).flatMap(([key, participant]) =>
      participant.agent_template && !Object.hasOwn(templates, participant.agent_template)
        ? [`participant ${key}: agent template not found: ${participant.agent_template}`] : []);
  }

  list(): LayoutListEntry[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    assertLayoutFile(root, true);
    return readdirSync(root).filter(file => /\.ya?ml$/.test(file)).sort().map(file => {
      const name = basename(file, extname(file)), path = join(root, file);
      try {
        if (!validLayoutKey(name)) throw Error(`invalid room layout id: ${name}`);
        assertLayoutFile(path);
        const bytes = readFileSync(path);
        const definition = validateRoomLayout(parseFleetDocument(path, bytes.toString('utf8'), 'strict').value, file);
        return { name, file, revision: revisionOf(bytes), definition, issues: this.templateIssues(definition), definition_hash: layoutDefinitionHash(definition) };
      } catch (error) {
        // Only a trusted regular file may be read to offer an overwrite revision.
        let revision = ABSENT_REVISION;
        try { assertLayoutFile(path); revision = revisionOf(readFileSync(path)); } catch { /* not trusted: never read */ }
        return { name, file, revision, error: (error as Error).message };
      }
    });
  }

  validate(raw: unknown): { definition?: LayoutDefinitionBody; issues: string[] } {
    let definition: LayoutDefinitionBody;
    try { definition = validateRoomLayout(raw, 'room layout'); }
    catch (error) { return { issues: [(error as Error).message] }; }
    return { definition, issues: this.templateIssues(definition) };
  }

  async save(name: string, expectedRevision: string, raw: unknown): Promise<{ name: string; revision: string; definition: LayoutDefinitionBody }> {
    const path = this.pathFor(name);
    const { definition, issues } = this.validate(raw);
    if (!definition || issues.length) throw new FleetError('invalid_request', issues.join('; '));
    const root = this.root();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertLayoutFile(root, true);
    return withFileLock(`${path}.lock`, async () => {
      const current = this.currentRevision(path);
      if (current !== expectedRevision)
        throw new FleetError('stale_state', 'room layout changed since it was loaded; reload before saving');
      const { description, participants, rooms } = definition;
      const text = stringify({ version: 1, ...(description ? { description } : {}), participants, rooms });
      replaceFileAtomically(path, text, 0o600);
      return { name, revision: revisionOf(text), definition };
    });
  }

  async remove(name: string, expectedRevision: string): Promise<{ name: string; deleted: boolean }> {
    const path = this.pathFor(name);
    return withFileLock(`${path}.lock`, async () => {
      const current = this.currentRevision(path);
      if (current === ABSENT_REVISION) return { name, deleted: false };
      if (current !== expectedRevision)
        throw new FleetError('stale_state', 'room layout changed since it was loaded; reload before deleting');
      unlinkSync(path);
      return { name, deleted: true };
    });
  }
}
