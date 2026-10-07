import { join } from 'node:path';

/** Readiness is a separate turn after identity/profile and room admission succeed. */
export function managedStartupPrompt(
  stateDir: string, mode: 'fresh' | 'resume', hasPriorBoot = false,
): string {
  const briefing = join(stateDir, 'briefing.md');
  const continuity = mode === 'resume' || hasPriorBoot
    ? ` For a later continuation task, read ${join(stateDir, 'WORKLOG.md')} once for continuity.`
    : '';
  return 'Fleet readiness check. The supervisor has verified your assigned identity, configured Role profile, '
    + 'and any required room admission. Reply with a short final console acknowledgement that you are ready, '
    + 'then end this turn. Announce readiness before any tool calls or file reads. '
    + 'Do not read briefing, routines, worklog, inbox, history, help or config during this readiness turn; '
    + 'do not perform identity/profile setup or broad tool discovery. Do not claim task work has been done. '
    + 'The supervisor delivers configured work separately; otherwise wait for a concrete task or supervisor wake. '
    + `For a later task or mail wake, read ${briefing} once before acting and reuse it within that wake. `
    + 'Read routines only for concrete work; an idle launch needs no detail reads. '
    + 'The supervisor delivers initial unread mail and later arrivals as wakes; do not poll the inbox at startup.'
    + continuity;
}

/** Configured work/continuity runs after readiness, never inside the fast turn. */
export function managedTaskPrompt(stateDir: string, mode: 'fresh' | 'resume', hasPriorBoot = false): string {
  const briefing = join(stateDir, 'briefing.md');
  const continuity = mode === 'resume' || hasPriorBoot
    ? ` Read ${join(stateDir, 'WORKLOG.md')} once for continuity.`
    : '';
  return `Read and follow ${briefing} for the assigned work. Readiness has already been announced; `
    + 'this is a separate task turn, so do not repeat the readiness acknowledgement.' + continuity + ' '
    + 'Identify the concrete assignment in the briefing or unfinished work in the continuation log. '
    + 'A role charter or public bio alone is not a new task. If there is no concrete work, end this turn '
    + 'and await a task without reading routines, inbox, history, or unrelated files. '
    + 'For concrete work, read any existing routines once, reuse details already read in this wake, '
    + 'acknowledge the actual task and next action through its assigned reply route, and proceed. '
    + (mode === 'fresh' && !hasPriorBoot ? 'On a fresh launch, do not read a worklog for initialization. ' : '')
    + 'Use inbox/history only when a mail wake, unread pagination, or the actual task needs them. '
    + 'The supervisor delivers initial unread mail; no model-owned startup poll is needed. '
    + 'Identity/profile setup, help/config exploration and broad tool discovery are not startup rituals.';
}
