import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { ReadStream, WriteStream } from 'node:tty';
import { replaceFileAtomically, withFileLock } from './atomic-file.js';
import { loadConfig, splitRootFor } from './config.js';
import { packagedPresetRoot } from './preset-bootstrap.js';
import { listTemplates } from './rooms-tasks/templates.js';

export type Subscription = 'codex' | 'claude';
export type WorkKind = 'development' | 'review' | 'coordination';
export type ReasoningPreference = 'quick' | 'balanced' | 'thorough';

export interface CatalogModel {
  harness: 'codex' | 'claude-code';
  session: 'acp';
  model: string;
  efforts: string[];
}

export interface InitAnswers {
  subscriptions: Subscription[];
  models: Record<WorkKind, CatalogModel>;
  reasoning: ReasoningPreference;
}

export interface Choice<T> { label: string; value: T }

export interface InitPrompter {
  confirm(message: string, detail: string): Promise<boolean | undefined>;
  multiSelect<T>(message: string, choices: Choice<T>[]): Promise<T[] | undefined>;
  select<T>(message: string, choices: Choice<T>[], initial?: number): Promise<T | undefined>;
  note(message: string): void;
}

export interface BrainCatalog { schema_version: number; models: CatalogModel[] }

export interface GeneratedSetup { files: Map<string, string>; answers: InitAnswers }

export interface InitPublishResult {
  configPath: string;
  splitRoot: string;
  recoveryPath: string;
  replacedExisting: boolean;
}

const WORK_KINDS: WorkKind[] = ['development', 'review', 'coordination'];
const ROLE_WORK: Record<string, WorkKind> = {
  Developer: 'development', Critic: 'review',
  LocalCoordinator: 'coordination', Coordinator: 'coordination', FleetCoordinator: 'coordination',
};
const REASONING_EFFORT: Record<ReasoningPreference, 'low' | 'medium' | 'high'> = {
  quick: 'low', balanced: 'medium', thorough: 'high',
};
const MODEL_LABELS: Record<string, string> = {
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'claude-fable-5': 'Claude Fable 5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-sonnet-5': 'Claude Sonnet 5',
};

export function validateCatalog(value: BrainCatalog, path = 'supported model catalog'): BrainCatalog {
  if (value.schema_version !== 1 || !Array.isArray(value.models) || value.models.length === 0)
    throw new Error(`invalid supported model catalog: ${path}`);
  const tuples = new Set<string>();
  for (const model of value.models) {
    if (!['codex', 'claude-code'].includes(model.harness) || model.session !== 'acp'
      || typeof model.model !== 'string' || !MODEL_LABELS[model.model]
      || !Array.isArray(model.efforts) || model.efforts.length === 0
      || new Set(model.efforts).size !== model.efforts.length
      || model.efforts.some(effort => !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort))
      || !['low', 'medium', 'high'].every(effort => model.efforts.includes(effort)))
      throw new Error(`unsupported model state in ${path}`);
    const tuple = `${model.harness}\0${model.session}\0${model.model}`;
    if (tuples.has(tuple)) throw new Error(`duplicate supported model in ${path}: ${model.model}`);
    tuples.add(tuple);
  }
  return value;
}

function catalog(): BrainCatalog {
  const path = join(packagedPresetRoot(), 'brain-catalog.json');
  return validateCatalog(JSON.parse(readFileSync(path, 'utf8')) as BrainCatalog, path);
}

const subscriptionFor = (model: CatalogModel): Subscription =>
  model.harness === 'codex' ? 'codex' : 'claude';

