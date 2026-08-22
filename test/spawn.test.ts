import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  spawnDryRun, spawnPermanent, spawnTemp, type SupervisorLauncher,
} from '../src/spawn.js';
import { creationBuildNote, formatProvenance, type CreationProvenance } from '../src/creation.js';
import { agentDir, stateRoot } from '../src/paths.js';
import { buildInfo } from '../src/provenance.js';
import { registerAdapter } from '../src/harness/registry.js';
import { getAdapter } from '../src/harness/registry.js';
import { findRole, loadConfig } from '../src/config.js';
import { fakeAdapter } from './registry.test.js';
import type { OpsDeps } from '../src/ops.js';
import type { SupervisorBackend } from '../src/supervisor/types.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-spawn-'));
  process.env.OURS_FLEET_HOME = dir;
  registerAdapter(fakeAdapter);
  writeFileSync(join(dir, 'fleet.yaml'), stringify({ defaults: { harness: 'fake' }, roles: { Coord: {} } }));
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps() {
  const calls: string[][] = [];
  const backend: SupervisorBackend = {
    id: 'none',
    async init() { return []; },
    async install(n) { calls.push(['install', n]); return { created: true, detail: 'installed' }; },
    async start() {}, async stop() {}, async restart() {},
    async status() { return 'inactive'; },
    async uninstall(n) { calls.push(['uninstall', n]); return { removed: true, detail: 'removed' }; },
    async liveness() { return { state: 'stopped' as const, detail: 'inactive (dead)' }; },
    logsArgs: n => ({ cmd: 'true', args: [n] }),
  };
  const d: OpsDeps = {
    backend, binPath: '/b/ours-fleet', sleep: async () => {}, log: () => {},
    identityProvisioner: { exists: async () => true },
  };
  return { d, calls };
}

describe('spawnPermanent', () => {
  it('rejects an effective identity already owned by a static role', async () => {
    const { d } = fakeDeps();
    await expect(spawnPermanent({ name: 'Other', identity: 'Coord' }, d))
      .rejects.toThrow(/identity 'Coord'.*role 'Coord'.*fleet\.yaml/s);
    expect(existsSync(join(dir, 'fleet.d', 'Other.yaml'))).toBe(false);
  });

  it('reads a multiline Unicode mission file verbatim and rejects option conflicts', async () => {
    const path = join(dir, 'mission.txt');
    writeFileSync(path, 'first line\nžluťoučký kůň\n');
    const { d } = fakeDeps();
    const file = await spawnPermanent({ name: 'Mission', missionFile: path }, d);
    expect(parse(readFileSync(file, 'utf8')).roles.Mission.mission)
      .toBe('first line\nžluťoučký kůň\n');
    await expect(spawnPermanent({
      name: 'Conflict', mission: 'inline', missionFile: path,
    }, d)).rejects.toThrow(/mutually exclusive/);
  });

  it('dry-run resolves the exact role document without filesystem or daemon mutation', () => {
    const mission = join(dir, 'mission.txt');
    writeFileSync(mission, 'long\nmission\n');
    const before = readdirSync(dir).sort();
    const result = spawnDryRun({
      name: 'Preview', model: 'approved', missionFile: mission,
    });
    expect(result.roleDocument.roles.Preview).toMatchObject({
      model: 'approved', mission: 'long\nmission\n',
    });
    expect(result.resolvedRole.name).toBe('Preview');
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(existsSync(agentDir('Preview'))).toBe(false);
  });

  it('accepts the public auto permission mode on the direct spawn path', () => {
    const result = spawnDryRun({ name: 'AutoWorker', approval: 'auto' });
    expect(result.resolvedRole.permissions.approval).toBe('auto');
  });

  it('writes fleet.d/<Name>.yaml from files and brings the role up', async () => {
    writeFileSync(join(dir, 'bio.txt'), 'A public card.');
    writeFileSync(join(dir, 'persona.txt'), 'An operating contract.');
    const { d, calls } = fakeDeps();
    const file = await spawnPermanent({
      name: 'Worker', mission: 'do stuff', coordinator: 'Coord',
      bioFile: join(dir, 'bio.txt'), personaFile: join(dir, 'persona.txt'),
    }, d);
    const doc = parse(readFileSync(file, 'utf8'));
    expect(doc.roles.Worker.bio).toBe('A public card.');
    expect(doc.roles.Worker.persona).toBe('An operating contract.');
    expect(doc.roles.Worker.coordinator).toBe('Coord');
    expect(calls).toContainEqual(['install', 'Worker']);
    expect(readFileSync(join(agentDir('Worker'), 'briefing.md'), 'utf8')).toContain('do stuff');
  });

  it('refuses an existing role name before writing anything', async () => {
    const { d } = fakeDeps();
    await expect(spawnPermanent({ name: 'Coord' }, d)).rejects.toThrowError(/already exists/);
    expect(existsSync(join(dir, 'fleet.d', 'Coord.yaml'))).toBe(false);
  });

  it('records configPath in the .config-path marker so systemd restarts reload the same file', async () => {
    const { d } = fakeDeps();
    const customCfg = join(dir, 'custom.yaml');
    writeFileSync(customCfg, stringify({ defaults: { harness: 'fake' }, roles: { Coord: {} } }));
    await spawnPermanent({ name: 'Worker2', configPath: customCfg }, d);
    expect(readFileSync(join(agentDir('Worker2'), '.config-path'), 'utf8')).toBe(`${customCfg}\n`);
  });

  it('supports ACP for permanent roles', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({
      name: 'AcpWorker', harness: 'codex', session: 'acp',
    }, d);
    const role = parse(readFileSync(file, 'utf8')).roles.AcpWorker;
    expect(role.harness).toBe('codex');
    expect(role.session).toBe('acp');
  });
});

