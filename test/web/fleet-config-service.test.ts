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

  it('preserves comments, blank lines and formatting when saving an edited role', async () => {
    const original = [
      '# fleet.yaml — this header belongs to the operator.',
      '#',
      '#   ours-fleet up            create/start every role',
      '',
      'vars:',
      '  work_root: /home/me/work',
      '',
      'defaults:',
      '  harness: claude-code        # adapter for roles without their own',
      '  session: acp                # only supported session',
      '',
      'roles:',
      '',
      '  # Coordinator routes work to the others.',
      '  Alice:',
      '    mission: Ship safely',
      '    cwd: ${work_root}/alpha',
      '',
      '  Bob:',
      '    mission: Review',
      '',
    ].join('\n');
    writeFileSync(file, original, { mode: 0o600 });
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    (opened.model.roles as any).Alice.mission = 'Ship even more safely';

    await service.write(opened.revision, opened.model);
    const saved = readFileSync(file, 'utf8');

    expect(saved).toContain('# fleet.yaml — this header belongs to the operator.');
    expect(saved).toContain('#   ours-fleet up            create/start every role');
    expect(saved).toContain('  # Coordinator routes work to the others.');
    expect(saved).toContain('  harness: claude-code        # adapter for roles without their own');
    expect(saved).toContain('  session: acp                # only supported session');
    expect(saved).toContain('    cwd: ${work_root}/alpha');
    expect(saved).toContain('mission: Ship even more safely');
    // Exactly one line changed anywhere in the file.
    const before = original.split('\n');
    const after = saved.split('\n');
    expect(after.length).toBe(before.length);
    expect(after.filter((line, index) => line !== before[index]))
      .toEqual(['    mission: Ship even more safely']);
  });

  it('reviews changes as a bounded hunk of the real file rather than the whole model', async () => {
    const lines = ['# operator header', 'roles:'];
    for (let index = 0; index < 40; index += 1) lines.push(`  Role${index}:`, `    mission: m${index}`);
    writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    (opened.model.roles as any).Role20.mission = 'changed';

    const preview = await service.preview(opened.revision, opened.model);

    expect(preview.diff).toContain('--- fleet.yaml (current)');
    expect(preview.diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    expect(preview.diff).toContain('-    mission: m20');
    expect(preview.diff).toContain('+    mission: changed');
    expect(preview.diff).not.toContain('m39');
    expect(preview.diff.split('\n').length).toBeLessThan(15);
  });

  it('adds a watchdog block to a commented base file without rewriting it', async () => {
    const original = [
      '# Keep this note.', 'roles:', '  Alice:', '    mission: Ship', '',
    ].join('\n');
    writeFileSync(file, original, { mode: 0o600 });
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    (opened.model as any).watchdogs = { health: { coordinator: 'Alice' } };

    const saved = await service.write(opened.revision, opened.model);
    const text = readFileSync(file, 'utf8');

    expect(saved.impact.watchdogScheduler).toBe(true);
    expect(text).toContain('# Keep this note.');
    expect(text).toContain('watchdogs:');
    expect(text).toContain('    coordinator: Alice');
    expect(text.indexOf('roles:')).toBeLessThan(text.indexOf('watchdogs:'));
  });

  /**
   * Rebuild the proposed file from a unified hunk. Used to prove the reviewed
   * diff describes exactly the bytes that reach disk.
   */
  const applyHunk = (before: string, diff: string): string => {
    const lines = diff.split('\n');
    const header = lines.findIndex(line => line.startsWith('@@'));
    const [, start, length] = /^@@ -(\d+),(\d+) /.exec(lines[header])!.map(Number);
    const body = lines.slice(header + 1).filter(line => line !== '');
    const kept = body.filter(line => line.startsWith(' ') || line.startsWith('+')).map(line => line.slice(1));
    const source = before.split('\n');
    return [...source.slice(0, start - 1), ...kept, ...source.slice(start - 1 + length)].join('\n');
  };

  it('reviews a diff that reproduces exactly the bytes written to disk', async () => {
    const original = [
      '# operator header', 'vars:', '  token: top-secret', 'defaults:', '  env:',
      '    API_TOKEN: ${token}', '  harness: claude-code   # aligned note',
      'roles:', '  Alice:', '    mission: Ship safely', '    env:', '      PASSWORD: hunter2', '',
    ].join('\n');
    writeFileSync(file, original, { mode: 0o600 });
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    (opened.model.roles as any).Alice.mission = 'Ship even more safely';

    const preview = await service.preview(opened.revision, opened.model);
    const saved = await service.write(opened.revision, opened.model);
    const onDisk = readFileSync(file, 'utf8');

    // Same review before and after; both describe the same change.
    expect(saved.diff).toBe(preview.diff);
    // Applying the reviewed hunk to the redacted original reproduces the
    // redacted file that actually landed on disk, byte for byte.
    const mask = (text: string) => text
      .replace('top-secret', REDACTED_ENV_VALUE)
      .replace('${token}', REDACTED_ENV_VALUE)
      .replace('hunter2', REDACTED_ENV_VALUE);
    expect(applyHunk(mask(original), preview.diff)).toBe(mask(onDisk));
    // Secrets stayed on the host; the real file kept them.
    expect(preview.diff).not.toContain('top-secret');
    expect(preview.diff).not.toContain('hunter2');
    expect(onDisk).toContain('PASSWORD: hunter2');
    expect(onDisk).toContain('  harness: claude-code   # aligned note');
  });

  it('reports no diff and rewrites nothing when the model is unchanged', async () => {
    const original = readFileSync('examples/fleet.yaml', 'utf8');
    writeFileSync(file, original, { mode: 0o600 });
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();

    const preview = await service.preview(opened.revision, opened.model);
    expect(preview.diff).toBe('');

    const saved = await service.write(opened.revision, opened.model);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(saved.newRevision).toBe(saved.revision);
    expect(saved.impact.required).toBe(false);
  });

  it('shows reflow in the diff instead of hiding it behind redaction', async () => {
    // A block scalar cannot be spliced, so this edit falls back to re-rendering
    // the document. Any layout the re-render disturbs must be visible in review.
    const original = [
      'vars:', '  token: top-secret', 'defaults:', '  env:', '    API_TOKEN: ${token}',
      '  permissions:            # this note sits on a block key',
      '    approval: ask', 'roles:', '  Alice:', '    persona: |', '      One.', '      Two.', '',
    ].join('\n');
    writeFileSync(file, original, { mode: 0o600 });
    const service = new FleetConfigService({ configPath: file });
    const opened = service.read();
    (opened.model.roles as any).Alice.persona = 'Replaced.\n';

    const preview = await service.preview(opened.revision, opened.model);
    await service.write(opened.revision, opened.model);
    const onDisk = readFileSync(file, 'utf8');

    expect(preview.diff).toContain('-  permissions:            # this note sits on a block key');
    expect(applyHunk(
      original.replace('top-secret', REDACTED_ENV_VALUE).replace('${token}', REDACTED_ENV_VALUE),
      preview.diff,
    )).toBe(onDisk.replace('top-secret', REDACTED_ENV_VALUE).replace('${token}', REDACTED_ENV_VALUE));
  });

  describe('list and automation edits through the real save path', () => {
    const AUTOMATED = [
      '# operator header', 'roles:', '  Alice:', '    session: acp', '    mission: Ship',
      '    oversee:', '      - { role: Bob, interval: 5m }', '  Bob:', '    mission: Review',
      'watchdogs:', '  health:', '    coordinator: Alice', '    watch:', '      - Alice',
      '    interval: 10m', 'loops:', '  nightly:', '    roles: [Alice]', '    interval: 10m',
      '    enabled: false', '    prompt: Check in.', '',
    ].join('\n');

    const save = async (mutate: (model: any) => void) => {
      writeFileSync(file, AUTOMATED, { mode: 0o600 });
      const service = new FleetConfigService({ configPath: file });
      const opened = service.read();
      mutate(opened.model);
      // preview and write both run the real loader over the candidate; a config
      // this rejects never reaches disk, so reaching here means it is valid.
      const preview = await service.preview(opened.revision, opened.model);
      const saved = await service.write(opened.revision, opened.model);
      return { preview, saved, text: readFileSync(file, 'utf8') };
    };

    it('grows a watchdog watch list without gluing the following line', async () => {
      const { text, preview, saved } = await save(model => { model.watchdogs.health.watch.push('Bob'); });

      expect(text).toContain('    watch:\n      - Alice\n      - Bob\n    interval: 10m\n');
      expect(text).toContain('# operator header');
      expect(saved.diff).toBe(preview.diff);
    });

    it('shrinks an oversee list to empty and stays loadable', async () => {
      const { text } = await save(model => { model.roles.Alice.oversee = []; });

      expect(text).toContain('    oversee: []\n  Bob:\n    mission: Review\n');
      expect(text).toContain('    mission: Ship');
    });

    it('retargets a loop role list', async () => {
      const { text } = await save(model => { model.loops.nightly.roles = ['Alice', 'Bob']; });

      expect(text).toContain('    roles: [ Alice, Bob ]\n    interval: 10m\n');
    });

    it('removes the last watchdog as an empty mapping, not a null block', async () => {
      const { text } = await save(model => { delete model.watchdogs.health; });

      expect(text).toContain('\nwatchdogs: {}\n');
      expect(text).not.toContain('coordinator: Alice');
      expect(text).toContain('loops:\n  nightly:');
    });

    it('removes the last loop as an empty mapping, not a null block', async () => {
      const { text } = await save(model => { delete model.loops.nightly; });

      expect(text).toContain('\nloops: {}\n');
      expect(text).not.toContain('prompt: Check in.');
      expect(text).toContain('watchdogs:\n  health:');
    });
  });

  it('provides a valid first-run model without writing stable configuration', () => {
    const opened = new FleetConfigService({ configPath: file }).read();
    expect(opened).toMatchObject({ exists: false, firstRun: true, model: { roles: {} } });
    expect(existsSync(file)).toBe(false);
  });
});
