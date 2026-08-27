import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatePrepared, legacyAcpIntegrityDigest, LegacyAcpPreparationAuthority,
  type LegacyAcpAttemptInput, type LegacyAcpRuntimeContext,
} from '../src/harness/acp-attempt.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function input(): LegacyAcpAttemptInput {
  const value = {
    schemaVersion: 1 as const, roleName: 'Secretary', harness: 'codex' as const,
    identityName: 'secretary', lifetime: 'temporary' as const,
    permissions: { approval: 'auto', filesystem: 'workspace', unattended: 'deny' },
    nativePermissions: { approvalMode: 'on-request', filesystemMode: 'workspace', unattendedMode: 'deny', exact: true },
    isolationRequested: false, scheduling: {},
    adapterOptions: { harness: 'codex' as const, launcher: 'auto' as const, search: false, addDirs: [], config: {} },
  };
  return { ...value, integrityDigest: legacyAcpIntegrityDigest(value) };
}

function context(secret = 'never-persist'): LegacyAcpRuntimeContext {
  const stateDir = mkdtempSync(join(tmpdir(), 'acp-attempt-')); dirs.push(stateDir);
  return { stateDir, runCwd: stateDir, baseEnv: { SECRET: secret }, sessionMode: 'fresh', sessionId: 'session-1' };
}

