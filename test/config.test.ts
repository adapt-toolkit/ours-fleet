import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, findRole, validateMonitorConfig, ConfigError } from '../src/config.js';
import { runningLabel } from '../src/provenance.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-cfg-'));
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const base = (s: string) => writeFileSync(join(dir, 'fleet.yaml'), s);
const dropin = (name: string, s: string) => {
  mkdirSync(join(dir, 'fleet.d'), { recursive: true });
  writeFileSync(join(dir, 'fleet.d', name), s);
};

describe('loadConfig', () => {
  it('resolves a trusted owner channel only for ACP', () => {
    const agent = 'A'.repeat(64);
    const ownerOne = 'B'.repeat(64);
    const ownerTwo = 'C'.repeat(64);
    base([
      'roles:',
      '  Coordinator:',
      '    session: acp',
      '    identity: Coordinator',
      '    owner_channel:',
      '      identity: Coordinator-owner',
      `      owners: [${ownerOne}, ${ownerTwo}]`,
      `      agent: ${agent}`,
      '',
    ].join('\n'));
    expect(findRole(loadConfig(), 'Coordinator').owner_channel).toEqual({
      // CIDs resolve to their canonical (lowercase) hex form.
      identity: 'Coordinator-owner', owners: [ownerOne.toLowerCase(), ownerTwo.toLowerCase()],
      agent: agent.toLowerCase(),
      interrupt: false, progress_interval_ms: 30_000, comments: true,
      attachments: {
        enabled: true, max_files_per_request: 4, max_file_bytes: 10 * 1024 * 1024,
        max_request_bytes: 20 * 1024 * 1024, retention_ms: 24 * 60 * 60 * 1_000,
      },
    });
    base('roles:\n  A:\n    session: tmux\n');
    expect(() => loadConfig()).toThrow(/tmux is no longer supported.*session: acp/);
  });

  it('requires an exact managed-agent CID distinct from owner authority', () => {
    const cid = 'A'.repeat(64);
    base(`roles:\n  A:\n    session: acp\n    owner_channel: { identity: A-owner, owners: [owner], agent: short }\n`);
    expect(() => loadConfig()).toThrow(/owner_channel\.agent must be exactly 64 hexadecimal/);
    base(`roles:\n  A:\n    session: acp\n    owner_channel: { identity: A-owner, owners: [${cid}], agent: ${cid} }\n`);
    expect(() => loadConfig()).toThrow(/agent must not also be an owner CID/);
  });

  it('canonicalizes mixed-case owner and agent CIDs to lowercase at resolution', () => {
    const agent = 'AbCdEf12'.repeat(8);
    const owner = 'F0e1D2c3'.repeat(8);
    base([
      'roles:',
      '  A:',
      '    session: acp',
      '    owner_channel:',
      '      identity: A-owner',
      `      owners: [${owner}]`,
      `      agent: ${agent}`,
      '',
    ].join('\n'));
    const channel = findRole(loadConfig(), 'A').owner_channel!;
    expect(channel.owners).toEqual([owner.toLowerCase()]);
    expect(channel.agent).toBe(agent.toLowerCase());
  });

  it('rejects owner duplicates and agent overlap that differ only by hex case', () => {
    const lower = 'b'.repeat(64);
    const upper = 'B'.repeat(64);
    base(`roles:\n  A:\n    session: acp\n    owner_channel: { identity: A-owner, owners: [${lower}, ${upper}] }\n`);
    expect(() => loadConfig()).toThrow(/owners must not contain duplicates/);
    base(`roles:\n  A:\n    session: acp\n    owner_channel: { identity: A-owner, owners: [${lower}], agent: ${upper} }\n`);
    expect(() => loadConfig()).toThrow(/agent must not also be an owner CID/);
  });

  it('keeps owner channel identities exclusive from role and channel identities', () => {
    base([
      'roles:',
      '  A: { session: acp, identity: shared, owner_channel: { identity: B, owners: [cid] } }',
      '  B: { session: acp, identity: B }',
      '',
    ].join('\n'));
    expect(() => loadConfig()).toThrow(/owner_channel.identity 'B'.*conflicts with role 'B'/);
    base([
      'roles:',
      '  A: { session: acp, owner_channel: { identity: shared, owners: [cid] } }',
      '  B: { session: acp, owner_channel: { identity: shared, owners: [cid] } }',
      '',
    ].join('\n'));
    expect(() => loadConfig()).toThrow(/shared by roles 'A' and 'B'/);
  });

  it('defaults live ACP comments on, merges a defaults-level value, and validates the type', () => {
    // Backward compatibility: an existing owner_channel with no `comments` key
    // must keep relaying live commentary exactly as it did before the setting.
    base('roles:\n  A:\n    session: acp\n    owner_channel: { identity: A-owner, owners: [cid] }\n');
    expect(findRole(loadConfig(), 'A').owner_channel?.comments).toBe(true);

    base('roles:\n  A:\n    session: acp\n    owner_channel: { identity: A-owner, owners: [cid], comments: false }\n');
    expect(findRole(loadConfig(), 'A').owner_channel?.comments).toBe(false);

    // defaults.owner_channel supplies the baseline; the role overrides it.
    base([
      'defaults:',
      '  owner_channel:',
      '    comments: false',
      'roles:',
      '  A: { session: acp, owner_channel: { identity: A-owner, owners: [cid] } }',
      '  B: { session: acp, owner_channel: { identity: B-owner, owners: [cid], comments: true } }',
      '',
    ].join('\n'));
    expect(findRole(loadConfig(), 'A').owner_channel?.comments).toBe(false);
    expect(findRole(loadConfig(), 'B').owner_channel?.comments).toBe(true);

    for (const bad of ['comments: yes', 'comments: 1', 'comments: "true"', 'comments: null']) {
      base(`roles:\n  A:\n    session: acp\n    owner_channel: { identity: A-owner, owners: [cid], ${bad} }\n`);
      expect(() => loadConfig()).toThrow(/owner_channel\.comments must be true or false/);
    }
    base('roles:\n  A:\n    session: acp\n    owner_channel: { identity: A-owner, owners: [cid], comment: false }\n');
    expect(() => loadConfig()).toThrow(/unknown key\(s\) comment/);
  });

  it('deep-merges type-agnostic owner attachment limits and ignores the legacy MIME key', () => {
    base([
      'defaults:',
      '  owner_channel:',
      '    attachments: { max_file_bytes: 100, max_request_bytes: 200 }',
      'roles:',
      '  A:',
      '    session: acp',
      '    owner_channel:',
      '      identity: A-owner',
      '      owners: [cid]',
      '      attachments:',
      '        max_files_per_request: 2',
      '        allowed_mime: [text/plain, image/png]',
      '',
    ].join('\n'));
    expect(findRole(loadConfig(), 'A').owner_channel?.attachments).toMatchObject({
      enabled: true, max_files_per_request: 2, max_file_bytes: 100,
      max_request_bytes: 200,
    });
    expect(findRole(loadConfig(), 'A').owner_channel?.attachments).not.toHaveProperty('allowed_mime');
    for (const legacyValue of ['[Text/Plain]', '[]', 'anything', 'null']) {
      base(`roles:\n  A:\n    session: acp\n    owner_channel:\n      identity: A-owner\n      owners: [cid]\n      attachments: { allowed_mime: ${legacyValue} }\n`);
      expect(findRole(loadConfig(), 'A').owner_channel?.attachments).not.toHaveProperty('allowed_mime');
    }
    for (const policy of [
      'max_files_per_request: 0',
      'max_file_bytes: 200, max_request_bytes: 100',
      'retention_ms: 100',
      'unknown: true',
    ]) {
      base(`roles:\n  A:\n    session: acp\n    owner_channel:\n      identity: A-owner\n      owners: [cid]\n      attachments: { ${policy} }\n`);
      expect(() => loadConfig()).toThrow(/owner_channel\.attachments/);
    }
  });

  it('always rejects duplicate mapping keys with a source position', () => {
    base('roles:\n  A:\n    model: first\n    model: second\n');
    expect(() => loadConfig()).toThrow(/fleet\.yaml:.*Map keys must be unique.*line 4/i);
  });

  it.each([
    ['anchor and alias', 'roles:\n  A: &shared {}\n  B: *shared\n', ['anchor', 'alias']],
    ['explicit tag', 'roles:\n  A:\n    mission: !!str hello\n', ['explicit-tag']],
    ['non-scalar key', 'vars:\n  ? [A]\n  : value\nroles: {}\n', ['non-scalar-key']],
    ['multiple documents', 'roles:\n  A: {}\n---\nroles:\n  B: {}\n', ['multiple-documents']],
  ])('warns for %s in compat and rejects it in strict mode', (_name, yaml, kinds) => {
    base(yaml);
    expect(loadConfig(undefined, { yamlMode: 'compat' }).diagnostics.map(d => d.kind))
      .toEqual(expect.arrayContaining(kinds));
    expect(() => loadConfig(undefined, { yamlMode: 'strict' })).toThrow(/non-plain YAML/);
  });

  it('continues to allow multiline plain strings in strict mode', () => {
    base('roles:\n  A:\n    mission: |\n      first\n      second\n');
    expect(findRole(loadConfig(undefined, { yamlMode: 'strict' }), 'A').mission)
      .toBe('first\nsecond\n');
  });

  it('validates worklog, loopback auth proxy, and approved model chains', () => {
    base([
      'defaults:',
      '  harness: claude-code',
      '  worklog: { max_kb: 10, keep_tail_kb: 2, max_archives: 3 }',
      'roles:',
      '  A:',
      '    model: primary',
      '    model_chain: [primary, fallback]',
      '    auth_proxy:',
      '      kind: anthropic',
      '      base_url: http://127.0.0.1:9411',
      '      required: true',
      '',
    ].join('\n'));
    const role = findRole(loadConfig(), 'A');
    expect(role.worklog).toEqual({ max_kb: 10, keep_tail_kb: 2, max_archives: 3 });
    expect(role.model_chain).toEqual(['primary', 'fallback']);
    expect(role.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9411');
    expect(role.auth_proxy?.health_url).toContain('/healthz');
    base('roles:\n  A:\n    model: primary\n    model_chain: [other]\n');
    expect(() => loadConfig()).toThrow(/model must equal model_chain/);
    base('roles:\n  A:\n    auth_proxy: { kind: anthropic, base_url: https://example.com }\n');
    expect(() => loadConfig()).toThrow(/loopback-only/);
  });

  it('enables conservative worklog bounds by default with partial overrides and opt-out', () => {
    base('roles:\n  A: {}\n');
    expect(findRole(loadConfig(), 'A').worklog).toEqual({
      max_kb: 1024, keep_tail_kb: 256, max_archives: 12,
    });
    base('defaults:\n  worklog: { max_kb: 2048 }\nroles:\n  A:\n    worklog: { keep_tail_kb: 128 }\n  B:\n    worklog: false\n');
    expect(findRole(loadConfig(), 'A').worklog).toEqual({
      max_kb: 2048, keep_tail_kb: 128, max_archives: 12,
    });
    expect(findRole(loadConfig(), 'B').worklog).toBeUndefined();
    base('defaults:\n  worklog: false\nroles:\n  A: {}\n  B:\n    worklog: { max_kb: 512, keep_tail_kb: 64 }\n');
    expect(findRole(loadConfig(), 'A').worklog).toBeUndefined();
    expect(findRole(loadConfig(), 'B').worklog).toEqual({
      max_kb: 512, keep_tail_kb: 64, max_archives: 12,
    });
  });

  it('keeps model and recovery-chain defaults scoped to their harness', () => {
    base([
      'defaults:',
      '  harness: codex',
      '  model: gpt-primary',
      '  model_chain: [gpt-primary, gpt-fallback]',
      'roles:',
      '  Codex: {}',
      '  Claude:',
      '    harness: claude-code',
      '  ExplicitDefault:',
      '    model: null',
      '',
    ].join('\n'));
    const cfg = loadConfig();
    expect(findRole(cfg, 'Codex')).toMatchObject({
      model: 'gpt-primary', model_chain: ['gpt-primary', 'gpt-fallback'],
    });
    expect(findRole(cfg, 'Claude').model).toBeUndefined();
    expect(findRole(cfg, 'Claude').model_chain).toBeUndefined();
    expect(findRole(cfg, 'ExplicitDefault').model).toBeUndefined();
    expect(findRole(cfg, 'ExplicitDefault').model_chain).toBeUndefined();
  });

  it('merges fleet.yaml with fleet.d drop-ins', () => {
    base('roles:\n  A:\n    mission: base role\n');
    dropin('b.yaml', 'roles:\n  B:\n    mission: spawned\n');
    const cfg = loadConfig();
    expect(cfg.roles.map(r => r.name).sort()).toEqual(['A', 'B']);
    expect(findRole(cfg, 'B').sourceFile).toContain('fleet.d/b.yaml');
  });

  it('errors on duplicate role naming both files', () => {
    base('roles:\n  A: {}\n');
    dropin('a.yaml', 'roles:\n  A: {}\n');
    expect(() => loadConfig()).toThrowError(/A.*defined in both.*fleet\.yaml.*a\.yaml/s);
  });

  it('substitutes ${vars} recursively', () => {
    base('vars:\n  root: /work\nroles:\n  A:\n    cwd: ${root}/a\n    persona: |\n      lives at ${root}\n');
    const a = findRole(loadConfig(), 'A');
    expect(a.cwd).toBe('/work/a');
    expect(a.persona).toContain('lives at /work');
  });

  it('applies defaults cascade and identity fallback', () => {
    base('defaults:\n  harness: claude-code\n  max_tokens: 500000\nroles:\n  A: {}\n  B:\n    harness: other\n    max_tokens: 100\n    identity: Bee\n');
    const cfg = loadConfig();
    const a = findRole(cfg, 'A');
    expect(a.harness).toBe('claude-code');
    expect(a.max_tokens).toBe(500000);
    expect(a.identity).toBe('A');
    const b = findRole(cfg, 'B');
    expect(b.harness).toBe('other');
    expect(b.max_tokens).toBe(100);
    expect(b.identity).toBe('Bee');
  });

  it('defaults to ACP and rejects the legacy tmux backend precisely', () => {
    base('defaults:\n  session: acp\nroles:\n  A: {}\n');
    expect(findRole(loadConfig(), 'A').session).toBe('acp');
    base('roles:\n  C: {}\n');
    expect(findRole(loadConfig(), 'C').session).toBe('acp');
    base('roles:\n  Legacy:\n    session: tmux\n');
    expect(() => loadConfig()).toThrow(/tmux is no longer supported.*session: acp/);
  });

  it('merges common permission intent and ACP command settings', () => {
    base([
      'defaults:',
      '  permissions:',
      '    approval: ask',
      '    filesystem: read-only',
      '  session_options:',
      '    acp:',
      '      command: [node, agent.mjs]',
      'roles:',
      '  A:',
      '    session: acp',
      '    permissions:',
      '      approval: allow',
      '',
    ].join('\n'));
    const role = findRole(loadConfig(), 'A');
    expect(role.permissions).toEqual({
      approval: 'allow', filesystem: 'read-only', unattended: 'deny',
    });
    expect(role.session_options?.acp?.command).toEqual(['node', 'agent.mjs']);
  });

  it('accepts the public auto mode', () => {
    base('roles:\n  A:\n    permissions:\n      approval: auto\n');
    expect(findRole(loadConfig(), 'A').permissions.approval).toBe('auto');
  });

  it('rejects invalid session and common permission values', () => {
    base('roles:\n  A:\n    session: screen\n');
    expect(() => loadConfig()).toThrowError(/session.*acp/);
    base('roles:\n  A:\n    permissions:\n      approval: maybe\n');
    expect(() => loadConfig()).toThrowError(/permissions\.approval/);
  });

  it('defaults start_stagger_ms to 0 (no stagger) when unset', () => {
    base('roles:\n  A: {}\n');
    expect(loadConfig().startStaggerMs).toBe(0);
  });

  it('reads a top-level start_stagger_ms', () => {
    base('start_stagger_ms: 3000\nroles:\n  A: {}\n');
    expect(loadConfig().startStaggerMs).toBe(3000);
  });

  it('rejects a negative start_stagger_ms', () => {
    base('start_stagger_ms: -1\nroles:\n  A: {}\n');
    expect(() => loadConfig()).toThrowError(/start_stagger_ms.*non-negative/);
  });

  it('rejects a non-numeric start_stagger_ms', () => {
    base('start_stagger_ms: soon\nroles:\n  A: {}\n');
    expect(() => loadConfig()).toThrowError(/start_stagger_ms.*non-negative/);
  });

  it('merges defaults.harness_options with per-role overrides', () => {
    base('defaults:\n  harness: codex\n  harness_options:\n    launcher: auto\n    sandbox: workspace-write\nroles:\n  A: {}\n  B:\n    harness_options:\n      sandbox: read-only\n      search: true\n');
    const cfg = loadConfig();
    expect(findRole(cfg, 'A').harness_options).toEqual({ launcher: 'auto', sandbox: 'workspace-write' });
    expect(findRole(cfg, 'B').harness_options).toEqual({ launcher: 'auto', sandbox: 'read-only', search: true });
  });

  it('rejects a non-map defaults.harness_options', () => {
    base('defaults:\n  harness_options: nope\nroles:\n  A: {}\n');
    expect(() => loadConfig()).toThrowError(/defaults\.harness_options must be a map/);
  });

  it('defaults harness to claude-code with no defaults section', () => {
    base('roles:\n  A: {}\n');
    expect(findRole(loadConfig(), 'A').harness).toBe('claude-code');
  });

  it('rejects invalid role names', () => {
    base('roles:\n  "foo bar": {}\n');
    expect(() => loadConfig()).toThrowError(/invalid role name/);
  });

  it('rejects unknown role keys with the allowed list', () => {
    base('roles:\n  A:\n    persnoa: oops\n');
    expect(() => loadConfig()).toThrowError(/persnoa.*allowed:.*persona/s);
  });

  it('accepts a per-role model field', () => {
    base('roles:\n  A:\n    model: claude-fable-5\n  B: {}\n');
    const cfg = loadConfig();
    expect(cfg.roles.find(r => r.name === 'A')!.model).toBe('claude-fable-5');
    expect(cfg.roles.find(r => r.name === 'B')!.model).toBeUndefined();
  });

  it('still rejects an unknown role key', () => {
    base('roles:\n  A:\n    modell: oops\n');
    expect(() => loadConfig()).toThrowError(/unknown key/);
  });

  it('a role without model inherits defaults.model', () => {
    base('defaults:\n  model: claude-fable-5\nroles:\n  A: {}\n  B:\n    model: claude-opus-4-8\n');
    const cfg = loadConfig();
    expect(findRole(cfg, 'A').model).toBe('claude-fable-5');
    expect(cfg.defaults.model).toBe('claude-fable-5');
  });

  it('a per-role model overrides defaults.model', () => {
    base('defaults:\n  model: claude-fable-5\nroles:\n  B:\n    model: claude-opus-4-8\n');
    expect(findRole(loadConfig(), 'B').model).toBe('claude-opus-4-8');
  });

  it('does not inherit a fleet model across an explicit harness switch', () => {
    base(`defaults:
  harness: codex
  model: gpt-5.6
roles:
  Foreign:
    harness: claude-code
  Same:
    harness: codex
  Override:
    harness: claude-code
    model: claude-sonnet-4-5
  HarnessDefault:
    harness: codex
    model: null
`);
    const cfg = loadConfig();
    expect(findRole(cfg, 'Foreign').model).toBeUndefined();
    expect(findRole(cfg, 'Same').model).toBe('gpt-5.6');
    expect(findRole(cfg, 'Override').model).toBe('claude-sonnet-4-5');
    expect(findRole(cfg, 'HarnessDefault').model).toBeUndefined();
  });

  it('leaves model undefined when neither role nor defaults set it', () => {
    base('roles:\n  A: {}\n');
    expect(findRole(loadConfig(), 'A').model).toBeUndefined();
  });

  it('rejects drop-ins defining more than roles', () => {
    base('roles: {}\n');
    dropin('bad.yaml', 'vars:\n  x: 1\nroles: {}\n');
    expect(() => loadConfig()).toThrowError(/may only define roles/);
  });

  it('throws for an explicit missing config path', () => {
    expect(() => loadConfig(join(dir, 'nope.yaml'))).toThrowError(ConfigError);
  });

  it('findRole throws for unknown names', () => {
    base('roles:\n  A: {}\n');
    expect(() => findRole(loadConfig(), 'Z')).toThrowError(/no such role 'Z'/);
  });
});

describe('loadConfig isolation', () => {
  it('accepts an isolation block at role level and round-trips it', () => {
    base('roles:\n  A:\n    isolation:\n      backend: bubblewrap\n      network: deny\n      fs:\n        write: [/work/a]\n        read: [/opt/tc]\n      resources:\n        mem: 2G\n        cpu: "1.5"\n        pids: 512\n      secrets: ["/h/tok:/run/secrets/tok"]\n');
    const a = findRole(loadConfig(), 'A') as any;
    expect(a.isolation.backend).toBe('bubblewrap');
    expect(a.isolation.network).toBe('deny');
    expect(a.isolation.fs.write).toEqual(['/work/a']);
    expect(a.isolation.resources.mem).toBe('2G');
    expect(a.isolation.secrets).toEqual(['/h/tok:/run/secrets/tok']);
  });

  it('leaves roles without isolation unchanged (undefined)', () => {
    base('roles:\n  A:\n    mission: plain\n');
    const a = findRole(loadConfig(), 'A') as any;
    expect(a.isolation).toBeUndefined();
  });

  it('applies defaults.isolation to roles lacking their own; role overrides', () => {
    base('defaults:\n  isolation:\n    backend: auto\n    on_unavailable: strict\nroles:\n  A: {}\n  B:\n    isolation:\n      backend: none\n');
    const cfg = loadConfig();
    const a = findRole(cfg, 'A') as any;
    const b = findRole(cfg, 'B') as any;
    expect(a.isolation.on_unavailable).toBe('strict');
    expect(b.isolation.backend).toBe('none');
  });

  it('interpolates ${vars} inside isolation paths', () => {
    base('vars:\n  root: /work\nroles:\n  A:\n    isolation:\n      fs:\n        write: ["${root}/a"]\n');
    const a = findRole(loadConfig(), 'A') as any;
    expect(a.isolation.fs.write).toEqual(['/work/a']);
  });

  it('rejects unknown isolation sub-keys with the allowed list', () => {
    base('roles:\n  A:\n    isolation:\n      netork: deny\n');
    expect(() => loadConfig()).toThrowError(/isolation.*netork.*allowed:.*network/s);
  });

  it('rejects an invalid backend enum value', () => {
    base('roles:\n  A:\n    isolation:\n      backend: docker\n');
    expect(() => loadConfig()).toThrowError(/isolation\.backend.*docker.*bubblewrap/s);
  });

  it('rejects an invalid network enum value', () => {
    base('roles:\n  A:\n    isolation:\n      network: firewall\n');
    expect(() => loadConfig()).toThrowError(/isolation\.network.*firewall.*broker/s);
  });

  it('rejects an invalid on_unavailable enum value', () => {
    base('roles:\n  A:\n    isolation:\n      on_unavailable: explode\n');
    expect(() => loadConfig()).toThrowError(/isolation\.on_unavailable.*explode.*warn/s);
  });

  it('rejects unknown keys under isolation.fs', () => {
    base('roles:\n  A:\n    isolation:\n      fs:\n        writeable: [/x]\n');
    expect(() => loadConfig()).toThrowError(/isolation\.fs.*writeable.*allowed:.*write/s);
  });

  it('rejects unknown keys under isolation.resources', () => {
    base('roles:\n  A:\n    isolation:\n      resources:\n        memory: 2G\n');
    expect(() => loadConfig()).toThrowError(/isolation\.resources.*memory.*allowed:.*mem/s);
  });
});

describe('loadConfig monitor', () => {
  it('resolves code-constant defaults when no monitor block is present', () => {
    base('roles:\n  A: {}\n');
    const a = findRole(loadConfig(), 'A');
    expect(a.monitor.mode).toBe('fleet');
    expect(a.monitor.enabled).toBe(true);
    expect(a.monitor.wake_sources).toEqual([
      'message_received', 'file_received', 'local_contact_request', 'pending_message',
    ]);
    expect(a.monitor.batch_ms).toBe(2000);
    expect(a.monitor.inject).toBe('notification');
    expect(a.monitor.interrupt).toBe(false);
  });

  it('inherits defaults.monitor.enabled and lets a role override it', () => {
    base('defaults:\n  monitor:\n    enabled: false\nroles:\n  A: {}\n  B:\n    monitor:\n      enabled: true\n');
    const cfg = loadConfig();
    expect(findRole(cfg, 'A').monitor.enabled).toBe(false);
    expect(findRole(cfg, 'B').monitor.enabled).toBe(true);
  });

  it('selects fleet or native monitor ownership explicitly with monitor.mode', () => {
    base(
      'defaults:\n  monitor:\n    mode: native\nroles:\n  A: {}\n  B:\n'
      + '    monitor:\n      mode: fleet\n',
    );
    const cfg = loadConfig();
    expect(findRole(cfg, 'A').monitor).toMatchObject({ mode: 'native', enabled: false });
    expect(findRole(cfg, 'B').monitor).toMatchObject({ mode: 'fleet', enabled: true });
  });

  it('lets explicit role mode override a legacy default enabled value', () => {
    base(
      'defaults:\n  monitor:\n    enabled: true\nroles:\n  A:\n'
      + '    monitor:\n      mode: native\n',
    );
    expect(findRole(loadConfig(), 'A').monitor)
      .toMatchObject({ mode: 'native', enabled: false });
  });

  it('rejects invalid or contradictory monitor modes', () => {
    base('roles:\n  A:\n    monitor:\n      mode: external\n');
    expect(() => loadConfig()).toThrowError(/monitor\.mode.*external.*fleet.*native/);
    base('roles:\n  A:\n    monitor:\n      mode: native\n      enabled: true\n');
    expect(() => loadConfig()).toThrowError(/mode 'native'.*conflicts.*enabled true/);
  });

  it('merges role monitor over defaults.monitor key-by-key', () => {
    base('defaults:\n  monitor:\n    batch_ms: 5000\nroles:\n  A:\n    monitor:\n      wake_sources: [message_received]\n');
    const a = findRole(loadConfig(), 'A');
    expect(a.monitor.batch_ms).toBe(5000);            // from defaults
    expect(a.monitor.wake_sources).toEqual(['message_received']); // from role
    expect(a.monitor.enabled).toBe(true);             // code default
  });

  it('inherits monitor.interrupt and allows a per-role override', () => {
    base(
      'defaults:\n  monitor:\n    interrupt: true\nroles:\n  A: {}\n  B:\n'
      + '    monitor:\n      interrupt: false\n',
    );
    const cfg = loadConfig();
    expect(findRole(cfg, 'A').monitor.interrupt).toBe(true);
    expect(findRole(cfg, 'B').monitor.interrupt).toBe(false);
  });

  it('accepts and inherits monitor.interrupt after_tool without coercing legacy booleans', () => {
    base(
      'defaults:\n  monitor:\n    interrupt: after_tool\nroles:\n  A: {}\n  B:\n'
      + '    monitor:\n      interrupt: true\n  C:\n    monitor:\n      interrupt: false\n',
    );
    const cfg = loadConfig();
    expect(findRole(cfg, 'A').monitor.interrupt).toBe('after_tool');
    expect(findRole(cfg, 'B').monitor.interrupt).toBe(true);
    expect(findRole(cfg, 'C').monitor.interrupt).toBe(false);
  });

  it('rejects an unknown monitor.interrupt mode', () => {
    base('roles:\n  A:\n    monitor:\n      interrupt: always\n');
    expect(() => loadConfig()).toThrowError(/monitor\.interrupt.*true.*false.*after_tool/);
  });

  it('accepts a role wake_sources subset', () => {
    base('roles:\n  A:\n    monitor:\n      wake_sources: [message_received, file_received]\n');
    expect(findRole(loadConfig(), 'A').monitor.wake_sources)
      .toEqual(['message_received', 'file_received']);
  });

  it('accepts inject: full while delivery remains a separate concern', () => {
    base('roles:\n  A:\n    monitor:\n      inject: full\n');
    expect(findRole(loadConfig(), 'A').monitor.inject).toBe('full');
  });

  it('rejects unknown monitor keys with the allowed list', () => {
    base('roles:\n  A:\n    monitor:\n      enabledd: true\n');
    expect(() => loadConfig()).toThrowError(/monitor.*enabledd.*allowed:.*enabled/s);
  });

  it('rejects an unknown wake_source', () => {
    base('roles:\n  A:\n    monitor:\n      wake_sources: [message_recieved]\n');
    expect(() => loadConfig()).toThrowError(/wake_sources.*message_recieved.*allowed:.*message_received/s);
  });

  it('rejects an invalid inject mode', () => {
    base('roles:\n  A:\n    monitor:\n      inject: firehose\n');
    expect(() => loadConfig()).toThrowError(/monitor\.inject.*firehose.*notification.*full/s);
  });

  it('rejects a non-numeric / negative batch_ms', () => {
    base('roles:\n  A:\n    monitor:\n      batch_ms: -5\n');
    expect(() => loadConfig()).toThrowError(/monitor\.batch_ms/);
  });

  it('rejects a non-map monitor block', () => {
    base('roles:\n  A:\n    monitor: nope\n');
    expect(() => loadConfig()).toThrowError(/monitor.*mapping/);
  });

  it('rejects a non-map defaults.monitor', () => {
    base('defaults:\n  monitor: nope\nroles:\n  A: {}\n');
    expect(() => loadConfig()).toThrowError(/defaults\.monitor must be a map/);
  });
});

describe('isolation forbidden-path errors surface at config time', () => {
  it('a role asking for a forbidden mount fails `config` by role and path', () => {
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  Sec:\n    harness: claude-code\n'
      + '    isolation:\n      fs:\n        write:\n          - ' + join(dir, '.ssh') + '\n');
    expect(() => loadConfig()).toThrowError(/role 'Sec'.*refusing to mount/s);
    expect(() => loadConfig()).toThrowError(/\.ssh/);
  });

  it('a role with an allowed mount still loads', () => {
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  Ok:\n    harness: claude-code\n'
      + '    isolation:\n      fs:\n        read:\n          - /opt/reference\n');
    expect(loadConfig().roles).toHaveLength(1);
  });

  it('a role with no isolation block is unaffected', () => {
    writeFileSync(join(dir, 'fleet.yaml'), 'roles:\n  Plain:\n    harness: claude-code\n');
    expect(loadConfig().roles).toHaveLength(1);
  });
});

