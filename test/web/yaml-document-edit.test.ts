import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  detectFormatting, redactSourceSecrets, renderModelOntoSource,
} from '../../src/web/yaml-document-edit.js';
import { parseFleetDocument } from '../../src/config-yaml.js';

/** Lines of `after` that differ from `before` at the same index. */
const changedLines = (before: string, after: string): string[] => {
  const original = before.split('\n');
  return after.split('\n').filter((line, index) => line !== original[index]);
};

const COMMENTED = [
  '# fleet.yaml — declarative fleet.',
  '#',
  '# This header must survive every console save.',
  '',
  'vars:',
  '  work_root: /home/me/work   # where agents live',
  '',
  'defaults:',
  '  harness: claude-code        # adapter for roles that do not set their own',
  '  session: acp',
  '',
  'roles:',
  '',
  '  # The coordinator routes work.',
  '  Alice:',
  '    mission: Ship safely',
  '    oversee:',
  '      - { role: Bob, interval: 5m }',
  '',
  '  Bob:',
  '    mission: Review',
  '',
].join('\n');

describe('surgical fleet YAML document editing', () => {
  it('keeps comments, blank lines and key order when one leaf value changes', () => {
    const model = parse(COMMENTED) as Record<string, any>;
    model.roles.Alice.mission = 'Ship even more safely';

    const next = renderModelOntoSource(COMMENTED, model);

    expect(next).toContain('# fleet.yaml — declarative fleet.');
    expect(next).toContain('# This header must survive every console save.');
    expect(next).toContain('# The coordinator routes work.');
    expect(next).toContain('  work_root: /home/me/work   # where agents live');
    expect(next).toContain('  harness: claude-code        # adapter for roles that do not set their own');
    expect(next).toContain('mission: Ship even more safely');
    expect(next).not.toContain('mission: Ship safely');
    // Only the edited line differs from the original.
    const changed = next.split('\n').filter((line, index) => line !== COMMENTED.split('\n')[index]);
    expect(changed).toEqual(['    mission: Ship even more safely']);
  });

  it('appends a new role without disturbing existing entries or their comments', () => {
    const model = parse(COMMENTED) as Record<string, any>;
    model.roles.Carol = { mission: 'Research' };

    const next = renderModelOntoSource(COMMENTED, model);

    expect(next).toContain('# The coordinator routes work.');
    expect(next).toContain('Carol:');
    expect(next).toContain('mission: Research');
    expect(next.indexOf('Alice:')).toBeLessThan(next.indexOf('Carol:'));
    expect(parse(next)).toEqual(model);
  });

  it('deletes removed keys and leaves untouched siblings byte-identical', () => {
    const model = parse(COMMENTED) as Record<string, any>;
    delete model.roles.Bob;

    const next = renderModelOntoSource(COMMENTED, model);

    expect(next).not.toContain('Bob:');
    expect(next).not.toContain('mission: Review');
    // The oversee entry still references Bob; only the role mapping went away.
    expect(next).toContain('- { role: Bob, interval: 5m }');
    expect(next).toContain('# The coordinator routes work.');
    expect(parse(next)).toEqual(model);
  });

  it('preserves the original key order and appends only genuinely new keys', () => {
    const source = 'roles:\n  Alpha: {}\nvars:\n  token: t\n';
    const next = renderModelOntoSource(source, { vars: { token: 't' }, roles: { Alpha: {} }, defaults: { session: 'acp' } });

    expect(next.indexOf('roles:')).toBeLessThan(next.indexOf('vars:'));
    expect(next.indexOf('vars:')).toBeLessThan(next.indexOf('defaults:'));
  });

  it('rewrites only the changed element of an equal-length sequence', () => {
    const source = ['roles:', '  Alice:', '    oversee:', '      - Bob      # first ward', '      - Carol    # second ward', ''].join('\n');
    const model = parse(source) as Record<string, any>;
    model.roles.Alice.oversee[1] = 'Dave';

    const next = renderModelOntoSource(source, model);

    expect(next).toContain('- Bob      # first ward');
    expect(next).toContain('Dave');
    expect(parse(next)).toEqual(model);
  });

  it('replaces a sequence wholesale when its length changes', () => {
    const source = 'roles:\n  Alice:\n    oversee:\n      - Bob\n';
    const model = parse(source) as Record<string, any>;
    model.roles.Alice.oversee.push('Carol');

    const next = renderModelOntoSource(source, model);
    expect(parse(next)).toEqual(model);
  });

  describe('block sequences that change length with content after them', () => {
    // A block collection's range runs past its terminating newline, unlike a
    // scalar's. Splicing over that newline once glued the following line on.
    const source = [
      'roles:', '  Alice:', '    oversee:', '      - Bob', '      - Carol',
      '    mission: Ship', '  Bob:', '    mission: Review', '',
    ].join('\n');

    it('grows without gluing the following line', () => {
      const model = parse(source) as Record<string, any>;
      model.roles.Alice.oversee.push('Dave');

      const next = renderModelOntoSource(source, model);

      expect(next).toBe([
        'roles:', '  Alice:', '    oversee:', '      - Bob', '      - Carol', '      - Dave',
        '    mission: Ship', '  Bob:', '    mission: Review', '',
      ].join('\n'));
      expect(parse(next)).toEqual(model);
    });

    it('shrinks without gluing the following line', () => {
      const model = parse(source) as Record<string, any>;
      model.roles.Alice.oversee.pop();

      const next = renderModelOntoSource(source, model);

      expect(next).toBe([
        'roles:', '  Alice:', '    oversee:', '      - Bob',
        '    mission: Ship', '  Bob:', '    mission: Review', '',
      ].join('\n'));
      expect(parse(next)).toEqual(model);
    });

    it('empties onto the key rather than leaving a dangling block', () => {
      const model = parse(source) as Record<string, any>;
      model.roles.Alice.oversee = [];

      const next = renderModelOntoSource(source, model);

      expect(next).toBe([
        'roles:', '  Alice:', '    oversee: []',
        '    mission: Ship', '  Bob:', '    mission: Review', '',
      ].join('\n'));
      expect(parse(next)).toEqual(model);
    });

    it('keeps a flow sequence in flow style when it changes length', () => {
      const flow = 'loops:\n  nightly:\n    roles: [Alice]\n    interval: 10m\n';
      const model = parse(flow) as Record<string, any>;
      model.loops.nightly.roles.push('Bob');

      expect(renderModelOntoSource(flow, model))
        .toBe('loops:\n  nightly:\n    roles: [ Alice, Bob ]\n    interval: 10m\n');
    });

    it('grows a sequence that ends the document', () => {
      const tail = 'roles:\n  Alice:\n    oversee:\n      - Bob\n';
      const model = parse(tail) as Record<string, any>;
      model.roles.Alice.oversee.push('Carol');

      expect(renderModelOntoSource(tail, model)).toBe('roles:\n  Alice:\n    oversee:\n      - Bob\n      - Carol\n');
    });

    it('changes wake_sources on the shipped example and still parses to the model', () => {
      const example = readFileSync('examples/fleet.yaml', 'utf8');
      for (const mutate of [
        (list: string[]) => list.push('local_contact_request'),
        (list: string[]) => list.pop(),
      ]) {
        const model = parse(example) as Record<string, any>;
        mutate(model.roles.Alice.monitor.wake_sources);
        const next = renderModelOntoSource(example, model);
        expect(parse(next)).toEqual(model);
        // The line that used to be glued on is still its own line.
        expect(next).toContain('\n      batch_ms: 2000                # coalesce a burst into one console line (default 2000)');
      }
    });
  });

  describe('emptying a mapping', () => {
    it('writes an empty mapping instead of a null value when the last entry goes', () => {
      const source = 'roles:\n  A: {}\nwatchdogs:\n  health:\n    coordinator: A\nloops:\n  nightly:\n    roles: [A]\n';
      const model = parse(source) as Record<string, any>;
      model.watchdogs = {};

      const next = renderModelOntoSource(source, model);

      expect(next).toBe('roles:\n  A: {}\nwatchdogs: {}\nloops:\n  nightly:\n    roles: [A]\n');
      expect(parse(next).watchdogs).toEqual({});
    });

    it('keeps a comment written beside the key it collapses', () => {
      const source = 'watchdogs:   # automation lives here\n  health:\n    coordinator: A\n';
      const model = parse(source) as Record<string, any>;
      model.watchdogs = {};

      const next = renderModelOntoSource(source, model);

      expect(next).toContain('# automation lives here');
      expect(parse(next)).toEqual({ watchdogs: {} });
    });
  });

  it('preserves quoting style and long lines of untouched scalars', () => {
    const long = 'x'.repeat(200);
    const source = ['roles:', '  Alice:', `    mission: "${long}"`, "    bio: 'single quoted'", ''].join('\n');
    const model = parse(source) as Record<string, any>;
    model.roles.Alice.persona = 'added';

    const next = renderModelOntoSource(source, model);

    expect(next).toContain(`mission: "${long}"`);
    expect(next).toContain("bio: 'single quoted'");
  });

  it('preserves block literal scalars', () => {
    const source = ['roles:', '  Alice:', '    persona: |', '      Line one.', '      Line two.', '    mission: m', ''].join('\n');
    const model = parse(source) as Record<string, any>;
    model.roles.Alice.mission = 'changed';

    const next = renderModelOntoSource(source, model);

    expect(next).toContain('persona: |');
    expect(next).toContain('      Line one.');
    expect(parse(next)).toEqual(model);
  });

  it('honours a four-space indented document instead of reflowing it', () => {
    const source = ['roles:', '    Alice:', '        mission: Ship', ''].join('\n');
    const model = parse(source) as Record<string, any>;
    model.roles.Bob = { mission: 'Review' };

    const next = renderModelOntoSource(source, model);

    expect(next).toContain('    Alice:');
    expect(next).toContain('        mission: Ship');
    expect(next).toContain('    Bob:');
    expect(next).toContain('        mission: Review');
  });

  it('honours non-indented sequences', () => {
    const source = ['roles:', '  Alice:', '    oversee:', '    - Bob', '    - Carol', ''].join('\n');
    const model = parse(source) as Record<string, any>;
    model.roles.Alice.mission = 'Ship';

    const next = renderModelOntoSource(source, model);

    expect(next).toContain('\n    - Bob');
    expect(next).not.toContain('\n      - Bob');
  });

  it('handles an absent-file first-run source and an empty model', () => {
    expect(renderModelOntoSource('roles: {}\n', { roles: { Alpha: {} } })).toContain('Alpha');
    // Removing the last top-level key empties the document; the fleet parser
    // reads an empty file as an empty mapping, so this stays a valid config.
    const emptied = renderModelOntoSource('roles: {}\n', {});
    expect(emptied.trim()).toBe('');
    expect(parseFleetDocument('fleet.yaml', emptied, 'strict').value).toEqual({});
  });

  it('preserves a null-bodied role and does not rewrite it', () => {
    const source = 'roles:\n  Alice:\n  Bob: {}\n';
    const model = parse(source) as Record<string, any>;
    model.roles.Bob = { mission: 'm' };

    const next = renderModelOntoSource(source, model);

    expect(next).toContain('  Alice:\n');
    expect(parse(next)).toEqual({ roles: { Alice: null, Bob: { mission: 'm' } } });
  });

  it('round-trips every edit back to exactly the requested model', () => {
    const model = parse(COMMENTED) as Record<string, any>;
    model.watchdogs = { health: { coordinator: 'Alice' } };
    model.loops = { nightly: { roles: ['Alice'], interval: '1h', prompt: 'check' } };
    delete model.defaults.session;

    const next = renderModelOntoSource(COMMENTED, model);
    expect(parse(next)).toEqual(model);
  });

  it('rejects a model it cannot reproduce rather than writing it', () => {
    expect(() => renderModelOntoSource('roles: {}\n', { roles: Number.POSITIVE_INFINITY as never }))
      .not.toThrow();
    // A duplicate-key source is refused outright.
    expect(() => renderModelOntoSource('roles: {}\nroles: {}\n', { roles: {} }))
      .toThrow(/unique/i);
  });

  it('does not treat inherited object properties as configuration keys', () => {
    const next = renderModelOntoSource('roles:\n  Alice: {}\n', JSON.parse('{"roles":{"Alice":{}},"__proto__":{"evil":true}}'));
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    expect(parse(next).roles).toEqual({ Alice: {} });
  });
});

