import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { readTempSupervisor, TEMP_SUPERVISOR_FILE } from '../temp-lifecycle.js';
import type { ConversationEventStore } from './conversation-store.js';

/** Durable generation → launch/task evidence, independent of the transcript tail. Bounded to recent generations. */
export const SESSION_OWNERSHIP_FILE = '.session-ownership.json';
export interface SessionOwnership { launchId: string | null; taskId: string | null; }
const MAX_GENERATIONS = 16;
/** Canonical Fleet task identity; a task owner always has a launch. */
export const validOwnerTask = (taskId: unknown): taskId is string => typeof taskId === 'string' && /^[0-9a-z]{9}[0-9a-f]{8}$/.test(taskId);

export function readSessionOwnership(stateDir: string): Record<string, SessionOwnership> {
  const path = join(stateDir, SESSION_OWNERSHIP_FILE);
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (text.length > 64 * 1024) throw new Error('session ownership evidence too large');
  const value = JSON.parse(text);
  if (value?.schema !== 1 || !value.generations || typeof value.generations !== 'object' || Array.isArray(value.generations)) throw new Error('invalid session ownership evidence');
  const result: Record<string, SessionOwnership> = {};
  for (const [generation, owner] of Object.entries(value.generations as Record<string, SessionOwnership>)) {
    if (!owner || !(owner.launchId === null || typeof owner.launchId === 'string')
      || !(owner.taskId === null || validOwnerTask(owner.taskId)) || (owner.taskId !== null && owner.launchId === null)) throw new Error('invalid session ownership evidence');
    result[generation] = { launchId: owner.launchId, taskId: owner.taskId };
  }
  return result;
}

/**
 * Bind this session generation to its launch before any prompt can be admitted. A task member's generation names
 * its task; a role without temp-supervisor metadata is explicitly standalone. Existing but unreadable metadata is
 * unavailable evidence: the session refuses to start rather than guess. For a task-owned generation both the
 * sidecar and the ledger event must persist, or the session start fails (no prompt is admitted without its binding).
 */
export function recordSessionOwnership(conversation: ConversationEventStore, sessionGeneration: string, stateDir: string): void {
  let owner: SessionOwnership;
  if (!existsSync(join(stateDir, TEMP_SUPERVISOR_FILE))) owner = { launchId: null, taskId: null };
  else {
    const metadata = readTempSupervisor(stateDir);
    if (!metadata) throw new Error('session ownership unavailable: temp supervisor metadata is unreadable');
    const taskId = metadata.taskOwner?.taskId ?? null;
    if (taskId !== null && !validOwnerTask(taskId)) throw new Error('session ownership unavailable: invalid task owner');
    owner = { launchId: metadata.launchId, taskId };
  }
  const draft = { kind: 'session.ownership' as const, sessionGeneration, payload: owner };
  if (!owner.taskId) {
    // A standalone role keeps the existing degrade-not-die behaviour; missing evidence then means "unknown", never a task.
    try { writeSidecar(stateDir, sessionGeneration, owner); } catch { /* evidence unavailable: completions stay unlabelled */ }
    conversation.appendSafe(draft);
    return;
  }
  writeSidecar(stateDir, sessionGeneration, owner);
  conversation.append(draft);
}

function writeSidecar(stateDir: string, sessionGeneration: string, owner: SessionOwnership): void {
  let generations: Record<string, SessionOwnership> = {};
  try { generations = readSessionOwnership(stateDir); } catch { generations = {}; }
  delete generations[sessionGeneration];
  const kept = Object.entries(generations).slice(-(MAX_GENERATIONS - 1));
  replaceFileAtomically(join(stateDir, SESSION_OWNERSHIP_FILE),
    JSON.stringify({ schema: 1, generations: Object.fromEntries([...kept, [sessionGeneration, owner]]) }) + '\n', 0o600);
}
