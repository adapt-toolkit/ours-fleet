import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  askInitQuestions, decodeKey, executeInitWizard, formatSetupSummary, generateSetup,
  isInteractiveTerminal, preflightInitPaths, publishSetup,
  TerminalPrompter, updateMultiSelect, validateCatalog,
  type CatalogModel, type Choice, type InitAnswers, type InitPrompter, type ReasoningPreference,
  type Subscription, type WorkKind,
} from '../src/init-wizard.js';
import { loadConfig, splitRootFor } from '../src/config.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ours-fleet-init-wizard-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

class ScriptedPrompter implements InitPrompter {
  calls: Array<{ kind: string; message: string; labels?: string[]; detail?: string }> = [];
  constructor(private readonly script: unknown[]) {}
  note(message: string): void { this.calls.push({ kind: 'note', message }); }
  async confirm(message: string, detail: string): Promise<boolean | undefined> {
    this.calls.push({ kind: 'confirm', message, detail });
    return this.script.shift() as boolean | undefined;
  }
  async multiSelect<T>(message: string, choices: Choice<T>[]): Promise<T[] | undefined> {
    this.calls.push({ kind: 'multi', message, labels: choices.map(choice => choice.label) });
    const indexes = this.script.shift() as number[] | undefined;
    return indexes?.map(index => choices[index].value);
  }
  async select<T>(message: string, choices: Choice<T>[]): Promise<T | undefined> {
    this.calls.push({ kind: 'select', message, labels: choices.map(choice => choice.label) });
    const index = this.script.shift() as number | undefined;
    return index === undefined ? undefined : choices[index].value;
  }
}

function model(harness: CatalogModel['harness'], name: string): CatalogModel {
  const efforts = harness === 'claude-code'
    ? ['low', 'medium', 'high', 'xhigh', 'max']
    : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  return { harness, session: 'acp', model: name, efforts };
}

function answers(
  subscriptions: Subscription[] = ['codex'],
  reasoning: ReasoningPreference = 'balanced',
): InitAnswers {
  const selected = subscriptions[0] === 'codex'
    ? model('codex', 'gpt-5.6-sol') : model('claude-code', 'claude-opus-5');
  return {
    subscriptions,
    assignmentStrategy: 'one-model',
    reasoning,
    models: { development: selected, review: selected, coordination: selected },
  };
}

function treeSnapshot(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = join(directory, entry); const relative = join(prefix, entry);
      if (lstatSync(absolute).isDirectory()) visit(absolute, relative);
      else out[relative] = readFileSync(absolute, 'utf8');
    }
  };
  visit(path);
  return out;
}