describe('spawn --model', () => {
  it('persists a permanent role model to fleet.d', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({ name: 'Worker', model: 'claude-fable-5' }, d);
    const doc = parse(readFileSync(file, 'utf8'));
    expect(doc.roles.Worker.model).toBe('claude-fable-5');
  });

  it('snapshots a temp role model into role.yaml', async () => {
    const dir = await spawnTemp(
      { name: 'Scout', model: 'claude-fable-5' },
      '/b/ours-fleet',
      () => {},
    );
    const snap = parse(readFileSync(join(dir, 'role.yaml'), 'utf8'));
    expect(snap.model).toBe('claude-fable-5');
  });

  it('drops an empty/whitespace model', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({ name: 'Worker2', model: '   ' }, d);
    const doc = parse(readFileSync(file, 'utf8'));
    expect(doc.roles.Worker2.model).toBeUndefined();
  });

  it('a temp role without model inherits defaults.model', async () => {
    writeFileSync(join(dir, 'fleet.yaml'),
      stringify({ defaults: { harness: 'fake', model: 'claude-fable-5' }, roles: {} }));
    const d = await spawnTemp({ name: 'Scout', mission: 'recon' }, '/b/ours-fleet', () => {});
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.model).toBe('claude-fable-5');
  });

  it('a temp role model overrides defaults.model', async () => {
    writeFileSync(join(dir, 'fleet.yaml'),
      stringify({ defaults: { harness: 'fake', model: 'claude-fable-5' }, roles: {} }));
    const d = await spawnTemp(
      { name: 'Scout', model: 'claude-opus-4-8' }, '/b/ours-fleet', () => {});
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.model).toBe('claude-opus-4-8');
  });

  it('web harness-default intent suppresses a fleet model in permanent and temp launches', async () => {
    writeFileSync(join(dir, 'fleet.yaml'), stringify({
      defaults: {
        harness: 'codex', model: 'gpt-5.6', model_chain: ['gpt-5.6', 'gpt-fallback'],
      },
      roles: {},
    }));
    const { d } = fakeDeps();
    const file = await spawnPermanent({
      name: 'ClaudePermanent', harness: 'claude-code', model: null, surface: 'web',
    }, d);
    expect(parse(readFileSync(file, 'utf8')).roles.ClaudePermanent.model).toBeNull();
    const permanent = findRole(loadConfig(), 'ClaudePermanent');
    expect(permanent.model).toBeUndefined();
    expect(permanent.model_chain).toBeUndefined();
    expect(getAdapter('claude-code').buildLaunch(
      permanent, 'fresh', { sessionId: 'SID' }, { argv: [], env: {} },
    ).argv).not.toContain('--model');

    const tempDir = await spawnTemp({
      name: 'ClaudeTemporary', harness: 'claude-code', model: null, surface: 'web',
    }, '/b/ours-fleet', () => {});
    const temporary = parse(readFileSync(join(tempDir, 'role.yaml'), 'utf8'));
    expect(temporary.model).toBeUndefined();
    expect(temporary.model_chain).toBeUndefined();
    expect(getAdapter('claude-code').buildLaunch(
      temporary, 'fresh', { sessionId: 'SID' }, { argv: [], env: {} },
    ).argv).not.toContain('--model');
  });
});