export async function askInitQuestions(
  prompter: InitPrompter, configuration: string,
): Promise<InitAnswers | undefined> {
  const configPath = resolve(configuration);
  const splitRoot = splitRootFor(configPath);
  const confirmed = await prompter.confirm(
    'Add missing default Fleet configuration while preserving existing files. Continue?',
    `It will add missing defaults under ${configPath} and ${splitRoot}; existing configuration and templates remain byte-identical. Explicit default adoption is a separate migration. Identities and project files are not changed.`,
  );
  if (!confirmed) return undefined;

  const subscriptions = await prompter.multiSelect<Subscription>(
    'Which supported subscriptions do you have?',
    [{ label: 'Codex', value: 'codex' }, { label: 'Claude', value: 'claude' }],
  );
  if (!subscriptions) return undefined;
  if (subscriptions.length === 0) throw new Error('Select at least one subscription.');

  const available = catalog().models.filter(model => subscriptions.includes(subscriptionFor(model)));
  if (!available.length) throw new Error('None of the selected subscriptions has a supported model.');
  const choices = available.map(model => ({
    label: `${MODEL_LABELS[model.model]} (${subscriptionFor(model) === 'codex' ? 'Codex' : 'Claude'})`,
    value: model,
  }));
  const selected = {} as Record<WorkKind, CatalogModel>;
  for (const work of WORK_KINDS) {
    const model = await prompter.select(
      `Which model should handle ${work}?`, choices, 0,
    );
    if (!model) return undefined;
    selected[work] = model;
  }
  const reasoning = await prompter.select<ReasoningPreference>(
    'How much reasoning should Fleet use?',
    [
      { label: 'Quick — favor speed', value: 'quick' },
      { label: 'Balanced — everyday work', value: 'balanced' },
      { label: 'Thorough — harder work', value: 'thorough' },
    ], 1,
  );
  if (!reasoning) return undefined;
  const answers = { subscriptions: [...subscriptions].sort(), models: selected, reasoning };
  const summary = formatSetupSummary(answers);
  const finalized = await prompter.confirm(
    'Add this default Fleet setup?',
    `${summary}\n\nNo changes have been made yet.`,
  );
  return finalized ? answers : undefined;
}

export function formatSetupSummary(answers: InitAnswers): string {
  const friendly = (work: WorkKind) => `${MODEL_LABELS[answers.models[work].model]} via ${
    subscriptionFor(answers.models[work]) === 'codex' ? 'Codex' : 'Claude'}`;
  return [
    'Your default Fleet setup:',
    `  Development: ${friendly('development')}`,
    `  Review: ${friendly('review')}`,
    `  Coordination: ${friendly('coordination')}`,
    `  Reasoning: ${answers.reasoning[0].toUpperCase()}${answers.reasoning.slice(1)}`,
    '  Solo work: one development agent',
    '  Reviewed work: a development agent with an independent reviewer',
    '  Team work: coordination, development, and review specialists',
  ].join('\n');
}

function preset(relative: string): string {
  return readFileSync(join(packagedPresetRoot(), 'fleet', relative), 'utf8');
}

/** Build the exact, deterministic default experience without writing to disk. */
export function generateSetup(answers: InitAnswers): GeneratedSetup {
  const effort = REASONING_EFFORT[answers.reasoning];
  if (!effort) throw new Error(`unsupported reasoning preference: ${String(answers.reasoning)}`);
  if (!Array.isArray(answers.subscriptions) || answers.subscriptions.length === 0
    || new Set(answers.subscriptions).size !== answers.subscriptions.length
    || answers.subscriptions.some(subscription => !['codex', 'claude'].includes(subscription)))
    throw new Error('subscriptions must be a non-empty unique selection of Codex and/or Claude');
  const supported = catalog().models;
  const files = new Map<string, string>();
  files.set('fleet.yaml', [
    'api_version: ours.network/fleet/v2',
    '',
    'defaults:',
    '  permissions: { approval: ask, filesystem: workspace, unattended: deny }',
    '',
  ].join('\n'));
  for (const work of WORK_KINDS) {
    const proposed = answers.models[work];
    if (!proposed || !answers.subscriptions.includes(subscriptionFor(proposed)))
      throw new Error(`${work} uses a model outside the selected subscriptions`);
    const matches = supported.filter(model => model.harness === proposed.harness
      && model.session === proposed.session && model.model === proposed.model);
    if (matches.length !== 1) throw new Error(`${work} uses an unknown or ambiguous supported model`);
    const model = matches[0];
    if (JSON.stringify(proposed.efforts) !== JSON.stringify(model.efforts))
      throw new Error(`${work} contains tampered model capabilities`);
    if (!model.efforts.includes(effort)) throw new Error(`${MODEL_LABELS[model.model]} does not support ${answers.reasoning} reasoning`);
    files.set(`brains/${work}.yaml`, [
      `harness: ${model.harness}`,
      `session: ${model.session}`,
      `model: ${model.model}`,
      `effort: ${effort}`,
      '',
    ].join('\n'));
  }
  for (const role of ['Coordinator', 'LocalCoordinator', 'Developer', 'Critic']) {
    files.set(`roles/${role}.yaml`, preset(`roles/${role}.yaml`));
    if (role === 'Coordinator') continue;
    files.set(`agent_templates/${role}.yaml`, [
      `role: { ref: ${role} }`,
      `brain: { ref: ${ROLE_WORK[role]} }`,
      'coordinator: FleetCoordinator',
      'permissions: { approval: ask, filesystem: workspace, unattended: deny }',
      '',
    ].join('\n'));
  }
  files.set('agents/FleetCoordinator.yaml', preset('agents/FleetCoordinator.yaml')
    .replace('brain: { ref: claude-default }', 'brain: { ref: coordination }'));
  for (const name of ['single', 'pair', 'team'])
    files.set(`room_templates/${name}.yaml`, preset(`room_templates/${name}.yaml`));
  return { files, answers };
}