describe('interactive questionnaire', () => {
  it('begins with the exact destructive warning and names complete overwrite scope', async () => {
    const config = join(root, 'custom.yaml');
    const prompt = new ScriptedPrompter([false]);
    await expect(askInitQuestions(prompt, config)).resolves.toBeUndefined();
    expect(prompt.calls).toEqual([expect.objectContaining({
      kind: 'confirm',
      message: 'This command will replace your Fleet configuration with the defaults. Continue?',
      detail: expect.stringContaining(`${config} and ${splitRootFor(config)}`),
    })]);
  });

  it.each([
    { selected: [0], labels: ['Codex'], models: /\(Codex\)/, poolSize: 7 },
    { selected: [1], labels: ['Claude'], models: /\(Claude\)/, poolSize: 3 },
    { selected: [0, 1], labels: ['Codex', 'Claude'], models: /\((Codex|Claude)\)/, poolSize: 10 },
  ])('supports one-model subscription combination $labels', async ({ selected, models, poolSize }) => {
    const prompt = new ScriptedPrompter([true, selected, 0, 0, 1, true]);
    const result = await askInitQuestions(prompt, join(root, 'fleet.yaml'));
    expect(result?.subscriptions.sort()).toEqual(selected.map(index => index ? 'claude' : 'codex').sort());
    expect(result?.assignmentStrategy).toBe('one-model');
    expect(new Set(Object.values(result!.models).map(entry => entry.model)).size).toBe(1);
    const selects = prompt.calls.filter(call => call.kind === 'select');
    expect(selects.map(call => call.message)).toEqual([
      'How should models be assigned?',
      'Which model should handle every job?',
      'How much reasoning should Fleet use?',
    ]);
    expect(selects[1].labels?.every(label => models.test(label))).toBe(true);
    expect(selects[1].labels).toHaveLength(poolSize);
    expect(selects[1].labels?.every(label => /— (gpt-|claude-)/.test(label))).toBe(true);
    expect(prompt.calls.filter(call => call.kind === 'note').at(0)?.message).toMatch(/not recommendations.*entitlement/s);
    const final = prompt.calls.filter(call => call.kind === 'confirm').at(-1);
    expect(final).toMatchObject({
      message: 'Create this default Fleet setup?',
      detail: expect.stringContaining('One-agent work: one development Agent'),
    });
    expect(final?.detail).toContain(join(root, 'fleet.yaml'));
    expect(final?.detail).toContain(splitRootFor(join(root, 'fleet.yaml')));
    expect(final?.detail).toContain('no model_chain is generated');
    expect(final?.detail).toContain('run ours-fleet doctor for Codex');
    expect(final?.detail).toContain('Claude is validated when a role launches');
    expect(final?.detail).toContain('hard termination');
    expect(final?.detail?.match(/Your default Fleet setup:/g)).toHaveLength(1);
  });

  it('supports a deliberate both-provider per-job mix', async () => {
    const prompt = new ScriptedPrompter([true, [0, 1], 1, 0, 8, 1, 2, true]);
    const result = await askInitQuestions(prompt, join(root, 'fleet.yaml'));
    expect(result).toMatchObject({
      assignmentStrategy: 'per-job', reasoning: 'thorough',
      models: {
        development: { harness: 'codex', model: 'gpt-5.6-sol' },
        review: { harness: 'claude-code', model: 'claude-opus-5' },
        coordination: { harness: 'codex', model: 'gpt-5.6-terra' },
      },
    });
    expect(prompt.calls.filter(call => call.kind === 'select').map(call => call.message)).toEqual([
      'How should models be assigned?',
      'Which model should handle development?',
      'Which model should handle review?',
      'Which model should handle coordination?',
      'How much reasoning should Fleet use?',
    ]);
  });

  it('cancels at every stage without asking later questions', async () => {
    for (const script of [[false], [true, undefined], [true, [0], undefined],
      [true, [0], 0, undefined], [true, [0], 0, 0, undefined],
      [true, [0], 0, 0, 1, false],
      [true, [0], 1, undefined], [true, [0], 1, 0, undefined],
      [true, [0], 1, 0, 0, undefined], [true, [0], 1, 0, 0, 0, undefined],
      [true, [0], 1, 0, 0, 0, 1, false]]) {
      const prompt = new ScriptedPrompter(script);
      await expect(askInitQuestions(prompt, join(root, 'fleet.yaml'))).resolves.toBeUndefined();
    }
  });

  it('provides actual arrow/space multi-select navigation with wrapping', () => {
    let state = { cursor: 0, selected: [false, false] };
    state = updateMultiSelect(state, decodeKey('\u001b[A'));
    expect(state.cursor).toBe(1);
    state = updateMultiSelect(state, decodeKey(' '));
    state = updateMultiSelect(state, decodeKey('\u001b[B'));
    state = updateMultiSelect(state, decodeKey(' '));
    expect(state).toEqual({ cursor: 0, selected: [true, true] });
    expect(decodeKey('\r')).toBe('enter');
    expect(decodeKey('\u001b')).toBe('escape');
    expect(decodeKey('\u0003')).toBe('escape');
    expect(decodeKey('\u0004')).toBe('escape');
  });

  it('drives the real multi-select with visible arrow/space/enter state and cleans raw mode', async () => {
    class Input extends EventEmitter {
      isTTY = true; isRaw = false; paused = false;
      setRawMode(value: boolean) { this.isRaw = value; }
      resume() { this.paused = false; return this; }
      pause() { this.paused = true; return this; }
    }
    const input = new Input(); let rendered = '';
    const output = { isTTY: true, write(chunk: string) { rendered += chunk; return true; } };
    const prompt = new TerminalPrompter(input as unknown as import('node:tty').ReadStream,
      output as unknown as import('node:tty').WriteStream);
    const pending = prompt.multiSelect('Which subscriptions?', [
      { label: 'Codex', value: 'codex' }, { label: 'Claude', value: 'claude' },
    ]);
    const key = async (value: string) => {
      while (input.listenerCount('data') === 0) await new Promise(resolve => setImmediate(resolve));
      input.emit('data', Buffer.from(value));
    };
    await key('\r'); // empty selection is refused
    await key(' ');  // Codex
    await key('\u001b[B');
    await key(' ');  // Claude
    await key('\r');
    await expect(pending).resolves.toEqual(['codex', 'claude']);
    expect(rendered).toContain('Select at least one choice.');
    expect(rendered).toContain('[x] Codex');
    expect(rendered).toContain('[x] Claude');
    expect(rendered).toContain('↑/↓ move • Space toggle • Enter continue');
    expect(rendered).not.toMatch(/type.*(Codex|Claude)/i);
    expect(input.isRaw).toBe(false);
    expect(input.paused).toBe(true);
    expect(input.listenerCount('data') + input.listenerCount('end') + input.listenerCount('error')).toBe(0);
  });

  it('labels a single-select cursor as a current highlight until Enter records it', async () => {
    class Input extends EventEmitter {
      isTTY = true; isRaw = false;
      setRawMode(value: boolean) { this.isRaw = value; }
      resume() { return this; }
      pause() { return this; }
    }
    const input = new Input(); let rendered = '';
    const output = { isTTY: true, write(chunk: string) { rendered += chunk; return true; } };
    const prompt = new TerminalPrompter(input as unknown as import('node:tty').ReadStream,
      output as unknown as import('node:tty').WriteStream);
    const pending = prompt.select('Choose explicitly', [
      { label: 'First', value: 'first' }, { label: 'Second', value: 'second' },
    ], 0);
    while (input.listenerCount('data') === 0) await new Promise(resolve => setImmediate(resolve));
    let settled = false; void pending.then(() => { settled = true; });
    input.emit('data', Buffer.from('n'));
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    while (input.listenerCount('data') === 0) await new Promise(resolve => setImmediate(resolve));
    input.emit('data', Buffer.from('\u001b[B'));
    while (input.listenerCount('data') === 0) await new Promise(resolve => setImmediate(resolve));
    input.emit('data', Buffer.from('\r'));
    await expect(pending).resolves.toBe('second');
    expect(rendered).toContain('Current highlight only');
    expect(rendered).toContain('Enter records choice');
  });

  it('keeps entitlement and recommendation notes visible while pickers redraw', async () => {
    class Input extends EventEmitter {
      isTTY = true; isRaw = false;
      setRawMode(value: boolean) { this.isRaw = value; }
      resume() { return this; }
      pause() { return this; }
    }
    const input = new Input(); let rendered = '';
    const output = { isTTY: true, write(chunk: string) { rendered += chunk; return true; } };
    const prompt = new TerminalPrompter(input as unknown as import('node:tty').ReadStream,
      output as unknown as import('node:tty').WriteStream);
    prompt.note('Supported IDs are not recommendations; entitlement is checked later.');
    const pending = prompt.select('Choose explicitly', [{ label: 'Model', value: 'model' }]);
    while (input.listenerCount('data') === 0) await new Promise(resolve => setImmediate(resolve));
    input.emit('data', Buffer.from('\r'));
    await pending;
    expect(rendered.match(/not recommendations/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    { name: 'first confirmation', script: [false] },
    { name: 'final confirmation', script: [true, [0], 0, 0, 1, false] },
  ])('does not cross the mutation boundary after cancellation at $name', async ({ script }) => {
    let hostCalls = 0; let publishCalls = 0;
    const result = await executeInitWizard(
      new ScriptedPrompter(script), join(root, 'fleet.yaml'), {
        async hostSetup() { hostCalls++; },
        async publish() { publishCalls++; throw new Error('must not publish'); },
      },
    );
    expect(result).toBeUndefined();
    expect({ hostCalls, publishCalls }).toEqual({ hostCalls: 0, publishCalls: 0 });
  });

  it('resolves the complete setup before host or publication mutation boundaries', async () => {
    let hostCalls = 0; let publishCalls = 0;
    await expect(executeInitWizard(
      new ScriptedPrompter([true, [0], 0, 0, 1, true]), join(root, 'fleet.yaml'), {
        generate() { throw new Error('catalog became invalid'); },
        async hostSetup() { hostCalls++; },
        async publish() { publishCalls++; throw new Error('must not publish'); },
      },
    )).rejects.toThrow('catalog became invalid');
    expect({ hostCalls, publishCalls }).toEqual({ hostCalls: 0, publishCalls: 0 });
  });

  it('warns that host state may have changed when locked publication revalidation fails', async () => {
    let hostCalls = 0;
    await expect(executeInitWizard(
      new ScriptedPrompter([true, [0], 0, 0, 1, true]), join(root, 'fleet.yaml'), {
        async hostSetup() { hostCalls++; },
        async publish() { throw new Error('locked path revalidation refused a symlink'); },
      },
    )).rejects.toThrow(/Host setup completed.*may have changed.*locked path revalidation/s);
    expect(hostCalls).toBe(1);
  });

  it('warns about partial host state and skips publication when host setup fails', async () => {
    let publishCalls = 0;
    await expect(executeInitWizard(
      new ScriptedPrompter([true, [0], 0, 0, 1, true]), join(root, 'fleet.yaml'), {
        async hostSetup() { throw new Error('backend reload failed'); },
        async publish() { publishCalls++; throw new Error('must not publish'); },
      },
    )).rejects.toThrow(/Host setup failed.*may have changed.*configuration was not published.*backend reload failed/s);
    expect(publishCalls).toBe(0);
  });

  it('treats terminal EOF as cancellation and restores raw mode/listeners', async () => {
    class Input extends EventEmitter {
      isTTY = true; isRaw = false; paused = false;
      setRawMode(value: boolean) { this.isRaw = value; }
      resume() { this.paused = false; return this; }
      pause() { this.paused = true; return this; }
    }
    const input = new Input();
    const output = { isTTY: true, write() { return true; } };
    const prompt = new TerminalPrompter(input as unknown as import('node:tty').ReadStream,
      output as unknown as import('node:tty').WriteStream);
    const pending = prompt.confirm('warning', 'scope');
    input.emit('end');
    await expect(pending).resolves.toBeUndefined();
    expect(input.isRaw).toBe(false);
    expect(input.paused).toBe(true);
    expect(input.listenerCount('data') + input.listenerCount('end') + input.listenerCount('error')).toBe(0);
  });

  it('rejects terminal errors and restores raw mode/listeners', async () => {
    class Input extends EventEmitter {
      isTTY = true; isRaw = false;
      setRawMode(value: boolean) { this.isRaw = value; }
      resume() { return this; }
      pause() { return this; }
    }
    const input = new Input();
    const output = { isTTY: true, write() { return true; } };
    const prompt = new TerminalPrompter(input as unknown as import('node:tty').ReadStream,
      output as unknown as import('node:tty').WriteStream);
    const pending = prompt.confirm('warning', 'scope');
    input.emit('error', new Error('terminal closed'));
    await expect(pending).rejects.toThrow('terminal closed');
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data') + input.listenerCount('end') + input.listenerCount('error')).toBe(0);
  });

  it('detects non-interactive and incomplete terminal streams', () => {
    expect(isInteractiveTerminal({ isTTY: false } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream)).toBe(false);
    expect(isInteractiveTerminal({ isTTY: true } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream)).toBe(false);
    expect(isInteractiveTerminal({ isTTY: true, setRawMode() {} } as unknown as NodeJS.ReadStream,
      { isTTY: true } as NodeJS.WriteStream)).toBe(true);
  });
});

describe('deterministic default mapping', () => {
  it('rejects duplicate model tuples, efforts, and unknown effort states', () => {
    const valid = model('codex', 'gpt-5.6-sol');
    expect(() => validateCatalog({ schema_version: 1, models: [valid, structuredClone(valid)] }))
      .toThrow(/duplicate supported model/);
    expect(() => validateCatalog({ schema_version: 1, models: [
      { ...valid, efforts: ['low', 'medium', 'high', 'high'] },
    ] })).toThrow(/unsupported model state/);
    expect(() => validateCatalog({ schema_version: 1, models: [
      { ...valid, efforts: ['low', 'medium', 'high', 'impossible'] },
    ] })).toThrow(/unsupported model state/);
  });

  it.each([
    ['quick', 'low'], ['balanced', 'medium'], ['thorough', 'high'],
  ] as const)('maps %s reasoning to %s for every outcome', (preference, effort) => {
    const generated = generateSetup(answers(['codex'], preference));
    for (const work of ['development', 'review', 'coordination'] as WorkKind[])
      expect(generated.files.get(`brains/${work}.yaml`)).toContain(`effort: ${effort}`);
  });

  it('maps default single/pair/team and coordinator roles to chosen outcomes', () => {
    const generated = generateSetup({
      subscriptions: ['codex', 'claude'], assignmentStrategy: 'per-job', reasoning: 'balanced',
      models: {
        development: model('codex', 'gpt-5.6-sol'),
        review: model('claude-code', 'claude-opus-5'),
        coordination: model('codex', 'gpt-5.6-terra'),
      },
    });
    for (const role of ['Agent', 'Developer', 'Secretary'])
      expect(generated.files.get(`agent_templates/${role}.yaml`)).toContain('brain: { ref: development }');
    for (const role of ['Critic', 'Tester'])
      expect(generated.files.get(`agent_templates/${role}.yaml`)).toContain('brain: { ref: review }');
    expect(generated.files.get('agent_templates/Architect.yaml')).toContain('brain: { ref: coordination }');
    expect(generated.files.get('agents/FleetCoordinator.yaml')).toContain('brain: { ref: coordination }');
    expect(generated.files.get('room_templates/single.yaml')).toContain('agent_template: Agent');
    expect(generated.files.get('room_templates/pair.yaml')).toContain('agent_template: Secretary');
    expect(generated.files.get('room_templates/pair.yaml')).toContain('agent_template: Critic');
    for (const role of ['Architect', 'Developer', 'Tester'])
      expect(generated.files.get('room_templates/team.yaml')).toContain(`agent_template: ${role}`);
  });

  it('generates a catalog-valid Claude setup without claiming or inventing entitlement fallback', () => {
    const generated = generateSetup(answers(['claude'], 'thorough'));
    for (const work of ['development', 'review', 'coordination'] as WorkKind[]) {
      const brain = generated.files.get(`brains/${work}.yaml`)!;
      expect(brain).toContain('harness: claude-code');
      expect(brain).toContain('model: claude-opus-5');
      expect(brain).toContain('effort: high');
      expect(brain).not.toContain('model_chain');
    }
  });

  it('is byte-deterministic and rejects subscription/model or effort mismatches', () => {
    const first = generateSetup(answers());
    const second = generateSetup(answers());
    expect([...first.files]).toEqual([...second.files]);
    expect(() => generateSetup({ ...answers(['claude']), models: answers(['codex']).models }))
      .toThrow(/outside the selected subscriptions/);
    const unsupported = model('codex', 'gpt-5.6-sol'); unsupported.efforts = ['low'];
    expect(() => generateSetup({ ...answers(['codex'], 'thorough'),
      models: { development: unsupported, review: unsupported, coordination: unsupported } }))
      .toThrow(/tampered model capabilities/);
    const unknown = model('codex', 'invented-model');
    expect(() => generateSetup({ ...answers(),
      models: { development: unknown, review: unknown, coordination: unknown } }))
      .toThrow(/unknown or ambiguous supported model/);
    expect(() => generateSetup({ ...answers(), subscriptions: ['codex', 'codex'] }))
      .toThrow(/non-empty unique selection/);
    expect(() => generateSetup({ ...answers(), subscriptions: ['codex', 'other' as Subscription] }))
      .toThrow(/non-empty unique selection/);
    expect(() => generateSetup({ ...answers(), reasoning: 'impossible' as ReasoningPreference }))
      .toThrow(/unsupported reasoning preference/);
    expect(() => generateSetup({ ...answers(), assignmentStrategy: 'impossible' as InitAnswers['assignmentStrategy'] }))
      .toThrow(/unsupported model assignment strategy/);
    for (const work of ['development', 'review', 'coordination'] as WorkKind[])
      expect(generateSetup(answers()).files.get(`brains/${work}.yaml`)?.match(/^model:/gm)).toHaveLength(1);
  });

  it('blocks an inconsistent one-model answer and allows the same explicit per-job mix', () => {
    const mixed: InitAnswers = {
      subscriptions: ['codex', 'claude'], assignmentStrategy: 'one-model', reasoning: 'balanced',
      models: {
        development: model('codex', 'gpt-5.6-sol'),
        review: model('claude-code', 'claude-opus-5'),
        coordination: model('codex', 'gpt-5.6-terra'),
      },
    };
    expect(() => generateSetup(mixed)).toThrow(/one-model assignment requires the same exact model/);
    expect(() => generateSetup({ ...mixed, assignmentStrategy: 'per-job' })).not.toThrow();
  });
});

describe('review and preflight safety', () => {
  it.each([
    { manifest: false, root: false, phrase: 'neither target exists' },
    { manifest: true, root: false, phrase: 'only the manifest exists' },
    { manifest: false, root: true, phrase: 'only the split configuration directory exists' },
    { manifest: true, root: true, phrase: 'both targets exist' },
  ])('summarizes target state $phrase', ({ manifest, root: hasRoot, phrase }) => {
    const config = join(root, 'fleet.yaml');
    if (manifest) writeFileSync(config, 'old\n', { mode: 0o600 });
    if (hasRoot) mkdirSync(splitRootFor(config), { mode: 0o700 });
    const summary = formatSetupSummary(answers(), config);
    expect(summary).toContain(`Manifest: ${config}`);
    expect(summary).toContain(`Split configuration: ${splitRootFor(config)}`);
    expect(summary).toContain(phrase);
    expect(summary).toContain('Balanced -> medium');
    expect(summary).toContain('catalog support is not a recommendation or entitlement claim');
    expect(summary).toContain('no model_chain is generated');
  });

  it('rejects unsafe mode before host setup begins', async () => {
    chmodSync(root, 0o777);
    let hostCalls = 0;
    await expect(executeInitWizard(
      new ScriptedPrompter([true, [0], 0, 0, 1, true]), join(root, 'fleet.yaml'), {
        async hostSetup() { hostCalls++; },
        async publish() { throw new Error('must not publish'); },
      },
    )).rejects.toThrow(/owner-controlled/);
    expect(hostCalls).toBe(0);
  });

  it('fails closed for injected foreign ownership and cross-device targets', () => {
    const config = join(root, 'fleet.yaml');
    writeFileSync(config, 'old\n', { mode: 0o600 });
    expect(() => preflightInitPaths(config, {
      lstat: path => {
        const actual = lstatSync(path);
        if (path === config) return new Proxy(actual, {
          get(target, property) { return property === 'uid' ? Number(target.uid) + 1 : Reflect.get(target, property, target); },
        });
        return actual;
      },
    })).toThrow(/owned by uid/);
    expect(() => preflightInitPaths(config, {
      stat: path => {
        const actual = lstatSync(path);
        if (path === config) return new Proxy(actual, {
          get(target, property) { return property === 'dev' ? Number(target.dev) + 1 : Reflect.get(target, property, target); },
        });
        return actual;
      },
    })).toThrow(/same-filesystem/);
  });

  it('rejects a missing or symlinked configuration parent', () => {
    expect(() => preflightInitPaths(join(root, 'missing', 'fleet.yaml'))).toThrow(/parent does not exist/);
    const real = join(root, 'real-parent');
    const linked = join(root, 'linked-parent');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, linked);
    expect(() => preflightInitPaths(join(linked, 'fleet.yaml'))).toThrow(/owner-controlled/);
  });
});

describe('locked replacement transaction', () => {
  it('serializes on the per-setup init lock', async () => {
    const config = join(root, 'fleet.yaml');
    const lock = join(root, '.fleet.init.lock');
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, 'ts'), String(Date.now()));
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'contender', pid: process.pid }));
    const started = Date.now();
    const release = setTimeout(() => rmSync(lock, { recursive: true, force: true }), 100);
    try {
      await publishSetup(config, generateSetup(answers()));
    } finally { clearTimeout(release); }
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    expect(readFileSync(config, 'utf8')).toContain('api_version: ours.network/fleet/v2');
  });

  it.each([
    ['traversal', (setup: ReturnType<typeof generateSetup>) => setup.files.set('../victim', 'owned\n')],
    ['absolute', (setup: ReturnType<typeof generateSetup>) => setup.files.set('/tmp/ours-fleet-init-victim', 'owned\n')],
    ['normalized traversal', (setup: ReturnType<typeof generateSetup>) => setup.files.set('brains/../victim', 'owned\n')],
    ['missing', (setup: ReturnType<typeof generateSetup>) => setup.files.delete('fleet.yaml')],
    ['extra', (setup: ReturnType<typeof generateSetup>) => setup.files.set('brains/extra.yaml', 'owned\n')],
  ])('rejects a %s generated-file set before any filesystem mutation', async (_name, mutate) => {
    const config = join(root, 'fleet.yaml');
    writeFileSync(config, 'original\n', { mode: 0o600 });
    const setup = generateSetup(answers());
    mutate(setup);
    await expect(publishSetup(config, setup)).rejects.toThrow(/unexpected, missing, or unsafe file path/);
    expect(readFileSync(config, 'utf8')).toBe('original\n');
    expect(existsSync(splitRootFor(config))).toBe(false);
    expect(readdirSync(root)).toEqual(['fleet.yaml']);
  });

  it('rejects tampered expected-path content before any filesystem mutation', async () => {
    const config = join(root, 'fleet.yaml');
    const setup = generateSetup(answers());
    setup.files.set('fleet.yaml', 'tampered\n');
    await expect(publishSetup(config, setup)).rejects.toThrow(/content does not match/);
    expect(readdirSync(root)).toEqual([]);
  });

  it('publishes only the captured canonical setup if the caller map mutates after validation', async () => {
    const config = join(root, 'fleet.yaml');
    const setup = generateSetup(answers());
    const result = await publishSetup(config, setup, {
      beforeArtifact(entry) {
        if (entry !== 'stage') return;
        setup.files.set('../../victim', 'unsafe\n');
        setup.files.set('fleet.yaml', 'tampered after validation\n');
      },
    });
    expect(existsSync(join(root, 'victim'))).toBe(false);
    expect(readFileSync(config, 'utf8')).toContain('api_version: ours.network/fleet/v2');
    expect(readFileSync(config, 'utf8')).not.toContain('tampered after validation');
    expect(result.replacedExisting).toBe(false);
  });

  it('publishes a complete valid private setup and retains absent markers', async () => {
    const config = join(root, 'fleet.yaml');
    const result = await publishSetup(config, generateSetup(answers()));
    expect(loadConfig(config, { yamlMode: 'strict' }).roles.map(role => role.name)).toEqual(['FleetCoordinator']);
    expect(lstatSync(config).mode & 0o777).toBe(0o600);
    expect(lstatSync(splitRootFor(config)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(result.recoveryPath, 'state.json'), 'utf8')))
      .toMatchObject({ manifestExisted: false, rootExisted: false });
  });

  it.each([
    { manifest: true, existingRoot: false },
    { manifest: false, existingRoot: true },
  ])('backs up exactly the partial prior targets $manifest/$existingRoot and publishes a complete pair', async ({ manifest, existingRoot }) => {
    const config = join(root, 'fleet.yaml');
    if (manifest) writeFileSync(config, 'old manifest\n', { mode: 0o600 });
    if (existingRoot) {
      mkdirSync(splitRootFor(config), { mode: 0o700 });
      writeFileSync(join(splitRootFor(config), 'old.yaml'), 'old root\n', { mode: 0o600 });
    }
    const result = await publishSetup(config, generateSetup(answers()));
    const state = JSON.parse(readFileSync(join(result.recoveryPath, 'state.json'), 'utf8'));
    expect(state).toMatchObject({ manifestExisted: manifest, rootExisted: existingRoot });
    expect(existsSync(join(result.recoveryPath, 'fleet.yaml'))).toBe(manifest);
    expect(existsSync(join(result.recoveryPath, 'fleet'))).toBe(existingRoot);
    expect(existsSync(config)).toBe(true);
    expect(existsSync(splitRootFor(config))).toBe(true);
  });

  it('reruns deterministically and retains the complete previous configuration', async () => {
    const config = join(root, 'fleet.yaml');
    await publishSetup(config, generateSetup(answers(['codex'], 'quick')));
    const beforeManifest = readFileSync(config, 'utf8');
    const beforeRoot = treeSnapshot(splitRootFor(config));
    const result = await publishSetup(config, generateSetup(answers(['claude'], 'thorough')));
    expect(readFileSync(join(result.recoveryPath, 'fleet.yaml'), 'utf8')).toBe(beforeManifest);
    expect(treeSnapshot(join(result.recoveryPath, 'fleet'))).toEqual(beforeRoot);
    expect(readFileSync(join(splitRootFor(config), 'brains/development.yaml'), 'utf8'))
      .toContain('model: claude-opus-5');
  });

  it('rolls back both targets after an injected second-publication failure', async () => {
    const config = join(root, 'fleet.yaml');
    await publishSetup(config, generateSetup(answers(['codex'], 'quick')));
    const beforeManifest = readFileSync(config, 'utf8');
    const beforeRoot = treeSnapshot(splitRootFor(config));
    await expect(publishSetup(config, generateSetup(answers(['claude'], 'thorough')), {
      beforePublish(entry) { if (entry === 'manifest') throw new Error('injected publication failure'); },
    })).rejects.toThrow(/original configuration restored/);
    expect(readFileSync(config, 'utf8')).toBe(beforeManifest);
    expect(treeSnapshot(splitRootFor(config))).toEqual(beforeRoot);
  });

  it('cleans its own staging artifact when recovery preparation fails', async () => {
    const config = join(root, 'fleet.yaml');
    await expect(publishSetup(config, generateSetup(answers()), {
      beforeArtifact(entry) { if (entry === 'recovery') throw new Error('recovery unavailable'); },
    })).rejects.toThrow(/preparation failed before publication; no configuration was changed/);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(splitRootFor(config))).toBe(false);
    expect(readdirSync(root).filter(name => name.includes('init-stage') || name.includes('init-recovery')))
      .toEqual([]);
  });

  it('never overwrites an unproven path during rollback and retains recovery evidence', async () => {
    const config = join(root, 'fleet.yaml');
    await publishSetup(config, generateSetup(answers(['codex'], 'quick')));
    let failure: Error | undefined;
    try {
      await publishSetup(config, generateSetup(answers(['claude'], 'thorough')), {
        beforePublish(entry) {
          if (entry === 'manifest') writeFileSync(config, 'foreign\n', { mode: 0o600 });
        },
      });
    } catch (error) { failure = error as Error; }
    expect(failure?.message).toMatch(/publication and rollback failed; recovery evidence retained/);
    expect(readFileSync(config, 'utf8')).toBe('foreign\n');
    const match = failure?.message.match(/retained at ([^;]+);/);
    expect(match).toBeTruthy();
    expect(readFileSync(join(match![1], 'fleet.yaml'), 'utf8')).toContain('api_version: ours.network/fleet/v2');
  });

  it('refuses symlink and unsafe existing targets before staging', async () => {
    const real = join(root, 'real.yaml');
    writeFileSync(real, 'old\n', { mode: 0o600 });
    const linked = join(root, 'linked.yaml');
    symlinkSync(real, linked);
    await expect(publishSetup(linked, generateSetup(answers()))).rejects.toThrow(/non-regular file/);
    expect(readdirSync(root).some(name => name.includes('init-stage'))).toBe(false);

    const config = join(root, 'unsafe.yaml');
    writeFileSync(config, 'old\n', { mode: 0o644 });
    mkdirSync(splitRootFor(config), { mode: 0o700 });
    chmodSync(config, 0o644);
    await expect(publishSetup(config, generateSetup(answers()))).rejects.toThrow(/owner-private/);
  });

  it('refuses a symlink anywhere inside the existing split tree', async () => {
    const config = join(root, 'fleet.yaml');
    mkdirSync(splitRootFor(config), { mode: 0o700 });
    writeFileSync(join(root, 'outside'), 'old\n', { mode: 0o600 });
    symlinkSync(join(root, 'outside'), join(splitRootFor(config), 'linked'));
    expect(() => preflightInitPaths(config)).toThrow(/non-regular file/);
  });

  it.skipIf(process.platform === 'win32')('retains inspectable evidence after a hard kill during publication', async () => {
    const config = join(root, 'fleet.yaml');
    await publishSetup(config, generateSetup(answers(['codex'], 'quick')));
    const before = new Set(readdirSync(root));
    const child = join(root, 'hard-kill.mjs');
    const moduleUrl = new URL('../dist/init-wizard.js', import.meta.url).href;
    const claudeHarnessUrl = new URL('../dist/harness/claude-code.js', import.meta.url).href;
    const codexHarnessUrl = new URL('../dist/harness/codex.js', import.meta.url).href;
    writeFileSync(child, [
      `import ${JSON.stringify(claudeHarnessUrl)};`,
      `import ${JSON.stringify(codexHarnessUrl)};`,
      `import { generateSetup, publishSetup } from ${JSON.stringify(moduleUrl)};`,
      `const model = { harness: 'claude-code', session: 'acp', model: 'claude-opus-5', efforts: ['low','medium','high','xhigh','max'] };`,
      `const answers = { subscriptions: ['claude'], assignmentStrategy: 'one-model', reasoning: 'thorough', models: { development: model, review: model, coordination: model } };`,
      `await publishSetup(${JSON.stringify(config)}, generateSetup(answers), { beforePublish(entry) { if (entry === 'manifest') process.kill(process.pid, 'SIGKILL'); } });`,
    ].join('\n'), { mode: 0o600 });
    const result = spawnSync(process.execPath, [child], { encoding: 'utf8' });
    expect(result.signal).toBe('SIGKILL');
    expect(existsSync(config)).toBe(false);
    expect(readFileSync(join(splitRootFor(config), 'brains/development.yaml'), 'utf8'))
      .toContain('model: claude-opus-5');
    const created = readdirSync(root).filter(name => !before.has(name) && name !== 'hard-kill.mjs');
    expect(created.some(name => name.includes('init-recovery'))).toBe(true);
    expect(created.some(name => name.includes('init-stage'))).toBe(true);
  });
});
