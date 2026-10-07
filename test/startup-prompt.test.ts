import { describe, expect, it } from 'vitest';
import { managedStartupPrompt, managedTaskPrompt } from '../src/startup-prompt.js';
import { generateBriefing } from '../src/briefing.js';
import { makeCodexAdapter } from '../src/harness/codex.js';
import { makeClaudeCodeAdapter } from '../src/harness/claude-code.js';
import type { ResolvedRole } from '../src/config.js';

const role = {
  name: 'Worker', identity: 'Worker', harness: 'codex', mission: 'Review the assigned patch.',
  persona: 'Preserve the user custom charter.', bio: 'User custom public card.',
  monitor: { mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 0, inject: 'notification' },
} as ResolvedRole;
const opts = { stateDir: '/task/worker', worklogPath: '/task/worker/WORKLOG.md', routinesPath: '/task/worker/ROUTINES.md' };

describe('managed readiness and deferred work', () => {
  it.each([
    ['fresh', false], ['resume', false], ['fresh', true],
  ] as const)('ends the %s / priorBoot=%s readiness turn before tools and keeps future context', (mode, priorBoot) => {
    const prompt = managedStartupPrompt(opts.stateDir, mode, priorBoot);
    expect(prompt).toContain('short final console acknowledgement');
    expect(prompt).toContain('then end this turn');
    expect(prompt).toContain('before any tool calls or file reads');
    expect(prompt).toContain('any required room admission');
    expect(prompt).toContain('For a later task or mail wake, read /task/worker/briefing.md once');
    expect(prompt).toContain('do not poll the inbox at startup');
    // Ready must not contain the former unconditional startup actions.
    expect(prompt).not.toMatch(/Read and follow .* now|Read any existing routines|Catch up the initial unread/);
    expect(prompt).not.toMatch(/current_identity|choose_identity|set_persona|set_bio|send_message|get_messages/);
    if (mode === 'fresh' && !priorBoot) expect(prompt).not.toContain('WORKLOG.md');
    else expect(prompt).toContain('For a later continuation task, read /task/worker/WORKLOG.md once');
  });

  it('puts fresh task discovery after readiness and stops a charter-only briefing before extra reads', () => {
    const task = managedTaskPrompt(opts.stateDir, 'fresh');
    expect(task).toContain('Readiness has already been announced');
    expect(task).toContain('Read and follow /task/worker/briefing.md');
    expect(task).toContain('A role charter or public bio alone is not a new task');
    expect(task).toContain('without reading routines, inbox, history, or unrelated files');
    expect(task).toContain('On a fresh launch, do not read a worklog for initialization');
    expect(task).not.toContain('WORKLOG.md');
    expect(task.indexOf('If there is no concrete work')).toBeLessThan(task.indexOf('For concrete work, read any existing routines'));
    expect(task).toContain('mail wake, unread pagination, or the actual task');
  });

  it.each([['resume', false], ['fresh', true]] as const)(
    'recovers prior work after readiness with mode=%s / priorBoot=%s, including fresh-only harnesses', (mode, priorBoot) => {
      const task = managedTaskPrompt(opts.stateDir, mode, priorBoot);
      expect(task).toContain('Read /task/worker/WORKLOG.md once for continuity');
      expect(task).toContain('unfinished work in the continuation log');
      expect(task).toContain('If there is no concrete work, end this turn');
      expect(task).not.toContain('On a fresh launch, do not read a worklog');
    });

  it.each([makeCodexAdapter(), makeClaudeCodeAdapter()])('preserves role content, routing and recovery for $id', adapter => {
    for (const temporaryIdentity of [false, true]) {
      const b = generateBriefing({ ...role, harness: adapter.id }, adapter.vocabulary, { ...opts, temporaryIdentity });
      for (const content of [role.persona, role.bio, role.mission]) expect(b).toContain(content);
      expect(b).toContain('read it once in that wake before acting');
      expect(b).toContain('APIs remain available for an explicit task or a verified failure');
      expect(b).toContain('Do not claim unperformed work');
      expect(b).toContain('unread messages remain');
      expect(b).toContain('supervisor delivers initial unread mail');
      expect(b).toContain('including a fresh temporary agent');
      expect(b).toContain('console tasks use the console response');
      expect(b).not.toMatch(/current_identity|choose_identity|set_persona|set_bio/);
      expect(b).not.toContain('catch up the initial unread backlog');
      expect(b).not.toContain('re-read it at the START of every wake');
    }
    const restarted = adapter.vocabulary.restartPrompt(role.identity, opts.worklogPath, role);
    expect(restarted).toContain('Announce console readiness first without tools');
    expect(restarted).toContain('For a separate continuation task');
    expect(restarted).not.toContain('choose_identity');
    expect(restarted).toContain('[fleet-monitor]');
  });
});
