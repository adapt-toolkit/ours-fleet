import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bootstrapPresets } from '../src/preset-bootstrap.js';
import { loadConfig, splitRootFor } from '../src/config.js';
import { listTemplates } from '../src/rooms-tasks/templates.js';
import { generateSetup, type InitAnswers } from '../src/init-wizard.js';
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
  it('fresh bootstrap exposes only the three executor roles and exact room layouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-default-roles-'));
    try {
      const config = join(root, 'fleet.yaml');
      bootstrapPresets(config);
      const split = splitRootFor(config);
      expect(readdirSync(join(split, 'roles')).sort())
        .toEqual(['Coordinator.yaml', 'Critic.yaml', 'Developer.yaml', 'LocalCoordinator.yaml']);
      expect(readdirSync(join(split, 'agent_templates')).sort())
        .toEqual(['Critic.yaml', 'Developer.yaml', 'LocalCoordinator.yaml']);
      const cfg = loadConfig(config, { yamlMode: 'strict' });
      const layouts = Object.fromEntries(listTemplates(cfg.roomTemplates ?? {})
        .map(template => [template.name, template.members.map(member => member.role)]));
      expect(layouts).toEqual({
        pair: ['Developer', 'Critic'], single: ['Developer'],
        team: ['LocalCoordinator', 'Developer', 'Critic'],
      });
      const coordinator = cfg.roles.find(role => role.name === 'FleetCoordinator')!;
      expect(coordinator.agentSelections?.role).toEqual({ ref: 'Coordinator' });
      expect(coordinator.bio).toMatch(/Fleet workflow coordinator/);
      expect(coordinator.persona).toMatch(/Own progress and workflow, not execution quality/);
      expect(coordinator.bio).not.toBe(coordinator.persona);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('generated setup uses the packaged role text as its single source of truth', () => {
    const files = generateSetup(answers).files;
    expect([...files.keys()].filter(path => path.startsWith('roles/')).sort()).toEqual([
      'roles/Coordinator.yaml', 'roles/Critic.yaml', 'roles/Developer.yaml',
      'roles/LocalCoordinator.yaml',
    ]);
    expect([...files.keys()].filter(path => path.startsWith('agent_templates/')).sort()).toEqual([
      'agent_templates/Critic.yaml', 'agent_templates/Developer.yaml',
      'agent_templates/LocalCoordinator.yaml',
    ]);
    expect(files.get('agents/FleetCoordinator.yaml')).toContain('role: { ref: Coordinator }');
  });

  it('gives every retained role a distinct public bio and enforces executor escalation boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-role-contracts-'));
    try {
      const config = join(root, 'fleet.yaml');
      bootstrapPresets(config);
      const presets = loadConfig(config, { yamlMode: 'strict' }).rolePresets!;
      for (const name of ['Coordinator', 'LocalCoordinator', 'Developer', 'Critic']) {
        expect(presets[name].bio, name).toEqual(expect.any(String));
        expect(presets[name].persona, name).toEqual(expect.any(String));
        expect(presets[name].bio, name).not.toBe(presets[name].persona);
      }
      for (const name of ['LocalCoordinator', 'Developer', 'Critic']) {
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
      for (const name of ['Developer', 'Critic']) {
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
      const coordinatorBytes = readFileSync('presets/fleet/roles/Coordinator.yaml');
      expect(createHash('sha256').update(coordinatorBytes).digest('hex'))
        .toBe('18b20d31ffe7dc90954a04aec60765102d5c4ea09068deb47729c8e81b22c1cd');
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

  it('default presentation generators contain no legacy executor labels', () => {
    for (const path of [
      'scripts/generate-report-mocks.mjs', 'scripts/generate-inbox-task-mocks.mjs',
      'scripts/generate-rich-task-mocks.mjs', 'scripts/generate-table-task-mocks.mjs',
    ]) expect(readFileSync(path, 'utf8'), path).not.toMatch(/\b(?:Secretary|Architect|Tester)\b/);
  });
});
