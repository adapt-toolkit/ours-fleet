import { createHash } from 'node:crypto';

import type { ConversationSource, PendingPromptSummary } from './conversation-types.js';
import type { PromptOrigin, TurnResult } from './types.js';

/**
 * A prompt the session has admitted and not yet handed to the adapter.
 *
 * Every admitted prompt keeps its own id, ledger records and completion. What
 * changes at a turn boundary is how many of them one adapter turn carries.
 */
export interface PendingPrompt {
  promptId: string;
  text: string;
  origin?: PromptOrigin;
  source: ConversationSource;
  /** Whether the ledger already holds this body; an external body is never copied out of the queue. */
  persistBody: boolean;
  admittedAt: string;
  /** Set when a release takes this prompt; every member of that turn shares it. */
  released?: Promise<TurnResult>;
}

/**
 * The inventory names every waiting prompt — a client must be able to show the
 * whole queue, not a count of what it could not see. What keeps a snapshot
 * small is the body: each entry carries a short preview, not the prompt.
 */
const INVENTORY_TEXT_CHARS = 200;

/**
 * How a waiting prompt takes part in a release.
 *
 *  - `message`: something a person or a peer route submitted for the agent to
 *    read — the paired console, the owner channel, the local console, a
 *    monitor wake. Every waiting message is delivered at one boundary, in
 *    admission order, whatever its route.
 *  - `command`: a session command (`/compact`, …). It must reach the adapter
 *    as the entire prompt, so it is its own turn and a boundary between the
 *    messages before and after it.
 *  - `internal`: startup, scheduled-loop and stall-watchdog prompts. They own
 *    their turn's lifecycle (and, for a loop, the redaction of its whole
 *    transcript), run alone, and never split the messages around them.
 */
export type PromptClass = 'message' | 'command' | 'internal';

const INTERNAL = new Set<string>(['startup', 'scheduled-loop', 'stall-watchdog']);
const SESSION_COMMAND = /^\/[a-z][a-z0-9_-]*(\s|$)/i;

export function promptClass(prompt: Pick<PendingPrompt, 'text' | 'origin'>): PromptClass {
  if (INTERNAL.has(prompt.origin?.kind ?? 'local-console')) return 'internal';
  return SESSION_COMMAND.test(prompt.text.trim()) ? 'command' : 'message';
}

/**
 * Detach, in admission order, every pending prompt that is delivered with
 * `head`. Synchronous on purpose: this is the snapshot boundary, and a prompt
 * admitted after it returns belongs to the next release.
 */
export function takeBatch(pending: PendingPrompt[], head: PendingPrompt): PendingPrompt[] {
  const members: PendingPrompt[] = [];
  if (promptClass(head) !== 'message') members.push(head);
  else {
    for (const prompt of pending) {
      const kind = promptClass(prompt);
      if (kind === 'command') break;
      if (kind === 'message') members.push(prompt);
    }
    if (!members.includes(head)) members.unshift(head);
  }
  for (const member of members) {
    const at = pending.indexOf(member);
    if (at >= 0) pending.splice(at, 1);
  }
  return members;
}

/** Exact, server-computed identity of one member's body inside a shared turn. */
export interface MemberBinding {
  index: number;
  of: number;
  source: ConversationSource;
  bytes: number;
  sha256: string;
}

export function memberBindings(members: ReadonlyArray<Pick<PendingPrompt, 'text' | 'origin'>>,
  sourceOf: (origin: PromptOrigin | undefined) => ConversationSource): MemberBinding[] {
  return members.map((member, at) => ({
    index: at + 1,
    of: members.length,
    source: sourceOf(member.origin),
    bytes: Buffer.byteLength(member.text),
    sha256: createHash('sha256').update(member.text).digest('hex'),
  }));
}

/** What the server asserts about a member's route; never derived from the member's text. */
export function memberAuthority(source: ConversationSource): string {
  switch (source) {
    case 'owner_admin_console':
      return 'direct owner input from the server-authenticated paired console';
    case 'owner_channel':
      return 'admitted through the authenticated Fleet owner channel';
    case 'fleet_monitor':
      return 'a Fleet monitor notification, not owner input';
    default:
      return 'local console input, not authenticated owner-console or owner-channel input';
  }
}

/** What a client may show for prompts still waiting: all of them, in order, and never an unpersisted body. */
export function pendingInventory(pending: readonly PendingPrompt[]): {
  pendingPrompts: PendingPromptSummary[]; pendingPromptCount: number;
} {
  return {
    pendingPromptCount: pending.length,
    pendingPrompts: pending.map(prompt => {
      const display = prompt.origin?.kind === 'owner' ? prompt.origin.displayText
        : prompt.persistBody ? prompt.text : undefined;
      return {
        promptId: prompt.promptId,
        source: prompt.source,
        admittedAt: prompt.admittedAt,
        bytes: Buffer.byteLength(prompt.text),
        ...(display === undefined ? {} : {
          text: display.slice(0, INVENTORY_TEXT_CHARS),
          ...(display.length > INVENTORY_TEXT_CHARS ? { textTruncated: true } : {}),
        }),
      };
    }),
  };
}