/** Run the mutation boundary only after the complete questionnaire is accepted. */
export async function executeInitWizard(
  prompter: InitPrompter,
  configuration: string,
  deps: {
    hostSetup(): Promise<void>;
    publish(configuration: string, setup: GeneratedSetup): Promise<InitPublishResult>;
    generate?(answers: InitAnswers): GeneratedSetup;
  },
): Promise<InitPublishResult | undefined> {
  const answers = await askInitQuestions(prompter, configuration);
  if (!answers) return undefined;
  // Resolve every catalog/preset dependency before crossing the first mutation
  // boundary. Production owns this new map; the optional seam forces failures
  // deterministically in tests.
  const setup = (deps.generate ?? generateSetup)(answers);
  await deps.hostSetup();
  return deps.publish(configuration, setup);
}

function canonicalGeneratedSetup(setup: GeneratedSetup): GeneratedSetup {
  const expected = generateSetup(setup.answers).files;
  const actualPaths = [...setup.files.keys()].sort();
  const expectedPaths = [...expected.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
    throw new Error('generated setup has an unexpected, missing, or unsafe file path');
  for (const path of expectedPaths) if (setup.files.get(path) !== expected.get(path))
    throw new Error(`generated setup content does not match the accepted answers: ${path}`);
  // Return the newly generated map, never the caller-owned map checked above.
  return { files: expected, answers: setup.answers };
}

function preserveExistingSetup(configPath: string, setup: GeneratedSetup): GeneratedSetup {
  const files = new Map(setup.files);
  if (existsSync(configPath)) files.set('fleet.yaml', readFileSync(configPath, 'utf8'));
  const root = splitRootFor(configPath);
  const visit = (directory: string, prefix = ''): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry); const relative = join(prefix, entry);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative);
      else files.set(relative, readFileSync(absolute, 'utf8'));
    }
  };
  visit(root);
  return { files, answers: setup.answers };
}