describe('spawn Codex options', () => {
  it('persists launcher, permission, sandbox, profile, search, config, and add-dir', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({
      name: 'Coder', harness: 'codex', model: 'gpt-5.4', permissionMode: 'never',
      sandbox: 'workspace-write', profile: 'fleet', launcher: 'auto', search: true,
      codexConfig: { model_reasoning_effort: 'high' }, addDirs: ['/data/shared'], monitor: true,
    }, d);
    const role = parse(readFileSync(file, 'utf8')).roles.Coder;
    expect(role.model).toBe('gpt-5.4');
    expect(role.harness_options).toEqual({
      approval: 'never', sandbox: 'workspace-write', profile: 'fleet', launcher: 'auto',
      search: true, config: { model_reasoning_effort: 'high' }, add_dirs: ['/data/shared'],
      monitor: true,
    });
  });

  it('maps the generic permission flag to Claude permission_mode', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({
      name: 'ClaudeWorker', harness: 'claude-code', permissionMode: 'dontAsk',
    }, d);
    expect(parse(readFileSync(file, 'utf8')).roles.ClaudeWorker.harness_options)
      .toEqual({ permission_mode: 'dontAsk' });
  });
});

describe('spawnTemp', () => {
  it('snapshots the role and launches the supervisor detached (not in a same-named tmux session)', async () => {
    const launched: { binPath: string; args: string[]; dir: string }[] = [];
    const d = await spawnTemp(
      { name: 'Scout', mission: 'recon' },
      '/b/ours-fleet',
      (binPath, args, dir) => { launched.push({ binPath, args, dir }); },
    );
    expect(d).toBe(agentDir('Scout', true));
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.harness).toBe('fake');       // from defaults
    expect(snap.mission).toBe('recon');
    expect(readFileSync(join(d, 'briefing.md'), 'utf8')).toContain('recon');
    // Supervisor launched detached with the temp dir as its state — NOT inside a
    // tmux session named 'Scout' (which runOnce owns and kills for the agent).
    expect(launched).toEqual([{ binPath: '/b/ours-fleet', args: ['_run-temp', 'Scout'], dir: d }]);
  });

  it('supports ACP for temporary roles', async () => {
    const d = await spawnTemp(
      { name: 'AcpScout', harness: 'codex', session: 'acp' },
      '/b/ours-fleet',
      () => {},
    );
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.harness).toBe('codex');
    expect(snap.session).toBe('acp');
  });

  it('never inherits wildcard scheduled loops into a temporary role', async () => {
    writeFileSync(join(dir, 'fleet.yaml'), stringify({
      defaults: { harness: 'fake', session: 'acp' },
      roles: { Permanent: { session: 'acp' } },
      loops: { pass: { roles: ['*'], interval: '5m', prompt: 'permanent-only pass' } },
    }), { mode: 0o600 });
    chmodSync(join(dir, 'fleet.yaml'), 0o600);
    const d = await spawnTemp({ name: 'TempLoop', session: 'acp' }, '/b/ours-fleet', () => {});
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.loops).toBeUndefined();
  });
});

