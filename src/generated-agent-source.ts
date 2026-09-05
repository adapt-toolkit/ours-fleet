import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export const GENERATED_AGENT_SOURCE_MARKER = '.generated-agent-source.json';

interface GeneratedAgentSourceMarker {
  version: 1;
  configPath: string;
  agentPath: string;
}

const normalized = (path: string): string => resolve(path);

/** Durable proof that Fleet itself created one exact Agent document. */
export function recordGeneratedAgentSource(
  stateDir: string, configPath: string, agentPath: string,
): void {
  const marker: GeneratedAgentSourceMarker = {
    version: 1,
    configPath: normalized(configPath),
    agentPath: normalized(agentPath),
  };
  const path = join(stateDir, GENERATED_AGENT_SOURCE_MARKER);
  const temporary = join(stateDir, `.${GENERATED_AGENT_SOURCE_MARKER}.${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* never hide the original failure */ }
    throw error;
  }
}

/**
 * Verify exact generated-file ownership. Missing, malformed, or mismatched
 * state fails closed: shared v2 agents/ directories also contain hand-written
 * documents, so directory membership alone is never deletion authority.
 */
export function provesGeneratedAgentSource(
  stateDir: string, configPath: string | undefined, agentPath: string,
): boolean {
  if (!configPath) return false;
  const path = join(stateDir, GENERATED_AGENT_SOURCE_MARKER);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if ((stat.mode & 0o022) !== 0) return false;
    if (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) return false;
    const marker = JSON.parse(readFileSync(path, 'utf8')) as Partial<GeneratedAgentSourceMarker>;
    return marker.version === 1
      && marker.configPath === normalized(configPath)
      && marker.agentPath === normalized(agentPath);
  } catch { return false; }
}
