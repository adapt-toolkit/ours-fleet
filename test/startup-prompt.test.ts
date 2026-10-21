import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedStartupPrompt, managedTaskPrompt, worklogRecordsPriorWork } from '../src/startup-prompt.js';
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
    ['fresh', false], ['resume', false], ['fresh', true], ['resume', true],
  ] as const)('ends the %s / priorWork=%s readiness turn before tools', (mode, priorWork) => {
    const prompt = managedStartupPrompt(opts.stateDir, mode, priorWork);
    expect(prompt).toContain('short final console acknowledgement');
    expect(prompt).toContain('then end this turn');
    expect(prompt).toContain('before any tool calls or file reads');
    expect(prompt).toContain('any required room admission');
    expect(prompt).toContain('do not poll the inbox at startup');
    // Ready must not contain the former unconditional startup actions.
    expect(prompt).not.toMatch(/Read and follow .* now|Read any existing routines|Catch up the initial unread/);
    expect(prompt).not.toMatch(/current_identity|choose_identity|set_persona|set_bio|send_message|get_messages/);
    // A standing instruction scoped to "each wake" is what made agents reread every turn.
    expect(prompt).not.toMatch(/For a later task or mail wake|within that wake|in that wake|each later wake/);
    if (!priorWork) expect(prompt).not.toContain('WORKLOG.md');
  });

  it('reads the briefing once per new session and reuses it on later turns and wakes', () => {
    const prompt = managedStartupPrompt(opts.stateDir, 'fresh');
    expect(prompt).toContain('read /task/worker/briefing.md once for this session');
    expect(prompt).toContain('on your first concrete task or wake when no task turn is delivered');
    expect(prompt).toContain('Reuse it on every later turn, task and mail wake without reading it again');
    const task = managedTaskPrompt(opts.stateDir, 'fresh');
    expect(task).toContain('This is the one briefing read of this session');
    expect(task).toContain('reuse it on later turns, tasks and mail wakes without reading it again');
    expect(task).toContain('read any existing routines once for this session');
    expect(task).not.toMatch(/in this wake|in that wake/);
  });

  it('puts fresh task discovery after readiness and stops a charter-only briefing before extra reads', () => {
    const task = managedTaskPrompt(opts.stateDir, 'fresh');
    expect(task).toContain('Readiness has already been announced');
    expect(task).toContain('Read and follow /task/worker/briefing.md');
    expect(task).toContain('A role charter or public bio alone is not a new task');
    expect(task).toContain('without reading routines, inbox, history, or unrelated files');
    expect(task).toContain('do not read a worklog for initialization');
    expect(task).not.toContain('WORKLOG.md');
    expect(task.indexOf('If there is no concrete work')).toBeLessThan(task.indexOf('For concrete work, read any existing routines'));
    expect(task).toContain('mail wake, unread pagination, or the actual task');
  });

  it('restores continuity once in a new conversation that has recorded previous work', () => {
    const ready = managedStartupPrompt(opts.stateDir, 'fresh', true);
    expect(ready).toContain('read /task/worker/briefing.md once for this session');
    expect(ready).toContain('In that same first turn, read /task/worker/WORKLOG.md once for continuity');
    const task = managedTaskPrompt(opts.stateDir, 'fresh', true);
    expect(task).toContain('Read and follow /task/worker/briefing.md');
    expect(task).toContain('read /task/worker/WORKLOG.md once for continuity');
    expect(task).toContain('Do not read it again later in this session, including after you append to it');
    expect(task).toContain('unfinished work in the continuation log');
    expect(task).toContain('If there is no concrete work, end this turn');
    expect(task).not.toContain('do not read a worklog for initialization');
  });

  it.each([false, true])('keeps a restored conversation on its own context (priorWork=%s)', priorWork => {
    const ready = managedStartupPrompt(opts.stateDir, 'resume', priorWork);
    expect(ready).toContain('This restored conversation already holds /task/worker/briefing.md');
    expect(ready).toContain('unless its content is genuinely missing from your context');
    expect(ready).not.toMatch(/briefing\.md once/);
    const task = managedTaskPrompt(opts.stateDir, 'resume', priorWork);
    expect(task).not.toContain('Read and follow');
    expect(task).toContain('already holds /task/worker/briefing.md');
    expect(task).toContain('Only if its content is genuinely missing from your context, read it once now');
    expect(task).not.toMatch(/WORKLOG\.md once/);
    for (const prompt of [ready, task]) {
      if (priorWork) expect(prompt).toContain('/task/worker/WORKLOG.md only as needed to recover your next action');
      else expect(prompt).not.toContain('WORKLOG.md');
    }
  });

  it('treats only a worklog with recorded entries as previous work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-prior-work-'));
    try {
      expect(worklogRecordsPriorWork(dir)).toBe(false);
      writeFileSync(join(dir, 'WORKLOG.md'), '');
      expect(worklogRecordsPriorWork(dir)).toBe(false);
      writeFileSync(join(dir, 'WORKLOG.md'), ' \n\n');
      expect(worklogRecordsPriorWork(dir)).toBe(false);
      writeFileSync(join(dir, 'WORKLOG.md'), '- opened the PR\n');
      expect(worklogRecordsPriorWork(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([makeCodexAdapter(), makeClaudeCodeAdapter()])('preserves role content, routing and recovery for $id', adapter => {
    for (const temporaryIdentity of [false, true]) {
      const b = generateBriefing({ ...role, harness: adapter.id }, adapter.vocabulary, { ...opts, temporaryIdentity });
      for (const content of [role.persona, role.bio, role.mission]) expect(b).toContain(content);
      expect(b).toContain('read it once per session before acting');
      expect(b).toContain('Read this briefing once per session');
      expect(b).toContain('mail wakes and ordinary continuation reuse it without another read');
      expect(b).toContain('A later turn or wake needs no briefing, routines or worklog read');
      expect(b).toContain('read it once when a new conversation starts after a restart and it records previous work');
      expect(b).toMatch(/never\s+reread it because you appended to it/);
      // Legitimate rereads stay possible without becoming a per-wake ritual.
      expect(b).toContain('Reread an instruction file only when you are told it changed,');
      expect(b).toContain('Append important commands / decisions / results');
      expect(b).not.toMatch(/For a concrete task or mail wake|in that wake|in each later wake|[Ww]ithin a wake|same wake/);
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
    expect(restarted).toContain('once for continuity if it records previous work');
    expect(restarted).not.toContain('in that wake');
    expect(restarted).not.toContain('choose_identity');
    expect(restarted).toContain('[fleet-monitor]');
  });
});