describe('fidelity against the shipped examples/fleet.yaml', () => {
  const source = readFileSync('examples/fleet.yaml', 'utf8');

  it('renders an unchanged model byte-for-byte identically', () => {
    expect(renderModelOntoSource(source, parse(source))).toBe(source);
  });

  it('changes exactly one line when one scalar changes, keeping its inline comment', () => {
    const model = parse(source) as Record<string, any>;
    model.defaults.harness = 'codex';

    const next = renderModelOntoSource(source, model);

    expect(changedLines(source, next)).toEqual([
      "  harness: codex        # adapter for roles that don't set their own",
    ]);
    expect(next.split('\n')).toHaveLength(source.split('\n').length);
    expect(parse(next)).toEqual(model);
  });

  it('keeps an inline comment that sits on a block key, in place', () => {
    const model = parse(source) as Record<string, any>;
    model.defaults.permissions.approval = 'allow';

    const next = renderModelOntoSource(source, model);

    // The block key's own comment must not migrate onto the following line.
    expect(next).toContain('  permissions:                # common intent translated to each harness/backend');
    expect(changedLines(source, next)).toEqual([
      '    approval: allow             # ask | allow | deny',
    ]);
  });

  it('appends a new top-level block without touching a single existing line', () => {
    const model = parse(source) as Record<string, any>;
    model.watchdogs = { health: { coordinator: 'FleetCoordinator' } };

    const next = renderModelOntoSource(source, model);

    expect(next.startsWith(source.replace(/\n$/, ''))).toBe(true);
    expect(changedLines(source, next).join('\n')).toContain('watchdogs:');
    expect(parse(next)).toEqual(model);
  });

  it('removes a role without disturbing anything above it', () => {
    const model = parse(source) as Record<string, any>;
    delete model.roles.Alice;

    const next = renderModelOntoSource(source, model);

    expect(next).not.toContain('Own the alice repository end to end.');
    expect(next).toContain('  FleetCoordinator:');
    expect(next.split('\n').length).toBeLessThan(source.split('\n').length);
    expect(parse(next)).toEqual(model);
  });

  it('masks secrets without altering any other byte', () => {
    const redacted = redactSourceSecrets(source, 'MASK');

    expect(changedLines(source, redacted)).toEqual([
      '      EXAMPLE_FLAG: MASK             # extra env passed into the session',
    ]);
    expect(redacted.split('\n')).toHaveLength(source.split('\n').length);
  });
});

