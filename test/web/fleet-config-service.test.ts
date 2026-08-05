import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FleetConfigService, REDACTED_ENV_VALUE,
} from '../../src/web/fleet-config-service.js';

describe('safe web fleet configuration service', () => {
  let dir: string;
  let file: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-web-config-'));
    file = join(dir, 'fleet.yaml');
    oldHome = process.env.OURS_FLEET_HOME;
    process.env.OURS_FLEET_HOME = dir;
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.OURS_FLEET_HOME;
    else process.env.OURS_FLEET_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips unknown safe top-level fields while redacting and restoring env secrets', async () => {
    writeFileSync(file, [
      'x_extension:', '  enabled: true', 'vars:', '  token: top-secret',
      'defaults:', '  harness: codex', '  session: acp', '  env:', '    API_TOKEN: ${token}',
      'roles:', '  Alpha:', '    mission: Ship safely', '    env:', '      PASSWORD: hunter2', '',
    ].join('\n'), { mode: 0o600 });
    let candidateExisted = false;
    const service = new FleetConfigService({ configPath: file, preflight: async path => {
      candidateExisted = existsSync(path);
      return { ok: true, checks: [{ name: 'config', ok: true, detail: 'valid' }] };
    } });
    const opened = service.read();
    expect(opened.model).toMatchObject({
      x_extension: { enabled: true }, vars: { token: REDACTED_ENV_VALUE },
      defaults: { env: { API_TOKEN: REDACTED_ENV_VALUE } },
      roles: { Alpha: { env: { PASSWORD: REDACTED_ENV_VALUE } } },
    });
    expect(JSON.stringify(opened)).not.toContain('top-secret');
    expect(JSON.stringify(opened)).not.toContain('hunter2');
    (opened.model.roles as any).Alpha.mission = 'Ship more safely';
    const preview = await service.preview(opened.revision, opened.model);
    expect(candidateExisted).toBe(true);
    expect(preview.diff).not.toContain('top-secret');
    expect(preview.diff).not.toContain('hunter2');
    expect(preview.impact.roles).toEqual(['Alpha']);
    const saved = await service.write(opened.revision, opened.model);
    expect(saved.backup).toMatch(/^fleet\.yaml\.backup-/);
    expect(readFileSync(file, 'utf8')).toContain('PASSWORD: hunter2');
    expect(readFileSync(file, 'utf8')).toContain('x_extension:');
    expect(readFileSync(join(dir, saved.backup!), 'utf8')).toContain('mission: Ship safely');
  });

  it('rejects duplicate YAML keys and authoritative config validation failures', async () => {
    writeFileSync(file, 'roles:\n  Alpha: {}\n  Alpha: {}\n', { mode: 0o600 });
    expect(() => new FleetConfigService({ configPath: file }).read()).toThrow(/Map keys must be unique/);
    writeFileSync(file, 'roles:\n  Alpha: {}\n', { mode: 0o600 });
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    (opened.model.roles as any).Alpha.typo_key = true;
    await expect(service.preview(opened.revision, opened.model)).rejects.toThrow(/unknown key/);
  });

  it('fails stale saves without changing the file or creating a backup', async () => {
    writeFileSync(file, 'roles:\n  Alpha: {}\n', { mode: 0o600 });
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    writeFileSync(file, 'roles:\n  Beta: {}\n', { mode: 0o600 });
    await expect(service.write(opened.revision, opened.model)).rejects.toThrow(/changed since it was opened/);
    expect(readFileSync(file, 'utf8')).toContain('Beta');
    expect(existsSync(`${file}.web-edit.lock`)).toBe(false);
  });

  it('leaves the current file untouched when preflight fails before atomic replacement', async () => {
    const original = 'roles:\n  Alpha: {}\n';
    writeFileSync(file, original, { mode: 0o600 });
    const service = new FleetConfigService({
      configPath: file, preflight: async () => { throw new Error('doctor unavailable'); },
    });
    const opened = service.read();
    (opened.model.roles as any).Beta = {};
    await expect(service.write(opened.revision, opened.model)).rejects.toThrow('doctor unavailable');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(existsSync(`${file}.web-edit.lock`)).toBe(false);
  });

  it('provides a valid first-run model without writing stable configuration', () => {
    const opened = new FleetConfigService({ configPath: file }).read();
    expect(opened).toMatchObject({ exists: false, firstRun: true, model: { roles: {} } });
    expect(existsSync(file)).toBe(false);
  });
});
