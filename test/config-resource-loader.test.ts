import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigResourceLoadError, loadConfigResourceSnapshot,
} from '../src/config-resource-loader.js';

let root: string;
let bootstrap: string;
let configDir: string;

const write = (relative: string, text: string): string => {
  const path = join(configDir, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
};

const bootstrapText = (config = 'fleet.conf.d') => `
schema_version: 2
config_dir: ${config}
policy: {}
adapters: {}
`;

const role = (id: string, extra = '') => `
kind: Role
version: 1
id: ${id}
spec: {mission: ${extra || 'work'}}
`;

const brain = (id: string, model = 'gpt') => `
kind: Brain
version: 1
id: ${id}
spec: {harness: codex, model: ${model}, effort: high, session: acp}
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-resource-loader-'));
  bootstrap = join(root, 'fleet.yaml');
  configDir = join(root, 'fleet.conf.d');
  mkdirSync(configDir);
  writeFileSync(bootstrap, bootstrapText());
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('secure typed resource discovery and graph snapshots', () => {
  it('loads all six kinds in deterministic order and deeply freezes the snapshot', () => {
    write('roles.d/z.yaml', role('Worker'));
    write('roles.d/A.yaml', role('Coordinator'));
    write('brains.d/smart.yaml', brain('smart'));
    write('agents.d/coordinator.yaml', `
kind: Agent
version: 1
id: coordinator
spec:
  role: Coordinator
  brain: {template: smart}
  identity: {name: coordinator, ownership: existing}
  lifecycle: persistent
  permissions: {approval: allow, filesystem: workspace, unattended: wait}
`);
    write('room-templates.d/pair.yaml', `
kind: RoomTemplate
version: 1
id: pair
spec:
  version: 1
  description: pair
  members:
    - {slot: worker, role: Worker, count: 1, brain: {template: smart}}
`);
    write('rooms.d/default.yaml', `
kind: RoomsPolicy
version: 1
id: default
spec:
  owner: {provider: ours, expected_cid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, role: Owner}
  defaults: {template: pair}
`);
    write('tasks.d/default.yaml', `
kind: TasksPolicy
version: 1
id: default
spec: {default_room_template: pair, create_mode: backlog}
`);
    const calls: string[] = [];
    const snapshot = loadConfigResourceSnapshot({
      bootstrapFile: bootstrap,
      validateBrain: (value, context) => { calls.push(`${context.fieldPath}:${value.model}`); },
    });
    expect(snapshot.sources.map(source => source.relativePath)).toEqual([
      'roles.d/A.yaml', 'roles.d/z.yaml', 'brains.d/smart.yaml',
      'agents.d/coordinator.yaml', 'room-templates.d/pair.yaml',
      'rooms.d/default.yaml', 'tasks.d/default.yaml',
    ]);
    expect(snapshot.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(snapshot.resources.Role?.Worker).toMatchObject({ kind: 'Role', id: 'Worker' });
    expect(calls).toEqual(expect.arrayContaining(['$.spec:gpt', '$.spec.brain:gpt']));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sources)).toBe(true);
    expect(Object.isFrozen(snapshot.resources.Role)).toBe(true);
    expect(Object.isFrozen(snapshot.resources.Role?.Worker.spec)).toBe(true);
    expect(() => ((snapshot.resources.Role as Record<string, unknown>).Other = {})).toThrow();
  });

  it('treats absent typed directories and optional singleton policies as empty sets', () => {
    const snapshot = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.resources).toEqual({});
  });

  it('treats prototype-shaped IDs as ordinary type-scoped keys', () => {
    write('roles.d/proto.yaml', role('__proto__'));
    const snapshot = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    expect(Object.hasOwn(snapshot.resources.Role!, '__proto__')).toBe(true);
    expect(snapshot.resources.Role?.__proto__).toMatchObject({ id: '__proto__' });
  });

  it('requires config_dir to exist and rejects YAML-named non-regular entries', () => {
    writeFileSync(bootstrap, bootstrapText('missing'));
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/\$\.config_dir: path component does not exist/u);
    writeFileSync(bootstrap, bootstrapText());
    mkdirSync(join(configDir, 'roles.d', 'nested.yaml'), { recursive: true });
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/YAML candidate must be a regular file/u);
  });

  it('uses bootstrap-relative config_dir and changes digest for raw-byte changes', () => {
    const nested = join(root, 'config', 'typed');
    mkdirSync(nested, { recursive: true });
    configDir = nested;
    writeFileSync(bootstrap, bootstrapText('config/typed'));
    const file = write('roles.d/a.yaml', role('A'));
    const first = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    writeFileSync(file, `${role('A')}\n`);
    const second = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    expect(first.configDir).toBe(nested);
    expect(second.digest).not.toBe(first.digest);
    expect(second.sources[0].sha256).not.toBe(first.sources[0].sha256);
  });

  it('emits diagnostics for non-YAML entries but rejects every symlink', () => {
    write('roles.d/README.txt', 'ignored');
    write('roles.d/a.yaml', role('A'));
    const snapshot = loadConfigResourceSnapshot({ bootstrapFile: bootstrap });
    expect(snapshot.diagnostics).toMatchObject([{ code: 'ignored_entry' }]);
    symlinkSync(join(configDir, 'roles.d', 'a.yaml'), join(configDir, 'roles.d', 'link.txt'));
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/symlink entries are forbidden/u);
  });

  it('sorts discovery by raw basename bytes and rejects non-UTF-8 basenames', () => {
    write('roles.d/z.yaml', role('z'));
    write('roles.d/A.yaml', role('A'));
    expect(loadConfigResourceSnapshot({ bootstrapFile: bootstrap }).sources.map(value => value.id))
      .toEqual(['A', 'z']);
    const directory = Buffer.from(join(configDir, 'roles.d'));
    const invalid = Buffer.concat([directory, Buffer.from('/bad-'), Buffer.from([0xff]), Buffer.from('.yaml')]);
    writeFileSync(invalid, role('invalid'));
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/entry basename must be valid UTF-8/u);
  });

  it('rejects a symlink in the bootstrap or config directory component', () => {
    const realBootstrap = bootstrap;
    const linkedBootstrap = join(root, 'linked.yaml');
    symlinkSync(realBootstrap, linkedBootstrap);
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: linkedBootstrap }))
      .toThrow(/symlink path component/u);
    const real = configDir;
    const linked = join(root, 'linked-config');
    symlinkSync(real, linked);
    writeFileSync(bootstrap, bootstrapText('linked-config'));
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/symlink path component/u);
  });

  it('rejects wrong directory kinds, duplicate IDs, and duplicate singleton files', () => {
    write('roles.d/wrong.yaml', brain('wrong'));
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/roles\.d requires kind Role/u);
    rmSync(join(configDir, 'roles.d'), { recursive: true });
    write('roles.d/one.yaml', role('same'));
    write('roles.d/two.yaml', role('same'));
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/duplicate Role id 'same'/u);
    rmSync(join(configDir, 'roles.d'), { recursive: true });
    const policy = `
kind: TasksPolicy
version: 1
id: default
spec: {}
`;
    write('tasks.d/one.yaml', policy);
    write('tasks.d/two.yaml', policy);
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/duplicate TasksPolicy id 'default'/u);
  });

  it.each([
    ['Agent Role', () => write('agents.d/a.yaml', `
kind: Agent
version: 1
id: a
spec: {role: Missing, brain: {template: missing}, identity: {name: a, ownership: existing}, lifecycle: persistent, permissions: {approval: ask, filesystem: workspace, unattended: wait}}
`), /unknown Role 'Missing'/u],
    ['template Brain', () => {
      write('roles.d/a.yaml', role('A'));
      write('room-templates.d/a.yaml', `
kind: RoomTemplate
version: 1
id: a
spec: {version: 1, description: a, members: [{slot: a, role: A, count: 1, brain: {template: missing}}]}
`);
    }, /unknown Brain 'missing'/u],
    ['policy template', () => write('tasks.d/default.yaml', `
kind: TasksPolicy
version: 1
id: default
spec: {default_room_template: missing}
`), /unknown RoomTemplate 'missing'/u],
  ])('rejects the complete broken reference graph: %s', (_name, setup, error) => {
    setup();
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap })).toThrow(error);
  });

  it('attributes injected Brain incompatibility to each originating field', () => {
    write('roles.d/a.yaml', role('A'));
    write('brains.d/bad.yaml', brain('bad', 'unsupported'));
    write('room-templates.d/a.yaml', `
kind: RoomTemplate
version: 1
id: a
spec: {version: 1, description: a, members: [{slot: a, role: A, count: 1, brain: {template: bad}}]}
`);
    expect(() => loadConfigResourceSnapshot({
      bootstrapFile: bootstrap,
      validateBrain: (value, context) => value.model === 'unsupported'
        && context.fieldPath === '$.spec' ? [] : ['unsupported model'],
    })).toThrow(/\.spec\.members\[0\]\.brain: unsupported model/u);
  });

  it('rejects duplicate slots and final composed Role text overflow', () => {
    write('roles.d/a.yaml', role('A', 'x'.repeat(65_535)));
    write('room-templates.d/a.yaml', `
kind: RoomTemplate
version: 1
id: a
spec:
  version: 1
  description: a
  members:
    - {slot: same, role: A, count: 1, role_context: {mission_append: overflow}}
    - {slot: same, role: A, count: 1}
`);
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/effective mission exceeds/u);
    write('roles.d/a.yaml', role('A'));
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/duplicate slot 'same'/u);
  });

  it('enforces per-file and aggregate limits before accepting a candidate', () => {
    write('roles.d/a.yaml', role('A'));
    expect(() => loadConfigResourceSnapshot({
      bootstrapFile: bootstrap, limits: { maxFileBytes: 20, maxAggregateBytes: 100 },
    })).toThrow(/byte file limit/u);
    expect(() => loadConfigResourceSnapshot({
      bootstrapFile: bootstrap, limits: { maxFileBytes: 100, maxAggregateBytes: 100 },
    })).toThrow(/aggregate byte limit/u);
  });

  it('rejects non-plain YAML and changed file identity during a bounded read', () => {
    const file = write('roles.d/a.yaml', `
kind: Role
version: 1
id: A
spec: &shared {mission: work}
`);
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(/non-plain YAML anchor/u);
    writeFileSync(file, role('A'));
    let changed = false;
    expect(() => loadConfigResourceSnapshot({
      bootstrapFile: bootstrap,
      testHooks: { afterRead: path => {
        if (path === file && !changed) { changed = true; writeFileSync(file, role('B')); }
      } },
    })).toThrow(/file identity changed while reading/u);
  });

  it('rejects a candidate swapped to a same-config symlink before open', () => {
    const candidate = write('roles.d/a.yaml', role('A'));
    const target = write('roles.d/b.yaml', role('B'));
    let swapped = false;
    expect(() => loadConfigResourceSnapshot({
      bootstrapFile: bootstrap,
      testHooks: { beforeOpen: path => {
        if (path === candidate && !swapped) {
          swapped = true;
          rmSync(candidate);
          symlinkSync(target, candidate);
        }
      } },
    })).toThrow(ConfigResourceLoadError);
    expect(swapped).toBe(true);
  });

  it('wraps a candidate removed before open as a loader error', () => {
    const candidate = write('roles.d/a.yaml', role('A'));
    let removed = false;
    try {
      loadConfigResourceSnapshot({
        bootstrapFile: bootstrap,
        testHooks: { beforeOpen: path => {
          if (path === candidate && !removed) { removed = true; rmSync(candidate); }
        } },
      });
      throw new Error('expected loader failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigResourceLoadError);
      expect((error as ConfigResourceLoadError).message).toContain('cannot open stable regular file: ENOENT');
    }
  });

  it('fails closed when secure no-follow opens are unavailable', () => {
    expect(() => loadConfigResourceSnapshot({
      bootstrapFile: bootstrap, testHooks: { noFollowFlag: null },
    })).toThrow(/secure file open unavailable: O_NOFOLLOW is required/u);
  });

  it('wraps a typed-directory removal before discovery as a loader error', () => {
    write('roles.d/a.yaml', role('A'));
    const directory = join(configDir, 'roles.d');
    let removed = false;
    expect(() => loadConfigResourceSnapshot({
      bootstrapFile: bootstrap,
      testHooks: { beforeReadDirectory: path => {
        if (path === directory && !removed) { removed = true; rmSync(directory, { recursive: true }); }
      } },
    })).toThrow(new RegExp(`${directory}:\\$: cannot read typed directory: ENOENT`, 'u'));
    expect(removed).toBe(true);
  });

  it.each(['policy', 'adapters', 'owner_routing', 'watchdogs', 'loops'])(
    'requires bootstrap %s to be a mapping when present', key => {
      writeFileSync(bootstrap, `schema_version: 2\nconfig_dir: fleet.conf.d\n${key}: []\n`);
      expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
        .toThrow(new RegExp(`\\$\\.${key}: must be a mapping`, 'u'));
    },
  );

  it.each(['policy', 'adapters', 'owner_routing'])(
    'rejects null bootstrap %s while preserving null watchdog/loop disablement', key => {
      writeFileSync(bootstrap, `schema_version: 2\nconfig_dir: fleet.conf.d\n${key}: null\n`);
      expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
        .toThrow(new ConfigResourceLoadError(bootstrap, `$.${key}`, 'must be a mapping'));
      writeFileSync(bootstrap, 'schema_version: 2\nwatchdogs: null\nloops: null\n');
      expect(loadConfigResourceSnapshot({ bootstrapFile: bootstrap }).sources).toEqual([]);
    },
  );

  it('rejects legacy/composition bootstrap keys with exact bootstrap context', () => {
    writeFileSync(bootstrap, `${bootstrapText()}roles: {A: {}}\n`);
    expect(() => loadConfigResourceSnapshot({ bootstrapFile: bootstrap }))
      .toThrow(new ConfigResourceLoadError(bootstrap, '$', 'unknown bootstrap key(s): roles'));
  });
});
