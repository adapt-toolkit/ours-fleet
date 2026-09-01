import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../src/harness/codex.js';
import { parseGroupedMemberArgs, prepareExecutionPlan, readMembersFile } from '../src/rooms-tasks/member-overrides.js';
import type { FleetConfig } from '../src/config.js';
import type { TemplateDefinition } from '../src/rooms-tasks/types.js';
import { cliMemberOverrides } from '../src/rooms-tasks/cli.js';

const template: TemplateDefinition = { name: 'pair', version: 1, description: 'pair', members: [
  { slot: 'dev', role: 'Developer', count: 1, agent_template: 'Dev' },
] };
const cfg = { roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
  watchdogs: [], loops: [], agentTemplates: { Dev: {
    role: { inline: { mission: 'base' } }, brain: { inline: { harness: 'codex', model: 'gpt-5.6-sol' } },
  } }, rolePresets: { Reviewer: { mission: 'review' } },
  brainPresets: { Fast: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'low' } },
  resolveAgentDefinition: (id: string, value: any) => ({ name: id,
    harness: value.brain.inline.harness, harness_options: value.brain.inline.harness_options,
    permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' },
    monitor: { mode: 'fleet' }, session: 'acp', role: value.role, brain: value.brain }),
} as unknown as FleetConfig;

describe('typed room member overrides', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  it('resolves Brain and Role presets inline with immutable provenance', () => {
    const plan = prepareExecutionPlan(template, cfg, { dev: { brain: 'Fast', role: 'Reviewer' } });
    expect(plan.launchDefinitions['dev:Dev']).toMatchObject({
      role: { inline: { mission: 'review' } },
      brain: { inline: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'low' } },
    });
    expect(plan.snapshot.members[0]).toMatchObject({
      brain_preset: { id: 'Fast', hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      role_preset: { id: 'Reviewer', hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it('rejects unsafe or malformed effective definitions before sealing', () => {
    expect(() => prepareExecutionPlan(template, cfg, { dev: { overrides: { identity: 'stolen' } } }))
      .toThrow('cannot override identity');
    expect(() => prepareExecutionPlan(template, cfg, { dev: { effort: 'impossible' } }))
      .toThrow();
    expect(() => prepareExecutionPlan(template, cfg, { dev: {
      overrides: { permissions: { filesystem: 'root' as never } },
    } })).toThrow('permissions.filesystem');
  });

  it('parses ordered Brain and Role fields and rejects fields before a member', () => {
    expect(parseGroupedMemberArgs(['--member', 'dev', '--brain', 'Fast', '--role', 'Reviewer']))
      .toEqual({ dev: { brain: 'Fast', role: 'Reviewer' } });
    expect(() => parseGroupedMemberArgs(['--brain', 'Fast'])).toThrow('must follow --member');
  });

  it('seals normalized Agent Template loops and supports an explicit member disable', () => {
    const withLoops = { ...cfg, agentTemplates: structuredClone(cfg.agentTemplates) };
    withLoops.agentTemplates!.Dev.loops = { progress: {
      interval: '1m', initial_delay: '0s', prompt: 'LOOP_PROMPT_CANARY',
    } };
    const inherited = prepareExecutionPlan(template, withLoops);
    expect(inherited.launchDefinitions['dev:Dev'].loops).toEqual({ progress: {
      enabled: true, interval: '1m', initial_delay: '0s', jitter: '0s',
      prompt: 'LOOP_PROMPT_CANARY',
    } });
    expect(inherited.snapshot.members[0].loop_source).toBe('agent-template');
    expect(JSON.stringify(inherited.snapshot)).not.toContain('LOOP_PROMPT_CANARY');
    expect(inherited.snapshot.members[0].agent_projection).toMatchObject({
      loops: { progress: { prompt: { bytes: 18, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } },
    });

    const disabled = prepareExecutionPlan(template, withLoops, { dev: { loops: false } });
    expect(disabled.launchDefinitions['dev:Dev'].loops).toBeUndefined();
    expect(disabled.snapshot.members[0].loop_source).toBe('cli');
    expect(disabled.overrides.dev.loops).toBe(false);
  });

  it('rejects contradictory generic and typed loop overrides', () => {
    expect(() => prepareExecutionPlan(template, cfg, { dev: {
      overrides: { loops: { hidden: { interval: '1m', prompt: 'x' } } },
    } })).toThrow('overrides.loops is unsupported');
  });

  it('accepts only bounded trusted members files', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-members-')); roots.push(root);
    const file = join(root, 'members.yaml');
    writeFileSync(file, 'members:\n  dev:\n    brain: Fast\n', { mode: 0o600 });
    expect(readMembersFile(file)).toEqual({ dev: { brain: 'Fast' } });
    chmodSync(file, 0o644);
    expect(() => readMembersFile(file)).toThrow('trusted regular file');
    chmodSync(file, 0o666);
    expect(() => readMembersFile(file)).toThrow('trusted regular file');
    const link = join(root, 'link.yaml'); symlinkSync(file, link);
    expect(() => readMembersFile(link)).toThrow('trusted regular file');
  });

  it('rejects mixing grouped members with a members file before reading it', () => {
    expect(() => cliMemberOverrides('/missing.yaml', ['--member', 'dev']))
      .toThrow('--members-file cannot be combined');
  });
});
