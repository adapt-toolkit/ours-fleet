import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * True when the active worklog records anything. A restart that left no entry
 * has no continuity to restore, so it must not turn into a worklog read.
 */
export function worklogRecordsPriorWork(stateDir: string): boolean {
  const worklog = join(stateDir, 'WORKLOG.md');
  try {
    return existsSync(worklog) && readFileSync(worklog, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Readiness is a separate turn after identity/profile and room admission succeed.
 *
 * `fresh` starts a new model conversation, which reads the briefing exactly once;
 * `resume` restores a conversation that already holds it. `hasPriorWork` says the
 * worklog records earlier work — the only case where it is continuity input.
 */
export function managedStartupPrompt(
  stateDir: string, mode: 'fresh' | 'resume', hasPriorWork = false,
): string {
  const briefing = join(stateDir, 'briefing.md');
  const worklog = join(stateDir, 'WORKLOG.md');
  const context = mode === 'resume'
    ? `This restored conversation already holds ${briefing}; do not read it again unless its content is `
      + 'genuinely missing from your context. '
      + (hasPriorWork ? `Consult ${worklog} only as needed to recover your next action. ` : '')
    : `After this readiness turn, read ${briefing} once for this session: in the supervisor's task turn, `
      + 'or on your first concrete task or wake when no task turn is delivered. Reuse it on every later turn, '
      + 'task and mail wake without reading it again. '
      + (hasPriorWork ? `In that same first turn, read ${worklog} once for continuity. ` : '');
  return 'Fleet readiness check. The supervisor has verified your assigned identity, configured Role profile, '
    + 'and any required room admission. Reply with a short final console acknowledgement that you are ready, '
    + 'then end this turn. Announce readiness before any tool calls or file reads. '
    + 'Do not read briefing, routines, worklog, inbox, history, help or config during this readiness turn; '
    + 'do not perform identity/profile setup or broad tool discovery. Do not claim task work has been done. '
    + 'The supervisor delivers configured work separately; otherwise wait for a concrete task or supervisor wake. '
    + context
    + 'Read routines only for concrete work; an idle launch needs no detail reads. '
    + 'The supervisor delivers initial unread mail and later arrivals as wakes; do not poll the inbox at startup.';
}

/** Configured work/continuity runs after readiness, never inside the fast turn. */
export function managedTaskPrompt(stateDir: string, mode: 'fresh' | 'resume', hasPriorWork = false): string {
  const briefing = join(stateDir, 'briefing.md');
  const worklog = join(stateDir, 'WORKLOG.md');
  const opening = mode === 'resume'
    ? `Your conversation was restored and already holds ${briefing}: follow it for the assigned work `
      + 'without reading it again. Only if its content is genuinely missing from your context, read it once now. '
    : `Read and follow ${briefing} for the assigned work. This is the one briefing read of this session; `
      + 'reuse it on later turns, tasks and mail wakes without reading it again. ';
  const continuity = !hasPriorWork
    ? 'No previous work is recorded, so do not read a worklog for initialization. '
    : mode === 'resume'
      ? `Continue unfinished work from the restored conversation; consult ${worklog} only as needed to `
        + 'recover your next action. '
      : `Previous work is recorded: read ${worklog} once for continuity. Do not read it again later in `
        + 'this session, including after you append to it. ';
  return opening
    + 'Readiness has already been announced; this is a separate task turn, so do not repeat the readiness '
    + 'acknowledgement. ' + continuity
    + 'Identify the concrete assignment in the briefing or unfinished work in the continuation log. '
    + 'A role charter or public bio alone is not a new task. If there is no concrete work, end this turn '
    + 'and await a task without reading routines, inbox, history, or unrelated files. '
    + 'For concrete work, read any existing routines once for this session, '
    + 'acknowledge the actual task and next action through its assigned reply route, and proceed. '
    + 'Use inbox/history only when a mail wake, unread pagination, or the actual task needs them. '
    + 'The supervisor delivers initial unread mail; no model-owned startup poll is needed. '
    + 'Identity/profile setup, help/config exploration and broad tool discovery are not startup rituals.';
}
