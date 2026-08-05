import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { FleetConfigService } from '../../src/web/fleet-config-service.js';
import { TopologyDraftStore, emptyDraft } from '../../src/web/topology-draft-store.js';
import { TopologyPromoteService } from '../../src/web/topology-promote.js';
import { mergeTopology } from '../../src/web/topology-model.js';
import type { RuntimeRoleItem } from '../../src/web/topology.js';

const roleItem = (id: string, mission?: string): RuntimeRoleItem => ({
  role: {
    id, lifetime: 'permanent', configured: true, stateHealth: 'present',
    detectedBackend: 'acp', compatibility: { compatible: true }, problems: [],
    config: mission === undefined ? undefined : { mission },
  },
  status: {
    roleId: id, observedAt: '2026-08-05T00:00:00.000Z', overall: 'ready',
    supervisor: { backend: 'none', liveness: 'running', detail: 'running' },
    session: { backend: 'acp', reachability: 'online', readiness: 'idle', evidence: 'authoritative' },
    restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
    monitor: { mode: 'fleet', health: 'armed', stale: false },
    isolation: { degraded: false }, problems: [],
  },
} as unknown as RuntimeRoleItem);

describe('adding sketches to the fleet', () => {
  let dir: string;
  let file: string;
  let drafts: TopologyDraftStore;
  let configuration: FleetConfigService;
  let service: TopologyPromoteService;
  let previousHome: string | undefined;

  const seed = async (source: string, draft: unknown) => {
    writeFileSync(file, source, { mode: 0o600 });
    if (draft) await drafts.write(drafts.read().revision, draft);
  };

  const topology = async () => mergeTopology(
    loadConfig(file), roleNames().map(name => roleItem(name, roleMission(name))), drafts.read());

  const roleNames = () => loadConfig(file).roles.map(role => role.name);
  const roleMission = (name: string) => loadConfig(file).roles.find(role => role.name === name)?.mission;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-promote-'));
    file = join(dir, 'fleet.yaml');
    previousHome = process.env.OURS_FLEET_HOME;
    process.env.OURS_FLEET_HOME = dir;
    drafts = new TopologyDraftStore({ dir });
    configuration = new FleetConfigService({ configPath: file });
    service = new TopologyPromoteService({ drafts, configuration, topology });
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
    else process.env.OURS_FLEET_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const promote = (ids: string[]) => service.promote({
    ids, configRevision: configuration.read().revision, draftRevision: drafts.read().revision,
  });

  it('writes a complete agent sketch into the configuration and clears the draft', async () => {
    await seed('# keep me\nroles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      positions: { 'agent:Reviewer': { x: 10, y: 20 } },
      drafts: {
        nodes: [{ id: 'agent:Reviewer', kind: 'agent', fields: { mission: 'Review pull requests', session: 'acp' } }],
        edges: [],
      },
    });

    const result = await promote(['agent:Reviewer']);
    const text = readFileSync(file, 'utf8');

    expect(result.promoted).toEqual(['agent:Reviewer']);
    expect(result.draftsCleared).toBe(true);
    expect(text).toContain('# keep me');
    expect(text).toContain('  Reviewer:');
    expect(text).toContain('    mission: Review pull requests');
    expect(loadConfig(file).roles.map(role => role.name)).toEqual(['Alice', 'Reviewer']);
    expect(drafts.read().draft.drafts.nodes).toEqual([]);
    // The canvas position outlives promotion so the node does not jump.
    expect(drafts.read().draft.positions['agent:Reviewer']).toEqual({ x: 10, y: 20 });
  });

  it('omits watch: for a standalone watchdog so later agents are covered automatically', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: {
        nodes: [{ id: 'watchdog:health', kind: 'watchdog', fields: { coordinator: 'Alice' } }],
        edges: [],
      },
    });

    await promote(['watchdog:health']);
    const text = readFileSync(file, 'utf8');

    expect(text).toContain('watchdogs:');
    expect(text).toContain('    coordinator: Alice');
    expect(text).not.toContain('watch:');
    const [watchdog] = loadConfig(file).watchdogs;
    expect(watchdog.watchExplicit).toBe(false);
    expect(watchdog.watch).toEqual(['Alice']);

    // An agent added afterwards is watched with no edit to the watchdog at all.
    const opened = configuration.read();
    (opened.model.roles as any).Bob = { mission: 'Review' };
    await configuration.write(opened.revision, opened.model);
    expect(loadConfig(file).watchdogs[0].watch).toEqual(['Alice', 'Bob']);
  });

  it('writes an explicit watch list for a watchdog scoped to one agent', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n  Bob:\n    mission: Review\n', {
      ...emptyDraft(),
      drafts: {
        nodes: [{ id: 'watchdog:forAlice', kind: 'watchdog', fields: { coordinator: 'Alice' } }],
        edges: [{ kind: 'watches', from: 'watchdog:forAlice', to: 'agent:Alice' }],
      },
    });

    await promote(['watchdog:forAlice']);

    const [watchdog] = loadConfig(file).watchdogs;
    expect(watchdog.watchExplicit).toBe(true);
    expect(watchdog.watch).toEqual(['Alice']);
    expect(readFileSync(file, 'utf8')).toContain('watch:');
  });

  it('supports several intervals delivering to one agent', async () => {
    await seed('roles:\n  Alice:\n    session: acp\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: {
        nodes: [
          { id: 'loop:morning', kind: 'loop', fields: { prompt: 'Morning check', interval: '1h' } },
          { id: 'loop:evening', kind: 'loop', fields: { prompt: 'Evening check', interval: '2h' } },
        ],
        edges: [
          { kind: 'targets', from: 'loop:morning', to: 'agent:Alice' },
          { kind: 'targets', from: 'loop:evening', to: 'agent:Alice' },
        ],
      },
    });

    await promote(['loop:morning', 'loop:evening']);

    const config = loadConfig(file);
    expect(config.loops.map(loop => loop.name)).toEqual(['evening', 'morning']);
    expect(config.roles[0].loops?.map(loop => loop.name).sort()).toEqual(['evening', 'morning']);
  });

  it('defaults an interval and disables a loop whose target is not on ACP', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: {
        nodes: [{ id: 'loop:nightly', kind: 'loop', fields: { prompt: 'Check in' } }],
        edges: [{ kind: 'targets', from: 'loop:nightly', to: 'agent:Alice' }],
      },
    });

    await promote(['loop:nightly']);

    const [loop] = loadConfig(file).loops;
    // Enabled would be a hard ConfigError on a tmux role and would break the fleet.
    expect(loop.enabled).toBe(false);
    expect(loop.intervalMs).toBe(600_000);
    expect(readFileSync(file, 'utf8')).toContain('    enabled: false');
  });

  it('leaves an enabled loop enabled when every target is on ACP', async () => {
    await seed('roles:\n  Alice:\n    session: acp\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: {
        nodes: [{ id: 'loop:nightly', kind: 'loop', fields: { prompt: 'Check in', interval: '30m' } }],
        edges: [{ kind: 'targets', from: 'loop:nightly', to: 'agent:Alice' }],
      },
    });

    await promote(['loop:nightly']);
    expect(loadConfig(file).loops[0].enabled).toBe(true);
  });

  describe('promoting one end of a scoped relationship', () => {
    /**
     * The real workflow: sketch an agent, scope a watchdog to it, then add them
     * one at a time. The scope edge is owned by the watchdog, so promoting the
     * agent must not clear it — otherwise the watchdog reads as standalone and
     * is written with no `watch:` key, silently watching the whole fleet.
     */
    const scoped = () => seed('roles: {}\n', {
      ...emptyDraft(),
      drafts: {
        nodes: [
          { id: 'agent:Alice', kind: 'agent', fields: { mission: 'Ship safely' } },
          { id: 'watchdog:W', kind: 'watchdog', fields: { coordinator: 'Alice' } },
        ],
        edges: [{ kind: 'watches', from: 'watchdog:W', to: 'agent:Alice' }],
      },
    });

    it('keeps the scope edge when the agent is promoted first', async () => {
      await scoped();

      await promote(['agent:Alice']);

      expect(drafts.read().draft.drafts.edges)
        .toEqual([{ kind: 'watches', from: 'watchdog:W', to: 'agent:Alice' }]);
      expect(drafts.read().draft.drafts.nodes.map(node => node.id)).toEqual(['watchdog:W']);
      // The survivor is still scoped, not standalone.
      const watchdog = (await topology()).edges
        .filter(edge => edge.kind === 'watches' && edge.from === 'watchdog:W');
      expect(watchdog).toHaveLength(1);
      expect(watchdog[0]).toMatchObject({ to: 'agent:Alice', implicit: false });
    });

    it('writes watch: [Alice] when the watchdog is promoted second, and never widens', async () => {
      await scoped();
      await promote(['agent:Alice']);

      const preview = await service.preview({
        ids: ['watchdog:W'], configRevision: configuration.read().revision,
      });
      expect(preview.diff).toContain('watch:');
      await promote(['watchdog:W']);

      const text = readFileSync(file, 'utf8');
      expect(text).toContain('    watch:');
      expect(text).toContain('      - Alice');
      const [written] = loadConfig(file).watchdogs;
      expect(written.watchExplicit).toBe(true);
      expect(written.watch).toEqual(['Alice']);

      // Adding another agent must not expand a scoped watchdog.
      const opened = configuration.read();
      (opened.model.roles as any).Bob = { mission: 'Review' };
      await configuration.write(opened.revision, opened.model);
      expect(loadConfig(file).watchdogs[0].watch).toEqual(['Alice']);
      expect(drafts.read().draft.drafts.edges).toEqual([]);
    });

    it('keeps an interval targeted at an agent promoted before it', async () => {
      await seed('roles: {}\n', {
        ...emptyDraft(),
        drafts: {
          nodes: [
            { id: 'agent:Alice', kind: 'agent', fields: { mission: 'Ship', session: 'acp' } },
            { id: 'loop:nightly', kind: 'loop', fields: { prompt: 'Check in' } },
          ],
          edges: [{ kind: 'targets', from: 'loop:nightly', to: 'agent:Alice' }],
        },
      });

      await promote(['agent:Alice']);
      expect(drafts.read().draft.drafts.edges)
        .toEqual([{ kind: 'targets', from: 'loop:nightly', to: 'agent:Alice' }]);

      await promote(['loop:nightly']);
      expect(loadConfig(file).loops[0].roleNames).toEqual(['Alice']);
      expect(loadConfig(file).loops[0].enabled).toBe(true);
    });

    it('clears an edge once its own source is written', async () => {
      await seed('roles:\n  Alice:\n    mission: Ship\n', {
        ...emptyDraft(),
        drafts: {
          nodes: [{ id: 'watchdog:W', kind: 'watchdog', fields: { coordinator: 'Alice' } }],
          edges: [{ kind: 'watches', from: 'watchdog:W', to: 'agent:Alice' }],
        },
      });

      await promote(['watchdog:W']);

      // The relationship now lives in `watch:`, so the sketch of it is redundant.
      expect(drafts.read().draft.drafts.edges).toEqual([]);
      expect(loadConfig(file).watchdogs[0].watch).toEqual(['Alice']);
    });

    it('still writes no watch: for a watchdog that was never scoped', async () => {
      await seed('roles: {}\n', {
        ...emptyDraft(),
        drafts: {
          nodes: [
            { id: 'agent:Alice', kind: 'agent', fields: { mission: 'Ship' } },
            { id: 'watchdog:all', kind: 'watchdog', fields: { coordinator: 'Alice' } },
          ],
          edges: [],
        },
      });

      await promote(['agent:Alice']);
      await promote(['watchdog:all']);

      expect(readFileSync(file, 'utf8')).not.toContain('watch:');
      expect(loadConfig(file).watchdogs[0].watchExplicit).toBe(false);
      expect(loadConfig(file).watchdogs[0].watch).toEqual(['Alice']);

      // The opposite of the scoped case: a standalone watchdog must keep
      // covering agents added later with no edit of its own.
      const opened = configuration.read();
      (opened.model.roles as any).Bob = { mission: 'Review' };
      await configuration.write(opened.revision, opened.model);
      expect(loadConfig(file).watchdogs[0].watch).toEqual(['Alice', 'Bob']);
      expect(readFileSync(file, 'utf8')).not.toContain('watch:');
    });

    it('retains only edges whose source is still a sketch, not every edge', async () => {
      await seed('roles: {}\n', {
        ...emptyDraft(),
        drafts: {
          nodes: [
            { id: 'agent:Alice', kind: 'agent', fields: { mission: 'Ship' } },
            { id: 'watchdog:Kept', kind: 'watchdog', fields: { coordinator: 'Alice' } },
            { id: 'watchdog:Gone', kind: 'watchdog', fields: { coordinator: 'Alice' } },
          ],
          edges: [
            { kind: 'watches', from: 'watchdog:Kept', to: 'agent:Alice' },
            { kind: 'watches', from: 'watchdog:Gone', to: 'agent:Alice' },
          ],
        },
      });

      // The accepted two-write workflow: the shared target first, then one of
      // the two watchdogs.
      await promote(['agent:Alice']);
      expect(drafts.read().draft.drafts.edges).toHaveLength(2);
      await promote(['watchdog:Gone']);

      // Gone's edge was written into its `watch:` list, so it is redundant.
      // Kept's edge is still the only record of its scope, so it survives.
      expect(drafts.read().draft.drafts.edges)
        .toEqual([{ kind: 'watches', from: 'watchdog:Kept', to: 'agent:Alice' }]);
      expect(loadConfig(file).watchdogs.find(item => item.name === 'Gone')?.watch).toEqual(['Alice']);
    });
  });

  it('writes the oversight drawn from a sketched agent when it is added', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: {
        nodes: [{ id: 'agent:Coordinator', kind: 'agent', fields: { mission: 'Keep an eye on things' } }],
        edges: [{ kind: 'oversees', from: 'agent:Coordinator', to: 'agent:Alice' }],
      },
    });

    await promote(['agent:Coordinator']);

    const text = readFileSync(file, 'utf8');
    expect(text).toContain('    oversee:');
    expect(text).toContain('      - role: Alice');
    expect(loadConfig(file).roles.find(role => role.name === 'Coordinator')?.oversee)
      .toEqual([{ role: 'Alice', interval: '10m' }]);
    // The relationship lives in `oversee:` now, so the sketch of it is redundant.
    expect(drafts.read().draft.drafts.edges).toEqual([]);
  });

  it('refuses to add an agent whose ward is still a sketch, and says why', async () => {
    await seed('roles: {}\n', {
      ...emptyDraft(),
      drafts: {
        nodes: [
          { id: 'agent:Coordinator', kind: 'agent', fields: { mission: 'Watch' } },
          { id: 'agent:Worker', kind: 'agent', fields: { mission: 'Work' } },
        ],
        edges: [{ kind: 'oversees', from: 'agent:Coordinator', to: 'agent:Worker' }],
      },
    });

    await expect(promote(['agent:Coordinator'])).rejects.toThrow(/oversee.*Worker/s);
    expect(readFileSync(file, 'utf8')).not.toContain('Coordinator');

    // Add the ward first and the overseer becomes addable, with the edge intact.
    await promote(['agent:Worker']);
    await promote(['agent:Coordinator']);
    expect(loadConfig(file).roles.find(role => role.name === 'Coordinator')?.oversee)
      .toEqual([{ role: 'Worker', interval: '10m' }]);
  });

  it('refuses an incomplete sketch with the reason the console shows', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: { nodes: [{ id: 'agent:Blank', kind: 'agent', fields: {} }], edges: [] },
    });

    await expect(promote(['agent:Blank'])).rejects.toThrow(/not ready to add.*mission/s);
    expect(readFileSync(file, 'utf8')).not.toContain('Blank');
    expect(drafts.read().draft.drafts.nodes).toHaveLength(1);
  });

  it('refuses a name the configuration already uses', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: { nodes: [{ id: 'watchdog:Alice', kind: 'watchdog', fields: { coordinator: 'Alice' } }], edges: [] },
    });

    await expect(promote(['watchdog:Alice'])).rejects.toThrow(/not ready to add/);
    expect(loadConfig(file).watchdogs).toEqual([]);
  });

  it('rejects an unknown id, an empty list and an already-configured node', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', undefined);
    const configRevision = configuration.read().revision;

    await expect(service.promote({ ids: [], configRevision })).rejects.toThrow(/name at least one sketch/);
    await expect(service.promote({ ids: ['agent:Nope'], configRevision })).rejects.toThrow(/no sketch called/);
    await expect(service.promote({ ids: ['agent:Alice'], configRevision }))
      .rejects.toThrow(/already part of the fleet configuration/);
  });

  it('refuses a stale configuration revision without writing', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: { nodes: [{ id: 'agent:Reviewer', kind: 'agent', fields: { mission: 'Review' } }], edges: [] },
    });

    await expect(service.promote({ ids: ['agent:Reviewer'], configRevision: 'stale' }))
      .rejects.toThrow(/changed since it was opened/);
    expect(readFileSync(file, 'utf8')).not.toContain('Reviewer');
  });

  it('previews the exact diff without writing anything', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: { nodes: [{ id: 'agent:Reviewer', kind: 'agent', fields: { mission: 'Review' } }], edges: [] },
    });
    const before = readFileSync(file, 'utf8');

    const preview = await service.preview({
      ids: ['agent:Reviewer'], configRevision: configuration.read().revision,
    });

    expect(preview.promoted).toEqual(['agent:Reviewer']);
    expect(preview.diff).toContain('+  Reviewer:');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(drafts.read().draft.drafts.nodes).toHaveLength(1);
  });

  it('never writes a field that is not a key of the target mapping', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: {
        nodes: [{
          id: 'agent:Reviewer', kind: 'agent',
          // `prompt` and `interval` belong to loops, not roles; writing them
          // would be an unknown-key ConfigError.
          fields: { mission: 'Review', prompt: 'nope', interval: '5m', identity: 'ReviewerBot' },
        }],
        edges: [],
      },
    });

    await promote(['agent:Reviewer']);
    const text = readFileSync(file, 'utf8');

    expect(text).toContain('    identity: ReviewerBot');
    expect(text).not.toContain('prompt:');
    expect(loadConfig(file).roles.find(role => role.name === 'Reviewer')?.identity).toBe('ReviewerBot');
  });

  it('keeps the configuration when the sketches cannot be cleared afterwards', async () => {
    await seed('roles:\n  Alice:\n    mission: Ship\n', {
      ...emptyDraft(),
      drafts: { nodes: [{ id: 'agent:Reviewer', kind: 'agent', fields: { mission: 'Review' } }], edges: [] },
    });

    const result = await service.promote({
      ids: ['agent:Reviewer'],
      configRevision: configuration.read().revision,
      draftRevision: 'stale-sidecar',
    });

    expect(result.saved).toBe(true);
    expect(result.draftsCleared).toBe(false);
    expect(loadConfig(file).roles.map(role => role.name)).toContain('Reviewer');
    // The sketch survives and the merged model reports it as shadowed, rather
    // than the write being lost.
    expect(drafts.read().draft.drafts.nodes).toHaveLength(1);
    expect((await topology()).problems.map(problem => problem.code))
      .toContain('draft_conflicts_with_config');
  });

  /**
   * The Oversee gesture between two agents that are already in the fleet. There
   * is no sketch to promote here — the edge IS the change — so it goes through
   * the same reviewed, revision-guarded, surgical write.
   */
  describe('drawing oversight between two agents in the fleet', () => {
    const twoAgents = () => seed(
      '# operator header\nroles:\n  Coordinator:\n    mission: Coordinate  # keep this note\n  Worker:\n    mission: Work\n',
      undefined);
    const oversee = (from: string, to: string, interval?: string) => service.connectOversee({
      from, to, interval, configRevision: configuration.read().revision,
    });

    it('writes oversee: without touching the rest of the document', async () => {
      await twoAgents();

      const result = await oversee('Coordinator', 'Worker');
      const text = readFileSync(file, 'utf8');

      expect(result.saved).toBe(true);
      expect(text).toContain('# operator header');
      expect(text).toContain('mission: Coordinate  # keep this note');
      expect(loadConfig(file).roles.find(role => role.name === 'Coordinator')?.oversee)
        .toEqual([{ role: 'Worker', interval: '10m' }]);
      expect(loadConfig(file).roles.find(role => role.name === 'Worker')?.oversee).toBeUndefined();
    });

    it('previews the diff without writing, and honours a chosen interval', async () => {
      await twoAgents();
      const before = readFileSync(file, 'utf8');

      const preview = await service.previewOversee({
        from: 'Coordinator', to: 'Worker', interval: '30m',
        configRevision: configuration.read().revision,
      });

      expect(preview.diff).toContain('oversee:');
      expect(preview.diff).toContain('30m');
      expect(readFileSync(file, 'utf8')).toBe(before);

      await oversee('Coordinator', 'Worker', '30m');
      expect(loadConfig(file).roles.find(role => role.name === 'Coordinator')?.oversee)
        .toEqual([{ role: 'Worker', interval: '30m' }]);
    });

    it('adds a second ward beside the first instead of replacing it', async () => {
      await seed('roles:\n  Coordinator:\n    mission: Coordinate\n  Worker:\n    mission: Work\n  Other:\n    mission: Other\n', undefined);

      await oversee('Coordinator', 'Worker');
      await oversee('Coordinator', 'Other');

      expect(loadConfig(file).roles.find(role => role.name === 'Coordinator')?.oversee)
        .toEqual([{ role: 'Worker', interval: '10m' }, { role: 'Other', interval: '10m' }]);
    });

    it('refuses self-oversight, a duplicate, an unknown agent and a bad interval', async () => {
      await twoAgents();

      await expect(oversee('Coordinator', 'Coordinator')).rejects.toThrow(/cannot oversee itself/);
      await expect(oversee('Coordinator', 'Nobody')).rejects.toThrow(/no agent called Nobody/);
      await expect(oversee('Coordinator', 'Worker', '10s')).rejects.toThrow(/below the minimum/);
      await expect(oversee('Coordinator', 'Worker', 'soon')).rejects.toThrow(/invalid duration/);
      await expect(oversee('../escape', 'Worker')).rejects.toThrow(/not a valid agent name/);
      expect(readFileSync(file, 'utf8')).not.toContain('oversee');

      await oversee('Coordinator', 'Worker');
      await expect(oversee('Coordinator', 'Worker')).rejects.toThrow(/already oversees Worker/);
    });

    it('refuses an end that is not in fleet.yaml, sketch or watchdog alike', async () => {
      await seed('roles:\n  Coordinator:\n    mission: Coordinate\n', {
        ...emptyDraft(),
        drafts: {
          nodes: [
            { id: 'agent:Sketch', kind: 'agent', fields: { mission: 'Someday' } },
            { id: 'watchdog:health', kind: 'watchdog', fields: { coordinator: 'Coordinator' } },
          ],
          edges: [],
        },
      });

      await expect(oversee('Coordinator', 'Sketch')).rejects.toThrow(/still a sketch/);
      await expect(oversee('Sketch', 'Coordinator')).rejects.toThrow(/still a sketch/);
      await expect(oversee('Coordinator', 'health')).rejects.toThrow(/no agent called health/);
      expect(readFileSync(file, 'utf8')).not.toContain('oversee');
    });

    it('refuses a stale configuration revision without writing', async () => {
      await twoAgents();
      const before = readFileSync(file, 'utf8');

      await expect(service.connectOversee({
        from: 'Coordinator', to: 'Worker', configRevision: 'stale',
      })).rejects.toThrow(/changed since it was opened/);
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    // The loader refuses a role that is not a mapping long before the write, so
    // a document the console cannot reason about is never partially rewritten.
    // (`mapping()` guards the same case a second time, for a caller that reads
    // the topology from somewhere more permissive than `loadConfig`.)
    it('writes nothing at all when fleet.yaml cannot be read as a fleet', async () => {
      await seed('roles:\n  Coordinator:\n    - not\n    - a mapping\n  Worker:\n    mission: Work\n', undefined);
      const before = readFileSync(file, 'utf8');

      await expect(oversee('Coordinator', 'Worker')).rejects.toThrow(/unknown key/);
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    /**
     * The console never sees an env value — it reads a redaction marker — so a
     * write built from what it read must restore the real one rather than
     * writing the marker over the operator's secret.
     */
    it('never writes a redaction marker over a secret it was not shown', async () => {
      await seed('roles:\n  Coordinator:\n    mission: Coordinate\n    env:\n      TOKEN: super-secret\n  Worker:\n    mission: Work\n', undefined);
      expect(configuration.read().redactions).toEqual(['roles.Coordinator.env.TOKEN']);

      await oversee('Coordinator', 'Worker');

      const text = readFileSync(file, 'utf8');
      expect(text).toContain('TOKEN: super-secret');
      expect(text).not.toContain('REDACTED');
      expect(loadConfig(file).roles.find(role => role.name === 'Coordinator')?.env)
        .toEqual({ TOKEN: 'super-secret' });
    });
  });
});