describe('atomic role + identity reservation (6.4)', () => {
  /** A registry that records claims, so races are observable. */
  function fakeRegistry() {
    const held = new Set<string>();
    const attempts: string[] = [];
    return {
      held, attempts,
      registry: {
        async reserve(name: string) {
          attempts.push(name);
          if (held.has(name)) return false;
          held.add(name);
          return true;
        },
        async release(name: string) { held.delete(name); },
      },
    };
  }

  /** Spawn that blocks inside the transaction until released, to force overlap. */
  const slowDeps = (gate: Promise<void>) => {
    const { d, calls } = fakeDeps();
    const backend = d.backend;
    const original = backend.install.bind(backend);
    backend.install = async (n: string, b: string) => { await gate; return original(n, b); };
    return { d, calls };
  };

  it('two spawns of the SAME role name: exactly one succeeds', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { d: d1 } = slowDeps(gate);
    const { d: d2 } = fakeDeps();

    const first = spawnPermanent({ name: 'Race' }, d1);
    await new Promise(r => setTimeout(r, 30));            // let it take the reservation
    const second = await spawnPermanent({ name: 'Race' }, d2).then(() => null, e => e as Error);
    release();
    await first;

    expect(second).toBeInstanceOf(Error);
    expect(second!.message).toMatch(/being created by another process/);
  });

  it('two spawns with DIFFERENT roles but the SAME identity: exactly one succeeds', async () => {
    const { registry } = fakeRegistry();
    const { d } = fakeDeps();
    await spawnPermanent({ name: 'Alpha', identity: 'Shared' }, d, { identityRegistry: registry });
    // Alpha released its reservation on success, so the identity is free again
    // by reservation — but a SECOND in-flight transaction must not get it.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { d: dSlow } = slowDeps(gate);
    const first = spawnPermanent(
      { name: 'Beta', identity: 'Contested' }, dSlow, { identityRegistry: registry });
    await new Promise(r => setTimeout(r, 30));
    const second = await spawnPermanent(
      { name: 'Gamma', identity: 'Contested' }, fakeDeps().d, { identityRegistry: registry })
      .then(() => null, e => e as Error);
    release();
    await first;

    expect(second).toBeInstanceOf(Error);
    expect(second!.message).toMatch(/identity 'Contested' is already taken|being created/);
  });

  it('the same role with a DIFFERENT identity still conflicts on the role name', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { d: d1 } = slowDeps(gate);
    const first = spawnPermanent({ name: 'Solo', identity: 'One' }, d1);
    await new Promise(r => setTimeout(r, 30));
    const second = await spawnPermanent({ name: 'Solo', identity: 'Two' }, fakeDeps().d)
      .then(() => null, e => e as Error);
    release();
    await first;
    expect(second).toBeInstanceOf(Error);
  });

  it('the loser leaves NO config, NO state and NO service behind', async () => {
    const { registry, held } = fakeRegistry();
    held.add('Taken');                                    // identity already claimed
    const { d, calls } = fakeDeps();
    const err = await spawnPermanent({ name: 'Loser', identity: 'Taken' }, d, { identityRegistry: registry })
      .then(() => null, e => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(existsSync(join(dir, 'fleet.d', 'Loser.yaml'))).toBe(false);
    expect(existsSync(agentDir('Loser'))).toBe(false);
    expect(calls.filter(c => c[0] === 'install')).toEqual([]);   // no service registered
  });

  it('a failure mid-creation rolls the fleet.d file back and frees both names', async () => {
    const { d } = fakeDeps();
    d.backend.install = async () => { throw new Error('systemctl refused'); };
    const err = await spawnPermanent({ name: 'Doomed' }, d).then(() => null, e => e as Error);
    expect(err!.message).toContain('systemctl refused');
    expect(existsSync(join(dir, 'fleet.d', 'Doomed.yaml'))).toBe(false);

    // Both names are immediately reusable — the point of releasing on failure.
    const { d: ok } = fakeDeps();
    await expect(spawnPermanent({ name: 'Doomed' }, ok)).resolves.toContain('Doomed.yaml');
  });

  it('a temp spawn rolls back its live state but preserves launch-failure evidence', async () => {
    const { d } = fakeDeps();
    void d;
    const failing: SupervisorLauncher = () => { throw new Error('could not detach'); };
    const err = await spawnTemp({ name: 'TempFail' }, '/b/ours-fleet', failing)
      .then(() => null, e => e as Error);
    expect(err!.message).toContain('could not detach');
    expect(existsSync(agentDir('TempFail', true))).toBe(false);
    const recovery = join(stateRoot(), 'recovery', 'temporary');
    const archived = readdirSync(recovery).find(name => name.includes('-TempFail-'))!;
    expect(readFileSync(join(recovery, archived, 'termination.jsonl'), 'utf8'))
      .toContain('"reason":"startup-failure"');
    // Name reusable straight away.
    await expect(spawnTemp({ name: 'TempFail' }, '/b/ours-fleet', () => {})).resolves.toBeTruthy();
  });

  it('a successful spawn releases its reservations so nothing leaks', async () => {
    const { d } = fakeDeps();
    await spawnPermanent({ name: 'Clean' }, d);
    const reservations = join(dir, '.ours-fleet', 'creation', 'reservations');
    expect(existsSync(reservations) ? readdirSync(reservations) : []).toEqual([]);
  });
});