function assertOwnerPrivate(path: string, kind: 'file' | 'directory'): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory()))
    throw new Error(`init refuses non-regular ${kind}: ${path}`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`init refuses path owned by uid ${stat.uid}: ${path}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`init requires owner-private mode: ${path}`);
}

function assertPrivateTree(path: string): void {
  assertOwnerPrivate(path, 'directory');
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    const stat = lstatSync(child);
    if (stat.isDirectory()) assertPrivateTree(child);
    else assertOwnerPrivate(child, 'file');
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeStaged(stageManifest: string, setup: GeneratedSetup): void {
  const stageRoot = splitRootFor(stageManifest);
  for (const [relative, contents] of setup.files) {
    const target = relative === 'fleet.yaml' ? stageManifest : join(stageRoot, relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    chmodSync(dirname(target), 0o700);
    replaceFileAtomically(target, contents, 0o600);
    fsyncPath(target);
  }
  for (const kind of ['agents', 'agent_templates', 'roles', 'brains', 'room_templates'])
    fsyncPath(join(stageRoot, kind));
  fsyncPath(stageRoot);
  fsyncPath(dirname(stageManifest));
}

function validateStaged(stageManifest: string): void {
  const config = loadConfig(stageManifest, { yamlMode: 'strict' });
  const templates = listTemplates(config.roomTemplates ?? {});
  const names = new Set(templates.map(template => template.name));
  if (!['pair', 'single', 'team'].every(name => names.has(name)))
    throw new Error('generated setup did not resolve the default single, pair, and team experiences');
  for (const template of templates) for (const member of template.members)
    if (!config.agentTemplates?.[member.agent_template])
      throw new Error(`generated setup cannot resolve ${template.name} member ${member.agent_template}`);
  if (!config.roles.some(role => role.name === 'FleetCoordinator'))
    throw new Error('generated setup cannot resolve the default coordinator');
}

function inode(path: string): string {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}`;
}