describe('validateMonitorConfig capability gating', () => {
  it('accepts after_tool because this build declares the capability', () => {
    expect(validateMonitorConfig({ mode: 'fleet', interrupt: 'after_tool' })).toEqual([]);
  });

  it('names the missing capability and this build when the running artifact lacks it', () => {
    const [problem, ...rest] = validateMonitorConfig({ mode: 'fleet', interrupt: 'after_tool' }, []);
    expect(rest).toEqual([]);
    expect(problem).toContain('monitor.interrupt.after_tool');
    expect(problem).toContain(runningLabel());
    expect(problem).toContain('ours-fleet doctor');
  });

  it('still rejects a value no build ever supported', () => {
    expect(validateMonitorConfig({ mode: 'fleet', interrupt: 'always' }, []))
      .toEqual(["monitor.interrupt: must be true, false, or 'after_tool'"]);
  });
});

describe('rooms-tasks split-config backward compat', () => {
  it('loads a plain fleet.yaml with no rooms/tasks (existing configs unchanged)', () => {
    base('roles:\n  A: {}\n');
    const cfg = loadConfig();
    expect(cfg.rooms).toBeUndefined();
    expect(cfg.roomTemplates).toBeUndefined();
    expect(cfg.tasks).toBeUndefined();
    expect(cfg.ownerInviteFingerprint).toBeUndefined();
    expect(cfg.roles).toHaveLength(1);
  });

  it('loads rooms config from fleet.yaml', () => {
    const cid = 'a'.repeat(64);
    base([
      'roles:\n  A: {}',
      'rooms:',
      '  owner:',
      `    expected_cid: ${cid}`,
      '    public_invite: test-invite-string',
      '  cowork:',
      '    config: /tmp/cowork.toml',
      '',
    ].join('\n'));
    const cfg = loadConfig();
    expect(cfg.rooms).toBeDefined();
    expect(cfg.rooms).not.toHaveProperty('provider');
    expect(cfg.rooms!.owner.expected_cid).toBe(cid);
    expect(cfg.rooms!.owner.public_invite).toBe('[REDACTED]');
    expect(cfg.ownerInviteFingerprint).toBeDefined();
    expect(cfg.ownerInviteFingerprint).toHaveLength(64);
    expect(cfg.ownerInvite).toBe('test-invite-string');
    expect(Object.keys(cfg)).not.toContain('ownerInvite');
    expect(JSON.stringify(cfg)).not.toContain('test-invite-string');
  });

  it('accepts and drops legacy rooms.provider while loading split config', () => {
    const cid = 'a'.repeat(64);
    base([
      'roles: {}',
      'rooms:',
      '  provider: cowork',
      '  owner:',
      `    expected_cid: ${cid}`,
      '',
    ].join('\n'));
    const cfg = loadConfig();
    expect(cfg.rooms).toBeDefined();
    expect(cfg.rooms).not.toHaveProperty('provider');
    expect(JSON.stringify(cfg.rooms)).not.toContain('"provider":"cowork"');
  });

  it('loads tasks config from fleet.yaml', () => {
    base('roles:\n  A: {}\ntasks:\n  create_mode: start\n');
    const cfg = loadConfig();
    expect(cfg.tasks).toBeDefined();
    expect(cfg.tasks!.create_mode).toBe('start');
  });

  it('loads room_templates from fleet.d drop-in', () => {
    base('roles:\n  A: {}\n');
    dropin('templates.yaml', [
      'room_templates:',
      '  my-team:',
      '    version: 1',
      '    description: custom team',
      '    members:',
      '      - slot: dev',
      '        role: Developer',
      '        count: 2',
      '        role_ref: A',
      '',
    ].join('\n'));
    const cfg = loadConfig();
    expect(cfg.roomTemplates).toBeDefined();
    expect(cfg.roomTemplates!['my-team']).toBeDefined();
    expect(cfg.roomTemplates!['my-team'].description).toBe('custom team');
  });

  it('rejects rooms defined in multiple files', () => {
    const cid = 'a'.repeat(64);
    const roomsBlock = `rooms:\n  owner:\n    expected_cid: ${cid}\n    public_invite: inv\n  cowork:\n    config: /tmp/c.toml\n`;
    base(`roles:\n  A: {}\n${roomsBlock}`);
    dropin('rooms.yaml', roomsBlock);
    expect(() => loadConfig()).toThrow(/rooms:.*defined in multiple files/);
  });

  it('merges room_templates from multiple fleet.d files by name', () => {
    base('roles:\n  A: {}\n');
    dropin('a.yaml', [
      'room_templates:',
      '  alpha:',
      '    version: 1',
      '    description: first',
      '    members:',
      '      - { slot: a, role: A, count: 1, role_ref: A }',
      '',
    ].join('\n'));
    dropin('b.yaml', [
      'room_templates:',
      '  beta:',
      '    version: 1',
      '    description: second',
      '    members:',
      '      - { slot: b, role: B, count: 1, role_ref: A }',
      '',
    ].join('\n'));
    const cfg = loadConfig();
    expect(cfg.roomTemplates!['alpha']).toBeDefined();
    expect(cfg.roomTemplates!['beta']).toBeDefined();
  });
});