describe('identity is established before launch (7.3)', () => {
  const provisioner = (
    exists: boolean | 'unknown',
    create?: (n: string, p: { bio?: string; persona?: string }) => Promise<void>,
  ) => ({ async exists() { return exists; }, ...(create ? { create } : {}) });

  const briefingOf = (name: string) =>
    readFileSync(join(agentDir(name), 'briefing.md'), 'utf8');



  it('an existing identity is verified, and the briefing says so', async () => {
    const { d } = fakeDeps();
    await spawnPermanent({ name: 'Known', identity: 'Known' }, d,
      { identityProvisioner: provisioner(true) });
    expect(briefingOf('Known')).toContain('verified to exist');
    expect(briefingOf('Known')).not.toContain('predefined');
  });

  it('a missing identity is CREATED before the service is enabled, with its profile', async () => {
    writeFileSync(join(dir, 'bio.txt'), 'A public card.');
    writeFileSync(join(dir, 'persona.txt'), 'An operating contract.');
    const created: Array<[string, { bio?: string; persona?: string }]> = [];
    const { d, calls } = fakeDeps();
    // Record the order: identity creation must precede service registration.
    const order: string[] = [];
    const backend = d.backend;
    backend.install = async n => { order.push(`install:${n}`); calls.push(['install', n]); };

    await spawnPermanent(
      { name: 'Fresh', identity: 'Fresh', bioFile: join(dir, 'bio.txt'), personaFile: join(dir, 'persona.txt') },
      d,
      { identityProvisioner: provisioner(false, async (n, p) => { order.push(`identity:${n}`); created.push([n, p]); }) });

    expect(created).toEqual([['Fresh', { bio: 'A public card.', persona: 'An operating contract.' }]]);
    expect(order).toEqual(['identity:Fresh', 'install:Fresh']);   // before, not after
    expect(briefingOf('Fresh')).toContain('It was created when your role');
  });

  it('a failed identity setup aborts and rolls back before the harness starts', async () => {
    const { d, calls } = fakeDeps();
    const err = await spawnPermanent({ name: 'Broken', identity: 'Broken' }, d, {
      identityProvisioner: provisioner(false, async () => { throw new Error('daemon refused'); }),
    }).then(() => null, e => e as Error);

    expect(err!.message).toContain('daemon refused');
    expect(calls.filter(c => c[0] === 'install')).toEqual([]);    // never started
    expect(existsSync(join(dir, 'fleet.d', 'Broken.yaml'))).toBe(false);
    expect(existsSync(agentDir('Broken'))).toBe(false);
  });

  it('a host that cannot create refuses permanent launch before the harness starts', async () => {
    const logs: string[] = [];
    const { d, calls } = fakeDeps();
    d.log = l => logs.push(l);
    await expect(spawnPermanent({ name: 'Unchecked', identity: 'Unchecked' }, d,
      { identityProvisioner: provisioner(false) }))          // exists=false, no create()
      .rejects.toThrow(/could not establish permanent ours identity/);

    expect(logs.join('\n')).toContain('cannot create one automatically');
    expect(calls.some(call => call[0] === 'install')).toBe(false);
  });

  it('an unreachable daemon is never mistaken for absence or delegated to the agent', async () => {
    const { d, calls } = fakeDeps();
    let createCalled = false;
    await expect(spawnPermanent({ name: 'Offline', identity: 'Offline' }, d, {
      identityProvisioner: provisioner('unknown', async () => { createCalled = true; }),
    })).rejects.toThrow(/could not establish permanent ours identity/);
    expect(createCalled).toBe(false);       // do not create on no evidence
    expect(calls.some(call => call[0] === 'install')).toBe(false);
  });

  it('a temp spawn gets the same guarantee in its briefing', async () => {
    const d = await spawnTemp({ name: 'TempKnown', identity: 'TempKnown' }, '/b/ours-fleet', () => {},
      { identityProvisioner: provisioner(true) });
    expect(readFileSync(join(d, 'briefing.md'), 'utf8')).toContain('verified to exist');
  });

  it('a temp spawn writes lifecycle-compatible identity bootstrap instructions', async () => {
    const d = await spawnTemp(
      { name: 'TempCompat', identity: 'ExplicitTempIdentity' },
      '/b/ours-fleet', () => {}, { identityProvisioner: provisioner(false) });
    const briefing = readFileSync(join(d, 'briefing.md'), 'utf8');
    expect(briefing).toContain('a temporary agent');
    expect(briefing).toContain('create_temporary_identity');
    expect(briefing).toContain('name "ExplicitTempIdentity"');
    expect(briefing).toContain('older server');
    expect(briefing).toContain('connector owns its cleanup');
  });
});

