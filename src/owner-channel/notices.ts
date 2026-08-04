import type { SessionSnapshot, TurnOutcome } from '../session/types.js';
import type { OwnerTaskPhase } from './tasks.js';

export type OwnerUpdatePhase = 'working' | 'approval' | 'blocked';

export type OwnerProgressPhase =
  | 'starting request'
  | 'waiting behind earlier requests'
  | 'working on request'
  | 'planning next step'
  | 'using tools'
  | 'reviewing tool results'
  | 'drafting response'
  | 'waiting for approval'
  | 'resuming after permission decision'
  | 'recovering from session error';

const duration = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', remainder ? `${remainder}s` : '']
    .filter(Boolean).join(' ') || '0s';
};

const count = (value: number, singular: string, plural = `${singular}s`): string =>
  `${value} ${value === 1 ? singular : plural}`;

const joinCounts = (parts: string[]): string => parts.length < 2
  ? parts[0] ?? ''
  : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

export const ownerNotices = {
  receivedStarted: () =>
    'ℹ️ Message received. The agent has started working on this request now. '
    + 'The response will arrive in this channel when ready.',

  receivedQueued: (queuedBehind: number) =>
    `ℹ️ Message received. The agent is finishing ${queuedBehind} earlier request(s) first; `
    + 'this request will start as soon as they complete. '
    + 'The response will arrive in this channel when ready.',

  receivedInterrupting: () =>
    "ℹ️ Message received. The agent's previous task was interrupted to prioritize "
    + 'this request, and it is now working on a response. '
    + 'The response will arrive in this channel when ready.',

  status: (role: string, snapshot: SessionSnapshot) =>
    `📊 ${role} status: ${snapshot.readiness}; session is ${snapshot.alive ? 'online' : 'offline'}.`,

  interrupted: (role: string) => `🛑 Interrupt sent to ${role}'s active turn.`,
  interruptFailed: (role: string) => `⚠️ Could not interrupt ${role}'s active turn.`,

  commandStarted: (command: string) =>
    `⏳ Running ${command} — the result will follow in this channel.`,

  commandOutcome: (command: string, outcome: TurnOutcome, output?: string) => {
    switch (outcome) {
      case 'completed': return `✅ ${command} completed.${output ? `\n${output}` : ''}`;
      case 'cancelled': return `🛑 ${command} was cancelled before completion.`;
      case 'refused': return `⚠️ ${command} was declined by the agent harness.`;
      case 'failed': return `⚠️ ${command} failed before completion.`;
      case 'inconclusive': return `⚠️ ${command} ended without a confirmed completion.`;
    }
  },

  commandFailed: (command: string) => `⚠️ ${command} could not be executed.`,

  commandUnsupported: (command: string, harness: string) =>
    `⚠️ ${command} is not supported on the '${harness}' harness: its bundled ACP `
    + 'adapter does not execute it locally, so forwarding it would deliver the '
    + 'text to the model as an ordinary prompt. Nothing was forwarded.',

  restarting: (role: string, command: string, mode: 'keep' | 'fresh') =>
    `ℹ️ ${command} accepted — restarting ${role} ${mode === 'fresh'
      ? 'FRESH (context wiped)' : '(context resumes)'}. `
    + 'The channel goes quiet during the restart and resumes when the agent is back.',
  attachmentRejected: (reason: string) => `⚠️ Attachment rejected: ${reason}.`,
  attachmentFailed: () => '⚠️ Could not securely retrieve or admit this attachment request.',
  deliveryFailed: (role: string) => `⚠️ Could not deliver this request to ${role}.`,

  progress: (
    elapsedMs: number, phase: OwnerProgressPhase, started: number, completed: number,
    activityUpdates = 0,
  ) => {
    const counts: string[] = [];
    if (started) counts.push(`${count(started, 'tool action')} started`);
    if (completed) counts.push(`${count(completed, 'tool action')} completed`);
    if (activityUpdates) counts.push(
      `${count(activityUpdates, counts.length ? 'additional activity update' : 'activity update')} observed`);
    const activity = counts.length
      ? `${joinCounts(counts)} since the last update.`
      : 'no new reportable activity since the last update.';
    return `⏳ Working for ${duration(elapsedMs)} · ${phase} · ${activity}`;
  },

  authoredUpdate: (phase: OwnerUpdatePhase, message: string) => {
    switch (phase) {
      case 'working': return `🔄 Update: ${message}`;
      case 'approval': return `🔐 Approval needed: ${message}`;
      case 'blocked': return `🚧 Blocked: ${message}`;
    }
  },

  taskReport: (phase: OwnerTaskPhase, message: string) => {
    switch (phase) {
      case 'progress': return `🔄 Follow-up: ${message}`;
      case 'done': return `✅ Follow-up complete: ${message}`;
      case 'blocked': return `🚧 Follow-up blocked: ${message}`;
    }
  },

  completedWithoutText: () => '✅ Request completed, but the agent returned no text.',

  terminal: (outcome: TurnOutcome) => {
    switch (outcome) {
      case 'completed': return '✅ Request completed.';
      case 'cancelled': return '🛑 Request was cancelled before completion.';
      case 'refused': return '⚠️ The agent declined this request.';
      case 'failed': return '⚠️ Request failed before completion.';
      case 'inconclusive': return '⚠️ Request ended without a confirmed completion.';
    }
  },

  chunk: (part: number, total: number) => `ℹ️ Response part ${part} of ${total}:\n`,
};
