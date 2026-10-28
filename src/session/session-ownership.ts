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

/** Absent evidence is `{}` (no file: ENOENT only). Unreadable or invalid evidence throws and is never treated as absent. */
export function readSessionOwnership(stateDir: string): Record<string, SessionOwnership> {
  let text: string;
  try { text = readFileSync(join(stateDir, SESSION_OWNERSHIP_FILE), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
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
    // A standalone role keeps the existing degrade-not-die behaviour. A sidecar that cannot be updated is left exactly as
    // it was (never reset): the ledger event still binds this generation, and the observer refuses to guess from it.
    try { writeSidecar(stateDir, sessionGeneration, owner); } catch { /* evidence preserved; the ledger binding remains */ }
    conversation.appendSafe(draft);
    return;
  }
  writeSidecar(stateDir, sessionGeneration, owner);
  conversation.append(draft);
}

/** Initializes only on proven absence. Corrupt or unreadable prior evidence throws and its bytes stay untouched. */
function writeSidecar(stateDir: string, sessionGeneration: string, owner: SessionOwnership): void {
  const generations = readSessionOwnership(stateDir);
  delete generations[sessionGeneration];
  const kept = Object.entries(generations).slice(-(MAX_GENERATIONS - 1));
  replaceFileAtomically(join(stateDir, SESSION_OWNERSHIP_FILE),
    JSON.stringify({ schema: 1, generations: Object.fromEntries([...kept, [sessionGeneration, owner]]) }) + '\n', 0o600);
}