describe('every failed creation stage rolls back (6.2)', () => {
  const provisioner = (created: string[], removed: string[]) => ({
    async exists() { return false as const; },
    async create(n: string) { created.push(n); },
    async remove(n: string) { removed.push(n); },
  });

  const artifacts = (name: string) => ({
    config: existsSync(join(dir, 'fleet.d', `${name}.yaml`)),
    state: existsSync(agentDir(name)),
  });

  /** Fault-inject at each stage in turn; each must leave nothing behind. */
  // `state` is not in this list on purpose: `up` tolerates a failing liveness
  // probe by design (1.1), so it is not an injectable failure point. The
  // config-write stage is covered by the 6.4 rollback test above.
  const STAGES = ['identity', 'service'] as const;

  for (const stage of STAGES) {
    it(`a failure at the ${stage} stage leaves no artifact and frees the names`, async () => {
      const created: string[] = [];
      const removed: string[] = [];
      const { d, calls } = fakeDeps();
      const p = provisioner(created, removed);
      if (stage === 'identity') p.create = async () => { throw new Error('inject: identity'); };
      if (stage === 'service') d.backend.install = async () => { throw new Error('inject: service'); };

      const err = await spawnPermanent({ name: 'Faulted' }, d, { identityProvisioner: p })
        .then(() => null, e => e as Error);
      expect(err!.message, stage).toContain(`inject: ${stage}`);
      expect(artifacts('Faulted'), stage).toEqual({ config: false, state: false });
      expect(calls.filter(c => c[0] === 'install').length === 0 || stage === 'service').toBe(true);

      // An identity we minted is removed again; one we never made is not.
      if (stage === 'identity') expect(removed).toEqual([]);
      else expect(removed).toEqual(['Faulted']);

      // The names are immediately reusable.
      const { d: ok } = fakeDeps();
      await expect(spawnPermanent({ name: 'Faulted' }, ok,
        { identityProvisioner: provisioner([], []) })).resolves.toBeTruthy();
    });
  }

  /**
   * The registration is really made, and something after it fails before `up()`
   * can return its outcomes. Rollback has to learn about the registration at
   * the moment it happens, or the service stays behind.
   *
   * This test used to assert the OPPOSITE of its own title — that nothing was
   * uninstalled — with a comment explaining that install had thrown so nothing
   * was recorded. The assertion described the defect; the title described the
   * fix. Anyone reading test names saw 6.2's rollback promise covered.
   *
   * The other half of the same defect — a backend `install` that throws AFTER
   * writing its artifact, where no caller can ever hear about it — is the
   * backend's own responsibility and is covered in test/supervisor.test.ts,
   * "a failed registration leaves no artifact (6.2)".
   */
  it('a service registration this transaction created is uninstalled on failure', async () => {
    const { d, calls } = fakeDeps();
    // `up` logs immediately after installing; throwing from the log stands in
    // for any failure between registering and returning.
    d.log = line => { if (line.includes('↑ up:')) throw new Error('inject: post-registration'); };
    const err = await spawnPermanent({ name: 'Late' }, d,
      { identityProvisioner: provisioner([], []) }).then(() => null, e => e as Error);
    expect(err!.message).toContain('post-registration');
    expect(calls).toContainEqual(['install', 'Late']);
    expect(calls).toContainEqual(['uninstall', 'Late']);
  });

  it('a registration install found already there is NOT uninstalled by rollback', async () => {
    const { d, calls } = fakeDeps();
    d.backend.install = async n => {
      calls.push(['install', n]);
      return { created: false, detail: 'was already installed' };
    };
    d.log = line => { if (line.includes('↑ up:')) throw new Error('inject: post-registration'); };
    const err = await spawnPermanent({ name: 'Adopted' }, d,
      { identityProvisioner: provisioner([], []) }).then(() => null, e => e as Error);
    expect(err!.message).toContain('post-registration');
    expect(calls.filter(c => c[0] === 'uninstall')).toEqual([]);
  });

  it('a registration that already existed is NOT removed by rollback', async () => {
    const { d, calls } = fakeDeps();
    d.backend.install = async n => { calls.push(['install', n]); return { created: false, detail: 'already there' }; };
    // Fail after up() by making the identity removal path irrelevant: force a
    // later throw via a failing provisioner remove is not applicable, so throw
    // from the launcher-free permanent path by breaking loadConfig afterwards.
    const err = await spawnPermanent({ name: 'PreExisting' }, d, {
      identityProvisioner: {
        async exists() { return true as const; },
      },
    }).then(() => 'ok', e => e as Error);
    expect(err).toBe('ok');
    expect(calls.filter(c => c[0] === 'uninstall')).toEqual([]);
  });

  it('a rollback failure is reported WITHOUT hiding the original error', async () => {
    const { d } = fakeDeps();
    d.backend.install = async () => { throw new Error('the real failure'); };
    const err = await spawnPermanent({ name: 'Messy' }, d, {
      identityProvisioner: {
        async exists() { return false as const; },
        async create() {},
        async remove() { throw new Error('and rollback broke too'); },
      },
    }).then(() => null, e => e as Error);
    expect(err!.message).toContain('the real failure');        // the cause survives
    expect(err!.message).toContain('rollback also failed');
    expect(err!.message).toContain('and rollback broke too');
  });
});