/** Replace the complete configuration under one lock, retaining a private recovery copy. */
export async function publishSetup(
  configuration: string, setup: GeneratedSetup,
  hooks: {
    beforeArtifact?(entry: 'stage' | 'recovery'): void;
    beforePublish?(entry: 'root' | 'manifest'): void;
  } = {},
): Promise<InitPublishResult> {
  // The setup object is exported for deterministic tests and orchestration. Treat
  // it as untrusted here: no caller-provided path reaches join()/write before the
  // complete path set and contents are regenerated from the accepted answers.
  let canonicalSetup = canonicalGeneratedSetup(setup);
  const configPath = resolve(configuration);
  const splitRoot = splitRootFor(configPath);
  const parent = dirname(configPath);
  if (dirname(splitRoot) !== parent) throw new Error('manifest and configuration directory must share one parent');
  if (!existsSync(parent)) throw new Error(`configuration parent does not exist: ${parent}`);
  const parentStat = lstatSync(parent);
  const uid = process.getuid?.();
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (uid !== undefined && parentStat.uid !== uid) || (parentStat.mode & 0o022) !== 0)
    throw new Error(`init requires an owner-controlled, non-group/world-writable parent: ${parent}`);
  const stem = basename(splitRoot);
  return withFileLock(join(parent, `.${stem}.init.lock`), async () => {
    if (existsSync(configPath)) assertOwnerPrivate(configPath, 'file');
    if (existsSync(splitRoot)) assertPrivateTree(splitRoot);
    canonicalSetup = preserveExistingSetup(configPath, canonicalSetup);
    for (const target of [configPath, splitRoot]) if (existsSync(target) && statSync(target).dev !== parentStat.dev)
      throw new Error(`init requires same-filesystem publication: ${target}`);
    const manifestExisted = existsSync(configPath);
    const rootExisted = existsSync(splitRoot);

    const nonce = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${process.pid}-${randomUUID()}`;
    const stagePath = join(parent, `.${stem}.init-stage-${nonce}`);
    const recoveryPath = join(parent, `.${stem}.init-recovery-${nonce}`);
    const stageManifest = join(stagePath, 'fleet.yaml');
    const stageRoot = splitRootFor(stageManifest);
    let createdStage = false;
    let createdRecovery = false;
    let publishedRoot: string | undefined;
    let publishedManifest: string | undefined;
    let backedRoot = false;
    let backedManifest = false;
    try {
      hooks.beforeArtifact?.('stage');
      mkdirSync(stagePath, { mode: 0o700 }); createdStage = true;
      hooks.beforeArtifact?.('recovery');
      mkdirSync(recoveryPath, { mode: 0o700 }); createdRecovery = true;
      writeStaged(stageManifest, canonicalSetup);
      assertPrivateTree(stagePath);
      validateStaged(stageManifest);
      replaceFileAtomically(join(recoveryPath, 'state.json'), `${JSON.stringify({
        version: 1, configPath, splitRoot,
        manifestExisted, rootExisted,
      }, null, 2)}\n`, 0o600);
      fsyncPath(join(recoveryPath, 'state.json'));
      if (existsSync(splitRoot)) { renameSync(splitRoot, join(recoveryPath, 'fleet')); backedRoot = true; }
      if (existsSync(configPath)) { renameSync(configPath, join(recoveryPath, 'fleet.yaml')); backedManifest = true; }
      fsyncPath(recoveryPath);
      fsyncPath(parent);
      const rootProof = inode(stageRoot);
      hooks.beforePublish?.('root');
      if (existsSync(splitRoot)) throw new Error(`refusing to overwrite unproven path during publication: ${splitRoot}`);
      if (inode(stageRoot) !== rootProof) throw new Error(`staged configuration changed before publication: ${stageRoot}`);
      renameSync(stageRoot, splitRoot); publishedRoot = rootProof;
      fsyncPath(parent);
      const manifestProof = inode(stageManifest);
      hooks.beforePublish?.('manifest');
      if (existsSync(configPath)) throw new Error(`refusing to overwrite unproven path during publication: ${configPath}`);
      if (inode(stageManifest) !== manifestProof) throw new Error(`staged manifest changed before publication: ${stageManifest}`);
      renameSync(stageManifest, configPath); publishedManifest = manifestProof;
      fsyncPath(parent);
      validateStaged(configPath);
      rmSync(stagePath, { recursive: true });
      fsyncPath(parent);
      return { configPath, splitRoot, recoveryPath, replacedExisting: manifestExisted || rootExisted };
    } catch (error) {
      const publicationStarted = backedRoot || backedManifest || publishedRoot || publishedManifest;
      if (!publicationStarted) {
        if (createdStage) try { rmSync(stagePath, { recursive: true }); } catch { /* retain evidence */ }
        if (createdRecovery) try { rmSync(recoveryPath, { recursive: true }); } catch { /* retain evidence */ }
        fsyncPath(parent);
        throw new Error(`init preparation failed before publication; no configuration was changed: ${(error as Error).message}`, { cause: error });
      }
      let rollbackError: unknown;
      try {
        if (publishedManifest && existsSync(configPath) && inode(configPath) === publishedManifest)
          rmSync(configPath);
        if (publishedRoot && existsSync(splitRoot) && inode(splitRoot) === publishedRoot)
          rmSync(splitRoot, { recursive: true });
        if (backedRoot) {
          if (existsSync(splitRoot)) throw new Error(`refusing to overwrite unproven path during rollback: ${splitRoot}`);
          renameSync(join(recoveryPath, 'fleet'), splitRoot);
        }
        if (backedManifest) {
          if (existsSync(configPath)) throw new Error(`refusing to overwrite unproven path during rollback: ${configPath}`);
          renameSync(join(recoveryPath, 'fleet.yaml'), configPath);
        }
        fsyncPath(parent);
      } catch (rollback) { rollbackError = rollback; }
      if (rollbackError)
        throw new Error(`init publication and rollback failed; recovery evidence retained at ${recoveryPath}; staging retained at ${stagePath}: ${(rollbackError as Error).message}`, { cause: error });
      throw new Error(`init publication failed; original configuration restored; recovery evidence retained at ${recoveryPath}; staging retained at ${stagePath}: ${(error as Error).message}`, { cause: error });
    }
  });
}

type Key = 'up' | 'down' | 'space' | 'enter' | 'escape' | 'yes' | 'no' | 'other';

export function decodeKey(chunk: Buffer | string): Key {
  const value = chunk.toString();
  if (value === '\u001b[A') return 'up';
  if (value === '\u001b[B') return 'down';
  if (value === ' ') return 'space';
  if (value === '\r' || value === '\n') return 'enter';
  if (value === '\u001b' || value === '\u0003' || value === '\u0004') return 'escape';
  if (/^y$/i.test(value)) return 'yes';
  if (/^n$/i.test(value)) return 'no';
  return 'other';
}

export interface MultiSelectState { cursor: number; selected: boolean[] }

export function updateMultiSelect(state: MultiSelectState, key: Key): MultiSelectState {
  if (key === 'up') return { ...state, cursor: (state.cursor - 1 + state.selected.length) % state.selected.length };
  if (key === 'down') return { ...state, cursor: (state.cursor + 1) % state.selected.length };
  if (key === 'space') {
    const selected = [...state.selected]; selected[state.cursor] = !selected[state.cursor];
    return { ...state, selected };
  }
  return state;
}

export class TerminalPrompter implements InitPrompter {
  constructor(private readonly input: ReadStream, private readonly output: WriteStream) {}

  note(message: string): void { this.output.write(`${message}\n`); }

  async confirm(message: string, detail: string): Promise<boolean | undefined> {
    this.output.write(`\n${message}\n${detail}\nPress Y to continue or N to cancel. [N]\n`);
    for (;;) {
      const key = await this.key();
      if (key === 'yes') return true;
      if (key === 'no' || key === 'enter' || key === 'escape') return undefined;
    }
  }

  async multiSelect<T>(message: string, choices: Choice<T>[]): Promise<T[] | undefined> {
    let state: MultiSelectState = { cursor: 0, selected: choices.map(() => false) };
    let help = '↑/↓ move • Space toggle • Enter continue • Esc cancel';
    for (;;) {
      this.render(message, choices.map((choice, index) => `${state.selected[index] ? '[x]' : '[ ]'} ${choice.label}`), state.cursor,
        help);
      const key = await this.key();
      if (key === 'escape') return undefined;
      if (key === 'enter') {
        if (state.selected.some(Boolean)) return choices.filter((_, i) => state.selected[i]).map(choice => choice.value);
        help = 'Select at least one choice. • ↑/↓ move • Space toggle • Enter continue • Esc cancel';
      } else {
        state = updateMultiSelect(state, key);
        help = '↑/↓ move • Space toggle • Enter continue • Esc cancel';
      }
    }
  }

  async select<T>(message: string, choices: Choice<T>[], initial = 0): Promise<T | undefined> {
    let cursor = Math.max(0, Math.min(initial, choices.length - 1));
    for (;;) {
      this.render(message, choices.map(choice => choice.label), cursor, '↑/↓ move • Enter choose • Esc cancel');
      const key = await this.key();
      if (key === 'escape') return undefined;
      if (key === 'enter') return choices[cursor].value;
      if (key === 'up') cursor = (cursor - 1 + choices.length) % choices.length;
      if (key === 'down') cursor = (cursor + 1) % choices.length;
    }
  }

  private render(message: string, lines: string[], cursor: number, help: string): void {
    this.output.write(`\u001b[2J\u001b[H${message}\n\n`);
    lines.forEach((line, index) => this.output.write(`${index === cursor ? '❯' : ' '} ${line}\n`));
    this.output.write(`\n${help}\n`);
  }

  private key(): Promise<Key> {
    return new Promise((resolve, reject) => {
      const raw = this.input.isRaw;
      let settled = false;
      const cleanup = () => {
        this.input.off('data', onData);
        this.input.off('end', onEnd);
        this.input.off('error', onError);
        try { this.input.setRawMode(raw); } catch { /* stream is already closing */ }
        try { this.input.pause(); } catch { /* stream is already closing */ }
      };
      const finish = (key: Key) => {
        if (settled) return; settled = true; cleanup(); resolve(key);
      };
      const onData = (chunk: Buffer) => finish(decodeKey(chunk));
      const onEnd = () => finish('escape');
      const onError = (error: Error) => {
        if (settled) return; settled = true; cleanup(); reject(error);
      };
      try {
        this.input.setRawMode(true);
        this.input.once('data', onData);
        this.input.once('end', onEnd);
        this.input.once('error', onError);
        this.input.resume();
      } catch (error) { onError(error as Error); }
    });
  }
}

export const isInteractiveTerminal = (input: NodeJS.ReadStream, output: NodeJS.WriteStream): boolean =>
  input.isTTY === true && output.isTTY === true && typeof (input as ReadStream).setRawMode === 'function';
