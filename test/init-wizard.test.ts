import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  askInitQuestions, decodeKey, executeInitWizard, generateSetup, isInteractiveTerminal, publishSetup,
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
  it('begins with the preservation contract and names the complete seed scope', async () => {
    const config = join(root, 'custom.yaml');
    const prompt = new ScriptedPrompter([false]);
    await expect(askInitQuestions(prompt, config)).resolves.toBeUndefined();
    expect(prompt.calls).toEqual([expect.objectContaining({
      kind: 'confirm',
      message: 'Add missing default Fleet configuration while preserving existing files. Continue?',
      detail: expect.stringContaining('existing configuration and templates remain byte-identical'),
    })]);
  });

  it.each([
    { selected: [0], labels: ['Codex'], models: /\(Codex\)/ },
    { selected: [1], labels: ['Claude'], models: /\(Claude\)/ },
    { selected: [0, 1], labels: ['Codex', 'Claude'], models: /\((Codex|Claude)\)/ },
  ])('filters friendly model choices for subscription combination $labels', async ({ selected, models }) => {
    const prompt = new ScriptedPrompter([true, selected, 0, 0, 0, 1, true]);
    const result = await askInitQuestions(prompt, join(root, 'fleet.yaml'));
    expect(result?.subscriptions.sort()).toEqual(selected.map(index => index ? 'claude' : 'codex').sort());
    const selects = prompt.calls.filter(call => call.kind === 'select');
    expect(selects.slice(0, 3).map(call => call.message)).toEqual([
      'Which model should handle development?',
      'Which model should handle review?',
      'Which model should handle coordination?',
    ]);
    for (const call of selects.slice(0, 3)) {
      expect(call.labels?.every(label => models.test(label))).toBe(true);
      expect(call.labels?.every(label => !/gpt-5\.\d-[a-z]|claude-code|brain|preset|harness/i.test(label))).toBe(true);
    }
    expect(prompt.calls.filter(call => call.kind === 'note')).toEqual([]);
    const final = prompt.calls.filter(call => call.kind === 'confirm').at(-1);
    expect(final).toMatchObject({
      message: 'Add this default Fleet setup?',
      detail: expect.stringContaining('Solo work: one development agent'),
    });
    expect(final?.detail?.match(/Your default Fleet setup:/g)).toHaveLength(1);
  });

  it('cancels at every stage without asking later questions', async () => {
    for (const script of [[false], [true, undefined], [true, [0], undefined],
      [true, [0], 0, undefined], [true, [0], 0, 0, undefined], [true, [0], 0, 0, 0, undefined],
      [true, [0], 0, 0, 0, 1, false]]) {
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

  it.each([
    { name: 'first confirmation', script: [false] },
    { name: 'final confirmation', script: [true, [0], 0, 0, 0, 1, false] },
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
      new ScriptedPrompter([true, [0], 0, 0, 0, 1, true]), join(root, 'fleet.yaml'), {
        generate() { throw new Error('catalog became invalid'); },
        async hostSetup() { hostCalls++; },
        async publish() { publishCalls++; throw new Error('must not publish'); },
      },
    )).rejects.toThrow('catalog became invalid');
    expect({ hostCalls, publishCalls }).toEqual({ hostCalls: 0, publishCalls: 0 });
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
      subscriptions: ['codex', 'claude'], reasoning: 'balanced',
      models: {
        development: model('codex', 'gpt-5.6-sol'),
        review: model('claude-code', 'claude-opus-5'),
        coordination: model('codex', 'gpt-5.6-terra'),
      },
    });
    for (const role of ['Developer'])
      expect(generated.files.get(`agent_templates/${role}.yaml`)).toContain('brain: { ref: development }');
    for (const role of ['Critic'])
      expect(generated.files.get(`agent_templates/${role}.yaml`)).toContain('brain: { ref: review }');
    expect(generated.files.get('agent_templates/LocalCoordinator.yaml')).toContain('brain: { ref: coordination }');
    expect(generated.files.get('agents/FleetCoordinator.yaml')).toContain('brain: { ref: coordination }');
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
    for (const work of ['development', 'review', 'coordination'] as WorkKind[])
      expect(generateSetup(answers()).files.get(`brains/${work}.yaml`)?.match(/^model:/gm)).toHaveLength(1);
  });
});

describe('locked replacement transaction', () => {
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

  it('reruns without overwriting customized role, agent-template, or room-template bytes', async () => {
    const config = join(root, 'fleet.yaml');
    await publishSetup(config, generateSetup(answers(['codex'], 'quick')));
    const split = splitRootFor(config);
    const customized = {
      role: join(split, 'roles/Developer.yaml'),
      agent: join(split, 'agent_templates/Developer.yaml'),
      room: join(split, 'room_templates/single.yaml'),
    };
    const beforeManifest = readFileSync(config, 'utf8');
    const extra = join(split, 'roles/MyCustomRole.yaml');
    const extraAgent = join(split, 'agent_templates/MyCustomAgent.yaml');
    const extraRoom = join(split, 'room_templates/custom.yaml');
    writeFileSync(customized.role, 'mission: user role\n', { mode: 0o600 });
    writeFileSync(customized.agent, 'role: { inline: { mission: user agent } }\nbrain: { ref: development }\n', { mode: 0o600 });
    writeFileSync(customized.room, 'version: 99\ndescription: user room\nroom: {}\nmembers:\n  - { slot: developer, role: Developer, count: 1, agent_template: Developer }\n', { mode: 0o600 });
    writeFileSync(extra, 'mission: unrelated custom role\n', { mode: 0o600 });
    writeFileSync(extraAgent,
      'role: { inline: { mission: unrelated custom agent } }\nbrain: { ref: development }\n',
      { mode: 0o600 });
    writeFileSync(extraRoom,
      'version: 7\ndescription: unrelated custom room\nroom: {}\nmembers:\n  - { slot: custom, role: Custom, count: 1, agent_template: MyCustomAgent }\n',
      { mode: 0o600 });
    const result = await publishSetup(config, generateSetup(answers(['claude'], 'thorough')));
    expect(readFileSync(customized.role, 'utf8')).toBe('mission: user role\n');
    expect(readFileSync(customized.agent, 'utf8')).toContain('user agent');
    expect(readFileSync(customized.room, 'utf8')).toContain('user room');
    expect(readFileSync(config, 'utf8')).toBe(beforeManifest);
    expect(readFileSync(extra, 'utf8')).toBe('mission: unrelated custom role\n');
    expect(readFileSync(extraAgent, 'utf8')).toContain('unrelated custom agent');
    expect(readFileSync(extraRoom, 'utf8')).toContain('unrelated custom room');
    expect(result.replacedExisting).toBe(true);
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
});