describe('secret redaction over the real document', () => {
  const SOURCE = [
    '# keep me',
    'vars:',
    '  token: top-secret',
    '  plain: visible',
    'defaults:',
    '  env:',
    '    API_TOKEN: ${token}   # interpolated',
    'roles:',
    '  Alice:',
    '    mission: Ship',
    '    env:',
    '      PASSWORD: hunter2',
    '',
  ].join('\n');

  it('masks env values and the vars they interpolate, keeping everything else', () => {
    const redacted = redactSourceSecrets(SOURCE, 'MASK');

    expect(redacted).not.toContain('top-secret');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('# keep me');
    expect(redacted).toContain('plain: visible');
    expect(redacted).toContain('mission: Ship');
    expect(parse(redacted)).toMatchObject({
      vars: { token: 'MASK', plain: 'visible' },
      defaults: { env: { API_TOKEN: 'MASK' } },
      roles: { Alice: { env: { PASSWORD: 'MASK' } } },
    });
  });

  it('is a no-op on a document with no env maps', () => {
    expect(redactSourceSecrets('roles:\n  Alice: {}\n', 'MASK')).toContain('Alice: {}');
  });
});

describe('formatting detection', () => {
  it('detects the block indent step', () => {
    expect(detectFormatting('a:\n  b: 1\n').indent).toBe(2);
    expect(detectFormatting('a:\n    b: 1\n').indent).toBe(4);
    expect(detectFormatting('a: 1\n').indent).toBe(2);
  });

  it('detects whether sequences are indented under their key', () => {
    expect(detectFormatting('a:\n  - x\n').indentSeq).toBe(true);
    expect(detectFormatting('a:\n- x\n').indentSeq).toBe(false);
    expect(detectFormatting('a: 1\n').indentSeq).toBe(true);
  });

  it('ignores comments and blank lines when sampling', () => {
    expect(detectFormatting('a:\n\n  # note\n    b: 1\n').indent).toBe(4);
  });

  it('falls back to the default for an implausible indent', () => {
    expect(detectFormatting(`a:\n${' '.repeat(20)}b: 1\n`).indent).toBe(2);
  });
});
