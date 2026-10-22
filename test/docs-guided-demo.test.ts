import { describe, it, expect } from 'vitest';
import { AI_DOCS } from '../src/docs.js';
import { APP_GUIDE_URL } from '../src/briefing.js';

const section = (title: string): string => {
  const start = AI_DOCS.indexOf(`### ${title}\n`);
  expect(start, title).toBeGreaterThan(-1);
  const next = AI_DOCS.slice(start + 4).search(/\n#{2,3} /);
  return AI_DOCS.slice(start, next < 0 ? undefined : start + 4 + next);
};
const demo = () => section('Guided demo task');
const brief = () => demo().split('```text\n')[1]?.split('```')[0] ?? '';

describe('ours-fleet docs: app help and guided demo task', () => {
  it('names the public guide and the resumed-context limit of briefing changes', () => {
    const help = section('ours app help');
    expect(help).toContain(APP_GUIDE_URL);
    expect(help).toMatch(/`restart` resumes\s+context/);
  });

  it('starts the demo from the shipped team room template after checking it, never a layout', () => {
    const text = demo();
    expect(text).toContain('ours-fleet task create --title "Guided demo: getting started with ours" --brief-file FILE --backlog --no-room');
    expect(text).toContain('ours-fleet task start TASK --template team');
    expect(text).toContain('ours-fleet template show team');
    expect(text).toContain('ours-fleet config --json');
    expect(text).toMatch(/exactly one LocalCoordinator, one Developer and one Critic/);
    expect(text).toMatch(/stop rather than editing their\s+configuration/);
    expect(text).not.toMatch(/--layout|--template single/);
    expect(text).toMatch(/never a room layout/);
  });

  it('makes the room LocalCoordinator the user guide and sole Progress writer, keeping clicks with the user', () => {
    const text = demo();
    expect(text).toMatch(/the room's LocalCoordinator explains each\s+step to the user and waits for their clicks/);
    expect(text).toMatch(/Never add agents, or generate, view or accept invitations,\s+for the user/);
    const b = brief();
    expect(b).toMatch(/local_coordinator: the user's guide in this room/);
    expect(b).toMatch(/never perform\s+their clicks or handle invitation codes/);
    expect(b).toMatch(/write the Progress log/);
    expect(b.match(/Progress log/g)).toHaveLength(1);
  });

  it('has the user add a task-managed helper with its own deliverable', () => {
    const b = brief();
    expect(b).toContain('"Add agent to task"');
    expect(b).toMatch(/"Member\s+name" helper, "Agent Template" Developer/);
    expect(b).toMatch(/helper writes\s+quick-reference\.md/);
    expect(b).toMatch(/Never add agents yourselves/);
  });

  it('explains real external collaboration and requires the temporary-agent join exercise', () => {
    const b = brief();
    expect(b).toMatch(/A colleague or friend can join this room with their own ours identity or\s+agent/);
    expect(b).toMatch(/no access to the task's files and no task\s+actions/);
    expect(b).toContain('"Generate one-time room invite"');
    expect(b).toContain('"New chat"');
    expect(b).toMatch(/"Agent actions" \(⋯\) → "Accept invite"/);
    expect(b).toMatch(/until the new seat\s+shows active/);
    expect(b).toMatch(/never paste it into this room/);
    expect(b).not.toMatch(/optional/i);
  });

  it('keeps staged real progress, a complete package and no executor lifecycle authority', () => {
    const b = brief();
    for (const stage of ['S1 Draft', 'S2 Add an agent', 'S3 Invite a collaborator', 'S4 Evidence', 'S5 Ready'])
      expect(b).toContain(stage);
    expect(b).toContain(APP_GUIDE_URL);
    expect(b).toContain('demo-s1..demo-s5');
    expect(b).toMatch(/only after its artifact or the\s+user's action exists/);
    expect(b).toMatch(/original-description\.md/);
    expect(b).toMatch(/all four files/);
    expect(b).toContain('/api/v1/tasks/<task-id>/review/artifacts/<artifact-id>');
    expect(b).toMatch(/Never run task review, finish, cancel or delete/);
    expect(b).not.toMatch(/\$\{/);
  });

  it('follows the supported Review handoff through the coordinator and the user', () => {
    const text = demo();
    expect(text).toMatch(/Room posts do not wake you/);
    expect(text).toContain('say "check the demo"');
    expect(text).toMatch(/Never busy-poll/);
    expect(text).toMatch(/lists all four\s+files/);
    expect(text).toMatch(/Never guess a host or workspace/);
    expect(text).toMatch(/Wait until the save succeeds, then run `ours-fleet task review TASK`/);
    expect(text).toMatch(/Let the user click\s+"Finish task" themselves/);
    expect(text).toMatch(/keeps the task folder\s+and To review files/);
    expect(text).toMatch(/permanently deletes the\s+task folder/);
  });
});