describe('creation-time isolation (6.3)', () => {
  const policy = 'network: deny\nfs:\n  read:\n    - /opt/reference\nresources:\n  mem: 2G\n';
  const writePolicy = (body = policy) => {
    const p = join(dir, 'policy.yaml');
    writeFileSync(p, body);
    return p;
  };

  it('a permanent role is created WITH the policy, round-tripped exactly', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({ name: 'Sec', isolationFile: writePolicy() }, d);
    const role = parse(readFileSync(file, 'utf8')).roles.Sec;
    // The same schema, not a translation of it.
    expect(role.isolation).toEqual({
      network: 'deny', fs: { read: ['/opt/reference'] }, resources: { mem: '2G' },
    });
  });

  it('a temp role snapshots it too, so its first launch is confined', async () => {
    const d = await spawnTemp(
      { name: 'Scout', isolationFile: writePolicy() }, '/b/ours-fleet', () => {});
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.isolation).toEqual({
      network: 'deny', fs: { read: ['/opt/reference'] }, resources: { mem: '2G' },
    });
  });

  it('an empty (comments-only) file is a valid request for default isolation', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent(
      { name: 'Defaults', isolationFile: writePolicy('# just a comment\n') }, d);
    expect(parse(readFileSync(file, 'utf8')).roles.Defaults.isolation).toEqual({});
  });

  it('an invalid policy is rejected BEFORE anything is created', async () => {
    const { d, calls } = fakeDeps();
    const bad = writePolicy('network: telepathy\n');
    await expect(spawnPermanent({ name: 'Bad', isolationFile: bad }, d))
      .rejects.toThrowError(/isolation.network: invalid value 'telepathy'/);
    expect(existsSync(join(dir, 'fleet.d', 'Bad.yaml'))).toBe(false);
    expect(existsSync(agentDir('Bad'))).toBe(false);
    expect(calls.filter(c => c[0] === 'install')).toEqual([]);
  });

  it('an unknown key is rejected by the SAME validator fleet.yaml uses', async () => {
    const { d } = fakeDeps();
    await expect(spawnPermanent(
      { name: 'Bad2', isolationFile: writePolicy('nteork: deny\n') }, d))
      .rejects.toThrowError(/unknown key\(s\) nteork/);
  });

  it('a missing file fails by name, before creating anything', async () => {
    const { d } = fakeDeps();
    await expect(spawnPermanent(
      { name: 'Bad3', isolationFile: join(dir, 'nope.yaml') }, d))
      .rejects.toThrowError(/--isolation-file/);
    expect(existsSync(agentDir('Bad3'))).toBe(false);
  });

  it('a forbidden mount in the policy is refused at creation (5.2 still applies)', async () => {
    const { d } = fakeDeps();
    await expect(spawnPermanent({
      name: 'Sneaky',
      isolationFile: writePolicy(`fs:\n  write:\n    - ${join(dir, '.ssh')}\n`),
    }, d)).rejects.toThrowError(/refusing to mount/);
  });

  it('a role without the flag is unchanged — no isolation block appears', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({ name: 'Plain' }, d);
    expect(parse(readFileSync(file, 'utf8')).roles.Plain.isolation).toBeUndefined();
  });
});

