import { describe, it, expect } from 'vitest';
import { AI_DOCS } from '../src/docs.js';
import { APP_GUIDE_URL } from '../src/briefing.js';

const section = (title: string): string => {
  const start = AI_DOCS.indexOf(`### ${title}\n`);
  expect(start, title).toBeGreaterThan(-1);
  const next = AI_DOCS.slice(start + 4).search(/\n#{2,3} /);
  return AI_DOCS.slice(start, next < 0 ? undefined : start + 4 + next);
};

describe('ours-fleet docs: app help and guided demo task', () => {
  it('names the public guide and the resumed-context limit of briefing changes', () => {
    const help = section('ours app help');
    expect(help).toContain(APP_GUIDE_URL);
    expect(help).toMatch(/`restart` resumes\s+context/);
  });

  it('starts the demo from the shipped single room template, never a layout', () => {
    const demo = section('Guided demo task');
    expect(demo).toContain('ours-fleet task create --title "Guided demo: getting started with ours" --brief-file FILE --backlog --no-room');
    expect(demo).toContain('ours-fleet task start TASK --template single');
    expect(demo).not.toMatch(/--layout/);
    expect(demo).toMatch(/never a room layout/);
  });

  it('leaves agent additions, invitations and closing to user clicks and review to the coordinator', () => {
    const demo = section('Guided demo task');
    expect(demo).toMatch(/Never\s+add agents, generate, view or accept invitations for the user/);
    expect(demo).toContain('"Add agent to task"');
    expect(demo).toContain('"Generate room invite"');
    expect(demo).toContain('"Refresh participants"');
    expect(demo).toContain('ours-fleet task review TASK');
    expect(demo).toMatch(/Let the user\s+click "Finish task" themselves/);
    expect(demo).toMatch(/keeps the task folder and To review files/);
    expect(demo).toMatch(/permanently deletes the task folder/);
  });

  it('gives executors a bounded brief with real staged progress and no lifecycle authority', () => {
    const brief = section('Guided demo task').split('```text\n')[1]?.split('```')[0] ?? '';
    for (const stage of ['S1 Draft', 'S2 Reviewer', 'S3 Newcomer', 'S4 Ready'])
      expect(brief).toContain(stage);
    expect(brief).toContain(APP_GUIDE_URL);
    expect(brief).toContain('demo-s1..demo-s4');
    expect(brief).toMatch(/only\s+after its artifact or the user's action exists/);
    expect(brief).toMatch(/Never run task review, finish, cancel or delete/);
    expect(brief).toMatch(/never generate or accept invitations/);
    expect(brief).not.toMatch(/\$\{/);
    expect(brief).toMatch(/original-description\.md/);
    expect(brief).toMatch(/attach all three files/);
    expect(brief).toContain('/api/v1/tasks/<task-id>/review/artifacts/<artifact-id>');
  });

  it('follows the supported Review handoff: complete package and deliverable-only description', () => {
    const demo = section('Guided demo task');
    expect(demo).toMatch(/lists all three files/);
    expect(demo).toMatch(/the description becomes one clickable\s+link to its actual deliverables/);
    expect(demo).toMatch(/Never invent a PR/);
    expect(demo).toMatch(/never guess a host or\s+workspace/);
    expect(demo).toMatch(/Wait until the save succeeds, then run\s+`ours-fleet task review TASK`/);
  });

  it('checks the installed template and observes stages without wakes or executor messages', () => {
    const demo = section('Guided demo task');
    expect(demo).toContain('ours-fleet template show single');
    expect(demo).toMatch(/stop rather than editing their\s+configuration/);
    expect(demo).toMatch(/Room posts do not wake you/);
    expect(demo).toContain('say "check the demo"');
    expect(demo).toContain('fleet_reminder_create');
    expect(demo).toMatch(/Never busy-poll/);
    expect(demo).toContain('"Generate one-time room invite"');
    expect(demo).toMatch(/until the\s+new seat shows active/);
  });
});
