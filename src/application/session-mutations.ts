import { interruptOutcome } from '../session/types.js';
import type {
  AgentSession, InterruptOutcome, QueuedPrompt, SubmitPromptOptions, TurnCancellationSource,
} from '../session/types.js';

/** Thin in-process session mutation kernel. Callers retain every policy decision. */
export const queueSessionPrompt = (
  session: AgentSession, text: string, options?: SubmitPromptOptions,
): Promise<QueuedPrompt> => session.queuePrompt(text, options);

export const interruptSession = async (
  session: AgentSession, source: TurnCancellationSource,
): Promise<InterruptOutcome> => interruptOutcome(await session.interrupt(source));

export const respondSessionPermission = (
  session: AgentSession, permissionId: string, optionId: string,
): boolean => session.respondPermission(permissionId, optionId);

export type GenerationPermissionResult = 'accepted' | 'stale' | 'unavailable';

export const respondSessionPermissionV2 = (
  session: AgentSession, permissionId: string, optionId: string, sessionGeneration: string,
): GenerationPermissionResult => session.respondPermissionV2
  ? session.respondPermissionV2(permissionId, optionId, sessionGeneration)
  : 'unavailable';
