import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FleetConfigService, REDACTED_ENV_VALUE } from '../../src/web/fleet-config-service.js';
import { writeV2Fixture } from '../v2-fixture.js';

describe('split-document fleet configuration service', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-web-config-'));
    file = join(dir, 'fleet.yaml');
    writeV2Fixture(file, { roles: { Alpha: { harness: 'codex', session: 'acp' } } });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const agentPath = (id = 'Alpha') => join(dir, 'fleet', 'agents', `${id}.yaml`);
  const model = (service: FleetConfigService) => service.read();

  it('reads an explicit manifest + bare Agent map and no legacy roles map', () => {
    const opened = model(new FleetConfigService({ configPath: file }));
    expect(opened.model.manifest.api_version).toBe('ours.network/fleet/v2');
    expect(opened.model.agents.Alpha).toMatchObject({ brain: { inline: { harness: 'codex' } } });
    expect(opened.model).not.toHaveProperty('roles');
  });

  it('adds, edits, and deletes Agent documents and edits manifest automation', async () => {
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    opened.model.agents.Alpha.monitor = { mode: 'native' };
    opened.model.agents.Beta = {
      role: { inline: { mission: 'Review' } }, brain: { inline: { harness: 'claude-code' } },
    };
    opened.model.manifest.watchdogs = { health: { coordinator: 'Alpha', agent: {
      role: { inline: {} }, brain: { inline: { harness: 'codex' } },
    } } };
    opened.model.manifest.loops = { pass: { roles: ['*'], interval: '10m', prompt: 'check' } };
    const saved = await service.write(opened.revision, opened.model);
    expect(saved.diff).toContain('agents/Beta.yaml');
    expect(existsSync(agentPath('Beta'))).toBe(true);
    const second = service.read();
    delete second.model.agents.Alpha;
    await service.write(second.revision, second.model);
    expect(existsSync(agentPath())).toBe(false);
  });

  it.each([
    ['manifest', 'change'],
    ...(['agent', 'role', 'brain'] as const).flatMap(kind =>
      (['add', 'change', 'delete'] as const).map(operation => [kind, operation] as const)),
  ] as const)('stale-fails after a concurrent %s %s', async (kind, operation) => {
      const root = join(dir, 'fleet');
      const existing = kind === 'manifest' ? file : kind === 'agent' ? agentPath()
        : join(root, `${kind}s`, 'Preset.yaml');
      if (kind === 'role') {
        mkdirSync(join(root, 'roles'), { mode: 0o700 });
        writeFileSync(existing, 'mission: before\n', { mode: 0o600 });
      }
      if (kind === 'brain') {
        mkdirSync(join(root, 'brains'), { mode: 0o700 });
        writeFileSync(existing, 'harness: codex\n', { mode: 0o600 });
      }
      const service = new FleetConfigService({ configPath: file });
      const opened = service.read();
      const target = operation === 'add'
        ? kind === 'agent' ? agentPath('Added') : join(root, `${kind}s`, 'Added.yaml')
        : existing;
      if (operation === 'delete') rmSync(target);
      else if (operation === 'add') writeFileSync(target, kind === 'brain'
        ? 'harness: codex\n' : kind === 'role' ? 'mission: added\n'
          : 'role: { inline: {} }\nbrain: { inline: { harness: codex } }\n', { mode: 0o600 });
      else writeFileSync(target, `${readFileSync(target, 'utf8')}# concurrent\n`, { mode: 0o600 });
      await expect(service.write(opened.revision, opened.model)).rejects.toThrow(/changed since opened/);
  });

  it('recursively redacts secrets and restores markers only at their original paths', async () => {
    const raw = JSON.parse(JSON.stringify(model(new FleetConfigService({ configPath: file })).model));
    raw.agents.Alpha.brain.inline.harness = 'claude-code';
    raw.agents.Alpha.brain.inline.model_chain = ['claude-sonnet-5'];
    raw.agents.Alpha.role.inline.mission = 'original mission';
    raw.manifest.vars = { token: 'manifest-secret' };
    raw.manifest.rooms = { owner: { expected_cid: 'a'.repeat(64), public_invite: 'invite-secret' } };
    raw.agents.Alpha.env = { PASSWORD: 'hunter2' };
    raw.agents.Alpha.auth_proxy = {
      kind: 'anthropic', base_url: 'http://127.0.0.1:9999/auth-secret', required: true,
    };
    raw.agents.Alpha.isolation = { secrets: ['key-secret:/run/secrets/key'] };
    writeFileSync(file, stringify(raw.manifest), { mode: 0o600 });
    writeFileSync(agentPath(), stringify(raw.agents.Alpha), { mode: 0o600 });
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    const json = JSON.stringify(opened);
    for (const secret of ['manifest-secret', 'hunter2', 'auth-secret', 'invite-secret', 'key-secret'])
      expect(json).not.toContain(secret);
    expect(json).toContain(REDACTED_ENV_VALUE);
    opened.model.agents.Alpha.role = { inline: { mission: 'changed' } };
    const preview = await service.preview(opened.revision, opened.model);
    for (const secret of ['manifest-secret', 'hunter2', 'auth-secret', 'invite-secret', 'key-secret'])
      expect(JSON.stringify(preview)).not.toContain(secret);
    (opened.model.agents.Alpha as any).new_token = REDACTED_ENV_VALUE;
    await expect(service.preview(opened.revision, opened.model)).rejects.toThrow(/no prior redacted value/);
    const scalarMisuse = structuredClone(service.read().model);
    (scalarMisuse.agents.Alpha.role as any).inline.mission = REDACTED_ENV_VALUE;
    await expect(service.preview(service.read().revision, scalarMisuse)).rejects.toThrow(/no prior redacted value/);
    const arrayMisuse = service.read();
    ((arrayMisuse.model.agents.Alpha.brain as any).inline.model_chain as string[])[0]
      = REDACTED_ENV_VALUE;
    await expect(service.preview(arrayMisuse.revision, arrayMisuse.model))
      .rejects.toThrow(/no prior redacted value/);

    const leakingPreflight = new FleetConfigService({ configPath: file, preflight: async () => {
      throw new Error('failed near hunter2 and invite-secret');
    } });
    const reopened = leakingPreflight.read();
    await expect(leakingPreflight.preview(reopened.revision, reopened.model)).rejects.not.toThrow(/hunter2|invite-secret/);
  });

  it('stages exact stem layout so Role/Brain refs and briefing files validate', async () => {
    const root = join(dir, 'fleet');
    mkdirSync(join(root, 'roles'), { mode: 0o700 });
    mkdirSync(join(root, 'brains'), { mode: 0o700 });
    writeFileSync(join(root, 'roles', 'Worker.yaml'), 'mission: Work\nbriefing_file: brief.md\n', { mode: 0o600 });
    writeFileSync(join(root, 'roles', 'brief.md'), 'brief\n', { mode: 0o600 });
    writeFileSync(join(root, 'brains', 'Codex.yaml'), 'harness: codex\n', { mode: 0o600 });
    writeFileSync(agentPath(), stringify({ role: { ref: 'Worker' }, brain: { ref: 'Codex' } }), { mode: 0o600 });
    let stagedPath = ''; let stagedLayout = false;
    const service = new FleetConfigService({ configPath: file, preflight: async path => {
      stagedPath = path;
      stagedLayout = existsSync(join(path.slice(0, -5), 'roles', 'Worker.yaml'))
        && existsSync(join(path.slice(0, -5), 'brains', 'Codex.yaml'));
      return { ok: true, checks: [] };
    } });
    const opened = service.read();
    await expect(service.preview(opened.revision, opened.model)).resolves.toMatchObject({ valid: true });
    expect(stagedPath.endsWith('/fleet.yaml')).toBe(true);
    expect(stagedLayout).toBe(true);
  });

  it('refuses symlink and permissive sources', () => {
    const real = agentPath();
    const content = readFileSync(real, 'utf8');
    rmSync(real); writeFileSync(join(dir, 'outside.yaml'), content, { mode: 0o600 });
    symlinkSync(join(dir, 'outside.yaml'), real);
    expect(() => model(new FleetConfigService({ configPath: file }))).toThrow(/non-symlink/);
    rmSync(real); writeFileSync(real, content, { mode: 0o622 }); chmodSync(real, 0o622);
    expect(() => model(new FleetConfigService({ configPath: file }))).toThrow(/group\/world writable/);
  });

  it('rolls back every document when a later replacement fails', async () => {
    const beforeManifest = readFileSync(file, 'utf8');
    const beforeAgent = readFileSync(agentPath(), 'utf8');
    const service = new FleetConfigService({ configPath: file, beforeMutation(_rel, index) {
      if (index === 1) throw new Error('injected failure');
    } });
    const opened = service.read();
    opened.model.manifest.vars = { work: '/new' };
    opened.model.agents.Alpha.monitor = { mode: 'native' };
    await expect(service.write(opened.revision, opened.model)).rejects.toThrow(/injected failure/);
    expect(readFileSync(file, 'utf8')).toBe(beforeManifest);
    expect(readFileSync(agentPath(), 'utf8')).toBe(beforeAgent);
  });

  it.each(['add', 'delete'] as const)('detects an under-lock %s collision', async operation => {
    let service!: FleetConfigService;
    service = new FleetConfigService({ configPath: file, preflight: async () => {
      const target = operation === 'add' ? agentPath('Beta') : agentPath();
      writeFileSync(target, 'role: { inline: { mission: concurrent } }\nbrain: { inline: { harness: codex } }\n', { mode: 0o600 });
      return { ok: true, checks: [] };
    } });
    const opened = service.read();
    if (operation === 'add')
      opened.model.agents.Beta = { role: { inline: {} }, brain: { inline: { harness: 'codex' } } };
    else delete opened.model.agents.Alpha;
    await expect(service.write(opened.revision, opened.model)).rejects.toThrow(/changed since opened|collision/);
  });

  it('keeps a no-op byte-identical and creates no backup', async () => {
    const before = readFileSync(agentPath(), 'utf8');
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    const saved = await service.write(opened.revision, opened.model);
    expect(saved.diff).toBe(''); expect(saved.backup).toBeUndefined();
    expect(readFileSync(agentPath(), 'utf8')).toBe(before);
    expect(readdirSync(dir).some(name => name.startsWith('.fleet-web-backup-'))).toBe(false);
  });
});