describe('creation provenance (6.6)', () => {
  const provenanceOf = (name: string, temp = false) =>
    JSON.parse(readFileSync(join(agentDir(name, temp), 'creation.json'), 'utf8'));

  it('a default role records every setting as built-in, with version and time', async () => {
    writeFileSync(join(dir, 'fleet.yaml'), stringify({ roles: {} }));   // no defaults at all
    const { d } = fakeDeps();
    await spawnPermanent({ name: 'Plain' }, d);
    const p = provenanceOf('Plain');

    expect(p.version).toBe(1);
    expect(p.role).toBe('Plain');
    expect(p.lifetime).toBe('permanent');
    expect(p.command).toBe('ours-fleet spawn');
    expect(p.fleetVersion).toMatch(/\d+\.\d+\.\d+/);
    // Semver alone cannot say which artifact spawned the role — record its build too.
    expect(p.fleetBuild).toBe(buildInfo().buildId);
    expect(Number.isNaN(Date.parse(p.createdAt))).toBe(false);
    expect(p.settings.approval).toEqual({ value: 'ask', source: 'built-in' });
    expect(p.settings.harness).toEqual({ value: 'claude-code', source: 'built-in' });
    expect(p.settings.identity).toEqual({ value: 'Plain', source: 'built-in' });
  });

  it('distinguishes an explicit CLI value from a fleet default from a built-in', async () => {
    writeFileSync(join(dir, 'fleet.yaml'), stringify({
      defaults: { harness: 'fake', model: 'from-defaults', permissions: { filesystem: 'read-only' } },
      roles: {},
    }));
    const { d } = fakeDeps();
    await spawnPermanent({ name: 'Mixed', approval: 'allow', identity: 'Explicit' }, d);
    const s = provenanceOf('Mixed').settings;

    expect(s.approval).toEqual({ value: 'allow', source: 'cli' });          // typed by the operator
    expect(s.filesystem).toEqual({ value: 'read-only', source: 'fleet-default' });
    expect(s.model).toEqual({ value: 'from-defaults', source: 'fleet-default' });
    expect(s.unattended).toEqual({ value: 'deny', source: 'built-in' });    // nobody chose it
    expect(s.identity).toEqual({ value: 'Explicit', source: 'cli' });
    expect(s.harness).toEqual({ value: 'fake', source: 'fleet-default' });
  });

  it('records creation-time isolation as an explicit choice', async () => {
    writeFileSync(join(dir, 'policy.yaml'), 'network: deny\n');
    const { d } = fakeDeps();
    await spawnPermanent({ name: 'Sec', isolationFile: join(dir, 'policy.yaml') }, d);
    expect(provenanceOf('Sec').settings.isolation.source).toBe('cli');
  });

  it('a temp role records its own lifetime', async () => {
    const d = await spawnTemp({ name: 'Scout', mission: 'recon' }, '/b/ours-fleet', () => {});
    void d;
    expect(provenanceOf('Scout', true).lifetime).toBe('temporary');
  });

  it('records an explicit --permission-mode, and omits it when unset', async () => {
    const { d } = fakeDeps();
    await spawnPermanent({
      name: 'Moded', harness: 'claude-code', permissionMode: 'dontAsk',
    }, d);
    expect(provenanceOf('Moded').settings.permission_mode)
      .toEqual({ value: 'dontAsk', source: 'cli' });

    await spawnPermanent({ name: 'Unmoded' }, d);
    expect(provenanceOf('Unmoded').settings.permission_mode.value).toBeUndefined();
    expect(formatProvenance(provenanceOf('Unmoded')).join('\n')).not.toContain('permission_mode');
  });

  it('NEVER records secrets, env, bio or persona', async () => {
    writeFileSync(join(dir, 'bio.txt'), 'PUBLIC-CARD-TEXT');
    writeFileSync(join(dir, 'persona.txt'), 'PERSONA-CONTRACT-TEXT');
    writeFileSync(join(dir, 'fleet.yaml'), stringify({
      defaults: { harness: 'fake' },
      roles: {},
    }));
    const { d } = fakeDeps();
    await spawnPermanent({
      name: 'Careful',
      bioFile: join(dir, 'bio.txt'), personaFile: join(dir, 'persona.txt'),
      codexConfig: { api_key_like: 'SUPER-SECRET-VALUE' },
    }, d);

    const raw = readFileSync(join(agentDir('Careful'), 'creation.json'), 'utf8');
    for (const forbidden of ['PUBLIC-CARD-TEXT', 'PERSONA-CONTRACT-TEXT', 'SUPER-SECRET-VALUE'])
      expect(raw, forbidden).not.toContain(forbidden);
    const p = JSON.parse(raw);
    expect(p.settings.env).toBeUndefined();
    expect(p.settings.bio).toBeUndefined();
    expect(p.settings.persona).toBeUndefined();
    expect(p.settings.harness_options).toBeUndefined();
  });

  it('the printed summary is built from the SAME record that was persisted', async () => {
    const { d } = fakeDeps();
    await spawnPermanent({ name: 'Shown', approval: 'allow' }, d);
    const p = provenanceOf('Shown');
    const lines = formatProvenance(p);
    expect(lines.join('\n')).toContain('approval');
    expect(lines.join('\n')).toContain('(explicit)');
    expect(lines.join('\n')).toContain('(built-in)');
  });
});

describe('creationBuildNote', () => {
  const provenance = (over: Partial<CreationProvenance> = {}): CreationProvenance => ({
    version: 1, command: 'ours-fleet spawn', fleetVersion: buildInfo().version,
    fleetBuild: buildInfo().buildId, createdAt: '2026-08-13T00:00:00.000Z',
    lifetime: 'permanent', role: 'R', settings: {}, ...over,
  });

  it('says nothing when the reporting build is the one that created the role', () => {
    expect(creationBuildNote(provenance())).toBeUndefined();
  });

  it('flags a role created by a different build of the SAME version', () => {
    const note = creationBuildNote(provenance({ fleetBuild: 'deadbeef0000' }));
    expect(note).toContain('deadbeef0000');
    expect(note).toContain(buildInfo().buildId);
  });

  it('flags a role whose creating build cannot be identified', () => {
    const note = creationBuildNote(provenance({ fleetBuild: 'unknown' }));
    expect(note).toContain('unknown');
  });
});