describe('legacy ACP attempt authority', () => {
  it('validates, probes, atomically publishes, pretrusts, then issues exact opaque evidence', async () => {
    const order: string[] = []; const adapter = {};
    const authority = new LegacyAcpPreparationAuthority(adapter, {
      translate: () => { order.push('translate'); return { argv: ['agent'], env: { SAFE: '1' },
        files: [{ name: '.overlay.json', contents: '{"ok":true}' }] }; },
      probe: async () => { order.push('probe'); return { adapterId: 'codex-acp', adapterVersion: '1.1.7',
        artifactDigest: `sha256:${'a'.repeat(64)}` }; },
      pretrust: async () => { order.push('pretrust'); return true; },
    });
    const attempted = input(); const runtime = context();
    const evidence = await authority.prepare(attempted, runtime);
    const authenticated = authenticatePrepared(authority, adapter, evidence, attempted, runtime);
    expect(authenticated).toMatchObject({ argv: ['agent'], env: { SECRET: 'never-persist', SAFE: '1' },
      hostEffect: 'pretrust_applied' });
    expect(readFileSync(join(runtime.stateDir, '.overlay.json'), 'utf8')).toBe('{"ok":true}');
    expect(order).toEqual(['translate', 'probe', 'pretrust']);
    expect(authenticatePrepared(new LegacyAcpPreparationAuthority(adapter, {
      translate: vi.fn(), probe: vi.fn(),
    }), adapter, evidence, attempted, runtime)).toBeUndefined();
    expect(authenticatePrepared(authority, {}, evidence, attempted, runtime)).toBeUndefined();
    expect(JSON.stringify(evidence)).not.toContain('SECRET');
  });

  it.each([
    ['roleName', ''], ['harness', 'other'], ['lifetime', 'forever'],
    ['identityName', 'bad\nidentity'], ['integrityDigest', 7],
    ['integrityDigest', { toString: () => { throw new Error('must not execute'); } }],
    ['permissions', { approval: 'maybe', filesystem: 'workspace', unattended: 'deny' }],
    ['nativePermissions', { approvalMode: 'on-request', filesystemMode: 'workspace', unattendedMode: 'deny', exact: 'yes' }],
    ['scheduling', { autocompactPct: 0 }],
    ['adapterOptions', { harness: 'codex', launcher: 'auto', search: 'yes', addDirs: [], config: {} }],
    ['acpCommand', ['ok', 7]],
    ['adapterOptions', { harness: 'codex', launcher: 'auto', profile: '', search: false, addDirs: [], config: {} }],
    ['adapterOptions', { harness: 'codex', launcher: 'auto', search: false, addDirs: [7], config: {} }],
    ['adapterOptions', { harness: 'codex', launcher: 'auto', search: false, addDirs: [], config: { bad: {} } }],
    ['adapterOptions', { harness: 'claude-code', plugins: { bad: 'yes' }, memPalace: true,
      memPalaceMidSessionAutosave: false, mcpServersOnly: false }],
    ['adapterOptions', { harness: 'claude-code', plugins: {}, memPalace: true,
      memPalaceMidSessionAutosave: false, mcpServers: { bad: { command: 7 } }, mcpServersOnly: false }],
  ] as const)('rejects malformed %s before translation, probe, or pretrust', async (key, bad) => {
    const translate = vi.fn(); const probe = vi.fn(); const pretrust = vi.fn();
    const authority = new LegacyAcpPreparationAuthority({}, { translate, probe, pretrust });
    const attempted = { ...input(),
      ...(key === 'adapterOptions' && (bad as { harness?: string }).harness === 'claude-code'
        ? { harness: 'claude-code' as const } : {}), [key]: bad } as unknown as LegacyAcpAttemptInput;
    await expect(authority.prepare(attempted, context())).rejects.toThrow();
    expect(translate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    expect(pretrust).not.toHaveBeenCalled();
  });

  it.each([
    ['symbol runtime key', (runtime: LegacyAcpRuntimeContext) => Object.defineProperty(runtime, Symbol('x'), { value: 1 })],
    ['runtime accessor', (runtime: LegacyAcpRuntimeContext) => Object.defineProperty(runtime, 'sessionId', { enumerable: true, get: () => 'x' })],
    ['non-string environment', (runtime: LegacyAcpRuntimeContext) => { (runtime.baseEnv as Record<string, unknown>).BAD = 7; }],
    ['numeric session id', (runtime: LegacyAcpRuntimeContext) => { (runtime as unknown as { sessionId: number }).sessionId = 1; }],
    ['hostile session id', (runtime: LegacyAcpRuntimeContext) => { (runtime as unknown as { sessionId: object }).sessionId = {
      toString: () => { throw new Error('must not execute'); },
    }; }],
  ])('rejects %s before callbacks', async (_label, mutate) => {
    const runtime = context(); mutate(runtime);
    const translate = vi.fn(); const probe = vi.fn();
    await expect(new LegacyAcpPreparationAuthority({}, { translate, probe }).prepare(input(), runtime)).rejects.toThrow();
    expect(translate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    [{ argv: [], env: {} }, /argv/u],
    [{ argv: ['agent'], env: { 'BAD KEY': 'x' } }, /env/u],
    [{ argv: ['agent'], env: {}, files: [{ name: 'x', contents: 'x', mode: 0o777 }] }, /overlay/u],
    [{ argv: ['agent'], env: {}, sessionMeta: { nested: { bad: Infinity } } }, /finite/u],
    [{ argv: ['agent'], env: {}, mcpServers: [{ name: 'x', command: 'cmd', args: [7], env: [] }] }, /MCP/u],
    [{ argv: ['agent'], env: { HUGE: 'x'.repeat(4097) },
      files: [{ name: 'large', contents: 'x'.repeat(8192) }] }, /env/u],
    [{ argv: ['agent'], env: {}, sessionMeta: { huge: 'x'.repeat(4097) },
      files: [{ name: 'large', contents: 'x'.repeat(8192) }] }, /string exceeds bounds/u],
  ])('rejects malformed translation before probe and pretrust', async (translation, message) => {
    const probe = vi.fn(); const pretrust = vi.fn();
    const authority = new LegacyAcpPreparationAuthority({}, {
      translate: () => translation, probe, pretrust,
    });
    await expect(authority.prepare(input(), context())).rejects.toThrow(message);
    expect(probe).not.toHaveBeenCalled(); expect(pretrust).not.toHaveBeenCalled();
  });

  it.each([
    ['oversized overlay name', 'x'.repeat(4097)],
    ['hostile overlay name', { toString: () => { throw new Error('must not execute'); } }],
  ])('rejects %s before path handling, probe, publication, or pretrust', async (_label, name) => {
    const runtime = context(); const probe = vi.fn(); const pretrust = vi.fn();
    const authority = new LegacyAcpPreparationAuthority({}, {
      translate: () => ({ argv: ['agent'], env: {}, files: [{ name: name as string, contents: 'x' }] }),
      probe, pretrust,
    });
    await expect(authority.prepare(input(), runtime)).rejects.toThrow(/overlay/u);
    expect(probe).not.toHaveBeenCalled(); expect(pretrust).not.toHaveBeenCalled();
    expect(readdirSync(runtime.stateDir)).toEqual([]);
  });

  it('rejects translation accessors/cycles and artifact extras/accessors before host effects', async () => {
    const pretrust = vi.fn();
    const cycle: Record<string, unknown> = { argv: ['agent'], env: {} }; cycle.sessionMeta = cycle;
    const accessor = Object.defineProperty({ argv: ['agent'], env: {} }, 'sessionMeta', {
      enumerable: true, get: () => ({ secret: true }),
    });
    for (const translation of [cycle, accessor]) {
      const probe = vi.fn();
      await expect(new LegacyAcpPreparationAuthority({}, {
        translate: () => translation as never, probe, pretrust,
      }).prepare(input(), context())).rejects.toThrow();
      expect(probe).not.toHaveBeenCalled();
    }
    for (const artifact of [
      { adapterId: 'codex-acp', adapterVersion: '1.1.7', artifactDigest: `sha256:${'a'.repeat(64)}`, extra: true },
      Object.defineProperty({ adapterId: 'codex-acp', adapterVersion: '1.1.7',
        artifactDigest: `sha256:${'a'.repeat(64)}` }, 'adapterVersion', { enumerable: true, get: () => '1.1.7' }),
      { adapterId: 1, adapterVersion: 1, artifactDigest: `sha256:${'a'.repeat(64)}` },
      { adapterId: { toString: () => { throw new Error('must not execute'); } },
        adapterVersion: '1.1.7', artifactDigest: `sha256:${'a'.repeat(64)}` },
    ]) {
      await expect(new LegacyAcpPreparationAuthority({}, {
        translate: () => ({ argv: ['agent'], env: {} }), probe: async () => artifact as never, pretrust,
      }).prepare(input(), context())).rejects.toThrow();
    }
    expect(pretrust).not.toHaveBeenCalled();
  });

  it('fails closed on invalid artifacts and uncertain or throwing pretrust', async () => {
    for (const pretrust of [vi.fn(async () => false), vi.fn(async () => { throw new Error('secret'); })]) {
      const runtime = context();
      const authority = new LegacyAcpPreparationAuthority({}, {
        translate: () => ({ argv: ['agent'], env: {} }),
        probe: async () => ({ adapterId: 'codex-acp', adapterVersion: '1.1.7', artifactDigest: `sha256:${'c'.repeat(64)}` }),
        pretrust,
      });
      await expect(authority.prepare(input(), runtime)).rejects.toThrow();
    }
    const pretrust = vi.fn();
    const invalid = new LegacyAcpPreparationAuthority({}, {
      translate: () => ({ argv: ['agent'], env: {} }),
      probe: async () => ({ adapterId: 'codex-acp', adapterVersion: '1.1.7', artifactDigest: 'not-a-digest' }),
      pretrust,
    });
    await expect(invalid.prepare(input(), context())).rejects.toThrow(/artifact/u);
    expect(pretrust).not.toHaveBeenCalled();
  });

  it('keeps the canonical overlay on short-write failure and rejects symlink targets', async () => {
    const runtime = context(); const target = join(runtime.stateDir, '.overlay.json');
    writeFileSync(target, 'old');
    const authority = new LegacyAcpPreparationAuthority({}, {
      translate: () => ({ argv: ['agent'], env: {}, files: [{ name: '.overlay.json', contents: 'new' }] }),
      probe: async () => ({ adapterId: 'codex-acp', adapterVersion: '1.1.7', artifactDigest: `sha256:${'d'.repeat(64)}` }),
    }, { writeSync: () => 0 });
    await expect(authority.prepare(input(), runtime)).rejects.toThrow(/no progress/u);
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(runtime.stateDir).filter(name => name.endsWith('.tmp'))).toEqual([]);

    rmSync(target); symlinkSync(join(runtime.stateDir, 'elsewhere'), target);
    await expect(authority.prepare(input(), runtime)).rejects.toThrow(/symlink/u);
  });

  it('never pretrusts after a later overlay publication failure', async () => {
    const runtime = context(); const pretrust = vi.fn(); let calls = 0;
    const authority = new LegacyAcpPreparationAuthority({}, {
      translate: () => ({ argv: ['agent'], env: {}, files: [
        { name: 'first', contents: 'one' }, { name: 'second', contents: 'two' },
      ] }),
      probe: async () => ({ adapterId: 'codex-acp', adapterVersion: '1.1.7', artifactDigest: `sha256:${'f'.repeat(64)}` }),
      pretrust,
    }, { writeSync: (fd, buffer, offset, length) => {
      calls += 1; return calls === 2 ? 0 : writeSync(fd, buffer, offset, length);
    } });
    await expect(authority.prepare(input(), runtime)).rejects.toThrow(/no progress/u);
    expect(readFileSync(join(runtime.stateDir, 'first'), 'utf8')).toBe('one');
    expect(existsSync(join(runtime.stateDir, 'second'))).toBe(false);
    expect(pretrust).not.toHaveBeenCalled();
  });

  it('binds the exact base environment reference and preserves real CODEX_PATH without serializing it', async () => {
    const adapter = {}; const runtime = context('top-secret');
    runtime.baseEnv.CODEX_PATH = '/real/codex';
    const authority = new LegacyAcpPreparationAuthority(adapter, {
      translate: () => ({ argv: ['agent'], env: { CODEX_PATH: '/proxy/codex' } }),
      probe: async () => ({ adapterId: 'codex-acp', adapterVersion: '1.1.7', artifactDigest: `sha256:${'e'.repeat(64)}` }),
    });
    const attempted = input(); const evidence = await authority.prepare(attempted, runtime);
    expect(authenticatePrepared(authority, adapter, evidence, attempted, runtime)?.env)
      .toMatchObject({ CODEX_PATH: '/proxy/codex', OURS_FLEET_REAL_CODEX_PATH: '/real/codex' });
    expect(JSON.stringify(evidence)).not.toContain('top-secret');
    runtime.baseEnv.SECRET = 'mutated';
    expect(authenticatePrepared(authority, adapter, evidence, attempted, runtime)).toBeUndefined();
    expect(authenticatePrepared(authority, adapter, evidence, attempted, { ...runtime, baseEnv: { ...runtime.baseEnv } }))
      .toBeUndefined();
  });

  it('preserves optional model/effort absence and rejects structural forgery, mutation and path escape', async () => {
    const adapter = {}; const runtime = context(); const attempted = input();
    const authority = new LegacyAcpPreparationAuthority(adapter, {
      translate: () => ({ argv: ['agent'], env: {} }),
      probe: async () => ({ adapterId: 'codex-acp', adapterVersion: '1.1.7', artifactDigest: `sha256:${'b'.repeat(64)}` }),
    });
    const evidence = await authority.prepare(attempted, runtime);
    expect(authenticatePrepared(authority, adapter, {} as typeof evidence, attempted, runtime)).toBeUndefined();
    expect(authenticatePrepared(authority, adapter, evidence, { ...attempted, roleName: 'Other' }, runtime)).toBeUndefined();
    expect(attempted.model).toBeUndefined(); expect(attempted.effort).toBeUndefined();
    const escaping = new LegacyAcpPreparationAuthority({}, {
      translate: () => ({ argv: ['agent'], env: {}, files: [{ name: '../escape', contents: 'x' }] }),
      probe: vi.fn(),
    });
    await expect(escaping.prepare(attempted, context())).rejects.toThrow(/overlay/u);
    expect(escaping).toBeDefined();
  });
});
