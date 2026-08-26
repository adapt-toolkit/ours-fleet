import { interruptOutcome } from '../session/types.js';
import type {
  InterruptOutcome, QueuedPrompt, SessionHandle, SubmitPromptOptions, TurnCancellationSource,
} from '../session/types.js';

/** Thin in-process session mutation kernel. Callers retain every policy decision. */
export const queueSessionPrompt = (
  session: SessionHandle, text: string, options?: SubmitPromptOptions,
): Promise<QueuedPrompt> => session.queuePrompt(text, options);

export const interruptSession = async (
  session: SessionHandle, source: TurnCancellationSource,
): Promise<InterruptOutcome> => interruptOutcome(await session.interrupt(source));

export const respondSessionPermission = (
  session: SessionHandle, permissionId: string, optionId: string,
): boolean => session.respondPermission(permissionId, optionId);

export type GenerationPermissionResult = 'accepted' | 'stale' | 'unavailable';

export const respondSessionPermissionV2 = (
  session: SessionHandle, permissionId: string, optionId: string, sessionGeneration: string,
): GenerationPermissionResult => session.respondPermissionV2
  ? session.respondPermissionV2(permissionId, optionId, sessionGeneration)
  : 'unavailable';
