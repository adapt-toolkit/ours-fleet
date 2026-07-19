import { userInfo } from 'node:os';
import type { ResolvedRole } from './config.js';
import type { BriefingVocab } from './harness/types.js';

export interface BriefingOpts {
  stateDir: string;
  worklogPath: string;
  routinesPath: string;
  /** Curated body (from briefing_file) replacing the narrative sections. */
  briefingBody?: string;
}

/** Render a role's briefing.md: narrative (or curated body) + mechanical boot steps. */
export function generateBriefing(role: ResolvedRole, v: BriefingVocab, opts: BriefingOpts): string {
  const L: string[] = [];
  const id = role.identity;
  const hostUser = userInfo().username;
  L.push(`# ${role.name} — Role Briefing`, '');
  L.push(`You are **${role.name}** (ours identity: **${id}**), a persistent agent on this`);
  L.push(`host, running as the \`${hostUser}\` user.`);

  if (opts.briefingBody) {
    L.push('', opts.briefingBody.trim());
  } else {
    if (role.cwd) L.push('', `Your working directory is \`${role.cwd}\`. Operate on the code there.`);
    if (role.persona) L.push('', '## Charter (persona — your local operating contract)', role.persona.trim());
    if (role.bio) L.push('', '## Bio (public card — what peers and a coordinator see)', role.bio.trim());
    if (role.mission) L.push('', '## Mission', role.mission.trim());
  }

  L.push('', '## Do these NOW, in order');
  L.push(`1. ${v.launchNote(role.name)}`);
  L.push(`2. BIND your predefined ours identity: call the **${v.bindTool}** tool with`);
  L.push(`   name "${id}" force=true (search the deferred tool registry first if needed).`);
  L.push(`   - If no such identity exists yet, call **${v.createTool}** name "${id}" once`);
  L.push('     to mint it, then you are bound. Re-binding your OWN identity is always allowed.');
  L.push(`3. RECONCILE your profile (idempotent): call **${v.currentIdentityTool}** and read your`);
  L.push('   current bio and persona, so you only write below when they actually differ.');
  L.push(`4. PUBLISH your public **bio** via **${v.setBioTool}**`);
  L.push(role.bio
    ? '   with the **Bio** section above, verbatim. Skip the call if it already matches.'
    : '   with a 1–2 sentence summary of your Charter above. Skip if it already matches.');
  L.push(`5. SET your **persona** (local operating contract, never shared in invites) via`);
  L.push(`   **${v.setPersonaTool}** with the **Charter** section above, verbatim. Skip if it matches.`);
  // When the supervisor owns the monitor (monitor.enabled), the agent must NOT arm
  // its own in-session watch — wakes are injected as [fleet-monitor] lines (design §5).
  const wakeNote = role.monitor?.enabled
    ? v.supervisedWakeNote(id, role)
    : v.monitorInstruction(id, role);
  L.push(`6. ${wakeNote}`);
  if (role.coordinator) {
    L.push(`7. ANNOUNCE yourself: call **${v.sendTool}** to contact "${role.coordinator}" with text:`);
    L.push(`   "${role.name} online — identity '${id}' bound, ready."`);
    L.push(`8. Await messages. When the monitor wakes you (or the owner requests a manual check),`);
    L.push(`   call **${v.getMessagesTool}**, act, and reply.`);
  } else {
    L.push(`7. Await messages. When the monitor wakes you (or the owner requests a manual check),`);
    L.push(`   call **${v.getMessagesTool}**, act on them,`);
    L.push(`   and reply with ${v.sendTool}. No coordinator is configured — the owner drives you`);
    L.push(`   via \`tmux attach -t ${role.name}\` or by messaging "${id}".`);
  }

  if (role.oversee?.length) {
    L.push('', '## Oversight assignments');
    L.push('These agents are your wards — you keep them unstuck:');
    for (const o of role.oversee) L.push(`- **${o.role}** — check every ${o.interval}`);
    L.push('');
    L.push('Procedure (see also the oversee-agents skill if available): on each tick, run');
    for (const o of role.oversee) L.push(`\`ours-fleet peek ${o.role}\``);
    L.push('and judge the console: stuck on a prompt/menu/trust dialog → answer it directly with');
    L.push('`ours-fleet send <Name> "<text>"` (or `--key <K>` for raw keys); crashed to a shell →');
    L.push('investigate and restart; idle with work assigned → nudge; healthy → do nothing.');
    L.push('Escalate over ours messaging only when you cannot resolve it yourself.');
  }

  L.push('', '## Durable log');
  L.push(`Append important commands / decisions / results to \`${opts.worklogPath}\` as you go —`);
  L.push('it survives restarts.');
  L.push('', '## Routines');
  L.push(`If \`${opts.routinesPath}\` exists, re-read it at the START of every wake — before acting`);
  L.push('on messages, timers, or prompts — and follow it for recurring or scheduled work. It may');
  L.push('change between wakes without a restart; treat the file, not your memory of it, as current.');
  L.push('', '## On restart (you run under a supervised launcher)');
  L.push(`On restart, WITHOUT asking: re-bind (**${v.bindTool}** name "${id}" force=true), then`);
  L.push(`${wakeNote} Then continue from your WORKLOG.`);
  L.push('Do not blindly re-run whatever may have crashed you.');
  L.push('', '## House rules');
  L.push('- Never broad `rm -rf` on home/critical paths; quote globs; use explicit paths.');
  L.push('- When you stop, be in a declared state (DONE / BLOCKED / resting ≤2h).');
  return L.join('\n') + '\n';
}
