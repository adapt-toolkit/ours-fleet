import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapPresets } from '../src/preset-bootstrap.js';
import { loadConfig, splitRootFor } from '../src/config.js';
import { listTemplates } from '../src/rooms-tasks/templates.js';
import { formatSetupSummary, generateSetup, type InitAnswers } from '../src/init-wizard.js';
import { buildRoomMemberTask } from '../src/rooms-tasks/member-startup.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';

const answers: InitAnswers = {
  subscriptions: ['codex'], assignmentStrategy: 'one-model', reasoning: 'balanced',
  models: Object.fromEntries(['development', 'review', 'coordination'].map(work => [work, {
    harness: 'codex', session: 'acp', model: 'gpt-5.6-sol',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  }])) as InitAnswers['models'],
};

describe('packaged default role contract', () => {
  it('fresh bootstrap exposes the four executor roles and exact room layouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-default-roles-'));
    try {
      const config = join(root, 'fleet.yaml');
      bootstrapPresets(config);
      const split = splitRootFor(config);
      expect(readdirSync(join(split, 'roles')).sort())
        .toEqual(['Coordinator.yaml', 'Critic.yaml', 'Developer.yaml', 'Engineer.yaml', 'LocalCoordinator.yaml']);
      expect(readdirSync(join(split, 'agent_templates')).sort())
        .toEqual(['Critic.yaml', 'Developer.yaml', 'Engineer.yaml', 'LocalCoordinator.yaml']);
      const cfg = loadConfig(config, { yamlMode: 'strict' });
      const layouts = Object.fromEntries(listTemplates(cfg.roomTemplates ?? {})
        .map(template => [template.name, template.members.map(member => member.role)]));
      expect(layouts).toEqual({
        engineering: ['Engineer', 'Critic'],
        pair: ['Developer', 'Critic'], single: ['Developer'],
        team: ['LocalCoordinator', 'Developer', 'Critic'],
      });
      const coordinator = cfg.roles.find(role => role.name === 'FleetCoordinator')!;
      expect(coordinator.agentSelections?.role).toEqual({ ref: 'Coordinator' });
      expect(coordinator.bio).toMatch(/Fleet workflow coordinator/);
      expect(coordinator.persona).toMatch(/Own progress and workflow, not execution quality/);
      expect(coordinator.persona).toMatch(/Immediately before room creation/);
      expect(coordinator.persona).toMatch(/Brain, harness, session, model, reasoning effort/);
      // The coordinator speaks in its own conversation; nothing waits on a named owner channel.
      expect(coordinator.persona).toMatch(/introduce yourself in your first reply/);
      expect(coordinator.persona).not.toMatch(/owner channel|confirm delivery|If delivery fails/i);
      expect(coordinator.bio).not.toBe(coordinator.persona);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('generated setup uses the packaged role text as its single source of truth', () => {
    const files = generateSetup(answers).files;
    expect([...files.keys()].filter(path => path.startsWith('roles/')).sort()).toEqual([
      'roles/Coordinator.yaml', 'roles/Critic.yaml', 'roles/Developer.yaml',
      'roles/Engineer.yaml', 'roles/LocalCoordinator.yaml',
    ]);
    expect([...files.keys()].filter(path => path.startsWith('agent_templates/')).sort()).toEqual([
      'agent_templates/Critic.yaml', 'agent_templates/Developer.yaml',
      'agent_templates/Engineer.yaml', 'agent_templates/LocalCoordinator.yaml',
    ]);
    expect(files.get('agents/FleetCoordinator.yaml')).toContain('role: { ref: Coordinator }');
  });

  it('ships a vendor-neutral gate-pipeline Engineer as the gated engineering experience', () => {
    const files = generateSetup(answers).files;
    const role = String(files.get('roles/Engineer.yaml'));
    for (const marker of [
      /Definition of Done/, /failing test/, /over-engineering/, /security/i,
      /walk the same gates by\s+hand/, /gate-pipeline skill/,
    ]) expect(role).toMatch(marker);
    expect(role).not.toMatch(/engineer-mini|8hats/i);
    expect(files.get('agent_templates/Engineer.yaml')).toContain('role: { ref: Engineer }');
    expect(files.get('agent_templates/Engineer.yaml')).toContain('brain: { ref: codex-gpt-5-6-sol-medium }');
    const room = String(files.get('room_templates/engineering.yaml'));
    expect(room).toContain('role: Engineer');
    expect(room).toContain('agent_template: Engineer');
    expect(room).toContain('agent_template: Critic');
    expect(formatSetupSummary(answers, join(tmpdir(), 'fleet.yaml'))).toContain('Gated engineering');
  });

  it('gives every retained role a distinct public bio and enforces executor escalation boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-role-contracts-'));
    try {
      const config = join(root, 'fleet.yaml');
      bootstrapPresets(config);
      const presets = loadConfig(config, { yamlMode: 'strict' }).rolePresets!;
      for (const name of ['Coordinator', 'LocalCoordinator', 'Developer', 'Engineer', 'Critic']) {
        expect(presets[name].bio, name).toEqual(expect.any(String));
        expect(presets[name].persona, name).toEqual(expect.any(String));
        expect(presets[name].bio, name).not.toBe(presets[name].persona);
      }
      for (const name of ['LocalCoordinator', 'Developer', 'Engineer', 'Critic']) {
        const persona = String(presets[name].persona);
        expect(persona, name).toMatch(/task state, progress, checkpoints, findings, review verdicts, completion, handoffs, and ordinary\s+errors/i);
        expect(persona, name).toMatch(/only in the assigned Cowork room/i);
        expect(persona, name).toMatch(/(?:a|the) confirmed blocker or\s+infrastructure or orchestration\s+problem/i);
        expect(persona, name).toMatch(/prevents safe progress or room communication|requires Fleet-level action/i);
        expect(persona, name).toMatch(/test failures\s+under active diagnosis/i);
        expect(persona, name).toMatch(/incomplete work/i);
        expect(persona, name).toMatch(/not.*routine.*communication.*sink/i);
        expect(persona, name).toMatch(/configured Fleet Coordinator/);
        expect(persona, name).toMatch(/authenticated sender/);
        expect(persona, name).toMatch(/task\/room context/);
        expect(persona, name).toMatch(/bounded safe attempts/);
        expect(persona, name).toMatch(/canonical next action/);
        expect(persona, name).toMatch(/invites or\s+invite fingerprints/);
        expect(persona, name).toMatch(/transient blocker-report transport.*at most once after backoff/s);
        expect(persona, name).toMatch(/10 minutes\s+after a direct room attempt/);
        expect(persona, name).toMatch(/BLOCKED|resting/);
        expect(persona, name).toMatch(/(?:Leave recover,\s+block\/unblock, review\/finish, deletion, replacement, and respawn decisions to Fleet Coordinator|Only the configured Fleet Coordinator may recover, block, unblock, review, finish, delete, replace,\s+or respawn Fleet resources)/);
      }
      for (const name of ['Developer', 'Engineer', 'Critic']) {
        const persona = String(presets[name].persona);
        expect(persona, name).toMatch(/follow.*instructions directly in the room/i);
        expect(persona, name).toMatch(/replies and evidence in that same room/i);
        expect(persona, name).toMatch(/does not become a separate reporting channel/i);
      }
      const local = String(presets.LocalCoordinator.persona);
      expect(local).toMatch(/does not become a separate reporting channel/i);
      expect(local).toMatch(/follow[\s\S]*instructions[\s\S]*directly in the room/i);
      expect(local).toMatch(/replies and evidence[\s\S]*same room/i);
      expect(local).toMatch(/Do not implement task work/);
      expect(local).toMatch(/spawn, provision, replace, or manage agents/);
      expect(local).toMatch(/create tasks or rooms/);
      expect(local).toMatch(/Never claim Owner or Fleet Coordinator authority/);
      expect(local).toMatch(/continued nonresponse\s+then confirms an orchestration blocker/);
      expect(local).toMatch(/other confirmed infrastructure or orchestration\s+blocker.*without waiting for the peer window/s);
      expect(local).toMatch(/your own work state BLOCKED or resting/);
      expect(local).toMatch(/never invoke a Fleet task block/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ships the current-request To review lifecycle to every task role and one Progress writer per room', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-review-contracts-'));
    try {
      const config = join(root, 'fleet.yaml');
      bootstrapPresets(config);
      const cfg = loadConfig(config, { yamlMode: 'strict' });
      const generated = generateSetup(answers).files;
      for (const source of ['bootstrap', 'generated'] as const) {
        // Compare prose, not the YAML line wrapping.
        const persona = (name: string) => (source === 'bootstrap' ? String(cfg.rolePresets?.[name].persona) : String(generated.get(`roles/${name}.yaml`))).replace(/\s+/g, ' ');
        for (const name of ['Developer', 'Engineer', 'Critic', 'LocalCoordinator']) {
          const text = persona(name);
          expect(text, `${source}:${name}`).toMatch(/To\s+review\s+package/);
          expect(text, `${source}:${name}`).toMatch(/without (?:reading )?the room or the task description|review from it alone/);
          expect(text, `${source}:${name}`).toMatch(/PR\s+(?:link|and\s+specification)/);
          expect(text, `${source}:${name}`).toMatch(/limits/);
          expect(text, `${source}:${name}`).toMatch(/Owner\s+decision/);
          expect(text, `${source}:${name}`).toMatch(/grants no lifecycle authority|You do not move the task/);
        }
        for (const name of ['Developer', 'Engineer']) {
          expect(persona(name), `${source}:${name}`).toMatch(/ours-fleet task review-package\s+<task-id> --attach <path>/);
          expect(persona(name), `${source}:${name}`).toMatch(/need no PR|they need no PR/);
          expect(persona(name), `${source}:${name}`).toMatch(/Never mark the task done or merge/);
          // At Review the description keeps only PR links; the package keeps the original requirements.
          expect(persona(name), `${source}:${name}`).toMatch(/task description is replaced with only the clickable PR links, one per line/);
          expect(persona(name), `${source}:${name}`).toMatch(/save the current description \(the original requirements\) to a file in the task workspace and attach it to the package, keep fuller evidence in task files/);
          expect(persona(name), `${source}:${name}`).toMatch(/never add status logs to the description/);
          expect(persona(name), `${source}:${name}`).toMatch(/a research or document task without PRs links its actual deliverables instead; never invent a PR/);
        }
        expect(persona('Critic')).toMatch(/must also attach the original task description, which at Review is replaced with only the clickable PR links, one per line \(or the actual deliverable links when there are no PRs\)/);
        expect(persona('LocalCoordinator')).toMatch(/the original task description as an attached file \(at Review the description keeps only the PR links, or the actual deliverable links when there are no PRs\)/);
        expect(persona('Critic')).toMatch(/Withhold sign-off while it is missing, stale or misleading/);
        const local = persona('LocalCoordinator');
        expect(local).toMatch(/only writer of this task's Progress log/);
        expect(local).toMatch(/never poll, schedule turns or mirror messages/);
        expect(local).toMatch(/Skip agent starts, status checks, repeated status, handoffs, internal review back-and-forth, filler and unverified claims/);
        expect(local).toMatch(/at most 400 characters \(Unicode code points; longer text is refused, never cut\)/);
        expect(local).toMatch(/never split one sentence to fit/);
        expect(local).toMatch(/`ours-fleet task progress <task-id> --text <text> --request-key <key>`/);
        // To review is one current request; the Owner's answer, not opening it, resolves it, and a fenced clear removes it.
        expect(local).toMatch(/holds one CURRENT request for human review or decision/);
        expect(local).toMatch(/Owner review required: choose the deployment option in To review\./);
        expect(local).toMatch(/Opening To review does not resolve a request; the Owner's answer in the room does/);
        for (const name of ['LocalCoordinator', 'Developer', 'Engineer'])
          expect(persona(name), `${source}:${name}`).toMatch(/`fleet_task_review_clear` with `expected_revision` \(or `ours-fleet task review-package <task-id> --clear --expected-revision <n>`/);
        // Developers write Progress only in a room without a LocalCoordinator; Critic and Coordinator never.
        for (const name of ['Developer', 'Engineer']) {
          expect(persona(name), `${source}:${name}`).toMatch(/when the room has a LocalCoordinator, it alone writes Progress; post facts the Owner should know in the room instead\. Otherwise you write it/);
          expect(persona(name), `${source}:${name}`).toMatch(/at most 400 characters/);
        }
        expect(persona('Critic')).toMatch(/You do not write Progress/);
        expect(persona('Critic')).toMatch(/not your ongoing review/);
        for (const name of ['Critic', 'Coordinator'])
          expect(persona(name), `${source}:${name}`).not.toMatch(/fleet_task_progress_append|task progress <task-id> --text/);
        const coordinator = persona('Coordinator');
        expect(coordinator).toMatch(/ours-fleet task review-package <task-id>/);
        expect(coordinator).toMatch(/do not write or judge it yourself/);
        expect(coordinator).toMatch(/one current acceptance request, not an archive of earlier requests/);
        expect(coordinator).toMatch(/attach the original task description/);
        expect(coordinator).toMatch(/Then replace the task description with only the clickable Markdown PR links, one per line, with no status or evidence \(those stay in To review\); a task without PRs links its actual deliverables instead, never an invented PR. Then move the task to Review with `ours-fleet task review <task-id>`/);
        expect(coordinator).toMatch(/Only when the Owner accepts\s+the result or explicitly asks, run `ours-fleet task finish/);
        // The packaged continuity loop stays observation-only and never becomes a Progress pipeline;
        // generated setup ships no loop at all.
        if (source === 'bootstrap')
          expect(String(cfg.agentTemplates?.LocalCoordinator.loops?.continuity?.prompt).replace(/\s+/g, ' '))
            .toMatch(/This pass never appends task Progress entries/);
        else expect(String(generated.get('agent_templates/LocalCoordinator.yaml'))).not.toMatch(/loops|Progress/);
      }
      // Each generated room member task carries its charter's handoff; a Developer writes Progress only without a LocalCoordinator.
      for (const template of listTemplates(cfg.roomTemplates ?? {})) {
        const roster = template.members.map(member => ({ role_name: `${template.name}-${member.slot}-1`, cowork_role: member.role }));
        for (const [index, member] of template.members.entries()) {
          const task = buildRoomMemberTask({
            roomId: `${template.name}-room`, roomIdentityCid: 'A'.repeat(64), ownerSeatCid: 'B'.repeat(64), contract: template.contract,
            member: { ...roster[index], persona: String(cfg.rolePresets?.[member.role].persona) }, roster,
          });
          expect(task, `${template.name}:${member.role}`).toMatch(/To\s+review\s+package/);
          if (member.role === 'LocalCoordinator') expect(task).toContain('fleet_task_progress_append');
          else if (['Developer', 'Engineer'].includes(member.role))
            expect(task.replace(/\s+/g, ' ')).toMatch(/when the room has a LocalCoordinator, it alone writes Progress/);
          else expect(task, `${template.name}:${member.role}`).not.toContain('fleet_task_progress_append');
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('packages fleet/after_tool on every standard room Agent Template', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-template-monitor-'));
    try {
      const config = join(root, 'fleet.yaml');
      bootstrapPresets(config);
      const cfg = loadConfig(config, { yamlMode: 'strict' });
      for (const template of listTemplates(cfg.roomTemplates ?? {})) {
        for (const member of template.members) {
          expect(cfg.agentTemplates?.[member.agent_template].monitor,
            `${template.name}:${member.agent_template}`).toEqual({
            mode: 'fleet', interrupt: 'after_tool',
          });
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('renders room-only reporting into every standard member task with and without LocalCoordinator', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-generated-member-contracts-'));
    try {
      const config = join(root, 'fleet.yaml');
      bootstrapPresets(config);
      const cfg = loadConfig(config, { yamlMode: 'strict' });
      for (const template of listTemplates(cfg.roomTemplates ?? {})) {
        const roster = template.members.map(member => ({
          role_name: `${template.name}-${member.slot}-1`, cowork_role: member.role,
        }));
        for (const [index, member] of template.members.entries()) {
          const task = buildRoomMemberTask({
            roomId: `${template.name}-room`, roomIdentityCid: 'A'.repeat(64),
            ownerSeatCid: 'B'.repeat(64), contract: template.contract,
            member: { ...roster[index], persona: String(cfg.rolePresets?.[member.role].persona) },
            roster,
          });
          expect(task, `${template.name}:${member.role}`).toMatch(/only in (?:this|the assigned) (?:Cowork )?room/i);
          expect(task, `${template.name}:${member.role}`).toMatch(/confirmed blocker or\s+infrastructure or orchestration problem/i);
          if (template.name === 'team')
            expect(task, member.role).toMatch(/LocalCoordinator.*not.*separate reporting channel/is);
          else expect(roster.some(item => item.cowork_role === 'LocalCoordinator')).toBe(false);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});
