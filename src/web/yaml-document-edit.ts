import {
  Document, type Node, type Pair, type Scalar,
  isMap, isPair, isScalar, isSeq, parseDocument,
} from 'yaml';

/**
 * Surgical fleet-YAML editing.
 *
 * The web console edits a JSON *model* of the configuration, but the file on
 * disk belongs to the user. A `parse -> plain JS -> stringify` round-trip keeps
 * the data and destroys everything around it. Re-rendering the parsed document
 * is barely better: `yaml` keeps a comment's text but not its position, so
 * `permissions:   # note` comes back as `permissions:` with the note moved onto
 * the next line, shifting everything below it. On `examples/fleet.yaml` a plain
 * round-trip rewrites 80 of 147 lines.
 *
 * So edits are computed as *text splices* against the original bytes. Only the
 * regions that genuinely changed are replaced; everything else is byte-identical
 * by construction, which makes an unchanged save a true no-op and keeps a trailing
 * inline comment attached to the scalar it annotates.
 *
 * A model change that cannot be expressed as a splice falls back to re-rendering
 * the document. That path does reflow, which is why the caller diffs the real
 * before/after bytes: reflow must be visible in review, never silent.
 *
 * Deleting a mapping entry leaves any comment written above it in place. Removing
 * a value must not quietly remove the operator's prose about it.
 */

const PARSE_OPTIONS = { strict: true, uniqueKeys: true, prettyErrors: true } as const;
const MIN_INDENT = 1;
const MAX_INDENT = 8;
const DEFAULT_INDENT = 2;

export type YamlModel = Record<string, unknown>;

/** Formatting of the source document, so a rewrite does not reflow it. */
export interface DocumentFormatting {
  indent: number;
  indentSeq: boolean;
}

/** A replacement of `source[start, end)`. */
interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Apply `model` to `source`, returning the new document text.
 *
 * Guarantees:
 * - an unchanged model returns `source` byte for byte;
 * - regions outside a change keep their bytes whenever the change is spliceable;
 * - the result parses back to exactly `model`, verified before returning, so a
 *   planning bug can never silently write something else to disk.
 */
export function renderModelOntoSource(source: string, model: YamlModel): string {
  const document = parseSource(source);
  const formatting = detectFormatting(source);
  const plan: Splice[] = [];
  const spliceable = planEdits(document, source, formatting, [], documentValue(document), model, plan);

  const rendered = !spliceable ? reRender(document, source, formatting, model)
    : plan.length === 0 ? source
      : applySplices(source, plan);

  const check = parseSource(rendered);
  if (!deepEqual(documentValue(check), model))
    throw new Error('surgical YAML edit did not reproduce the requested model');
  return rendered;
}

/**
 * Replace every `defaults.env` / `roles.*.env` value — and every `vars:` entry
 * those values interpolate — with `marker`.
 *
 * Splices the scalars out of the original bytes rather than re-rendering, so the
 * only difference from `source` is the secrets themselves. Redaction must not be
 * able to introduce (or conceal) a formatting change in a review diff.
 */
export function redactSourceSecrets(source: string, marker: string): string {
  const document = parseSource(source);
  const secretVars = new Set<string>();
  const plan: Splice[] = [];

  const redactEnvMap = (path: string[]): void => {
    const node = document.getIn(path, true);
    if (!isMap(node)) return;
    for (const item of node.items) {
      if (!isPair(item) || !isScalar(item.value)) continue;
      if (typeof item.value.value === 'string')
        for (const match of item.value.value.matchAll(/\$\{(\w+)\}/g)) secretVars.add(match[1]);
      pushValueSplice(plan, item.value, marker);
    }
  };

  redactEnvMap(['defaults', 'env']);
  for (const name of mapKeys(document, ['roles'])) redactEnvMap(['roles', name, 'env']);

  const vars = document.getIn(['vars'], true);
  if (isMap(vars)) for (const item of vars.items) {
    if (isPair(item) && isScalar(item.key) && isScalar(item.value)
      && secretVars.has(String(item.key.value))) pushValueSplice(plan, item.value, marker);
  }
  return plan.length === 0 ? source : applySplices(source, plan);
}

function pushValueSplice(plan: Splice[], node: Scalar, marker: string): void {
  const range = node.range;
  if (range) plan.push({ start: range[0], end: range[1], text: marker });
}

/**
 * Best-effort detection of the document's block indentation, used only when a
 * change is not spliceable and the document has to be re-rendered. Detection
 * failure falls back to the library defaults; correctness never depends on it.
 */
export function detectFormatting(source: string): DocumentFormatting {
  const lines = source.split('\n')
    .filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'));
  let indent: number | undefined;
  let indentSeq: boolean | undefined;
  let previousWidth = 0;
  let previousOpensBlock = false;

  for (const line of lines) {
    const width = line.length - line.trimStart().length;
    const isItem = /^-(\s|$)/.test(line.trimStart());
    if (previousOpensBlock && width >= previousWidth) {
      if (isItem) indentSeq ??= width > previousWidth;
      if (width > previousWidth) indent ??= width - previousWidth;
    }
    previousOpensBlock = !isItem && /:\s*(#.*)?$/.test(line);
    previousWidth = width;
  }
  return {
    indent: indent !== undefined && indent >= MIN_INDENT && indent <= MAX_INDENT
      ? indent : DEFAULT_INDENT,
    indentSeq: indentSeq ?? true,
  };
}

/* ------------------------------------------------------------------ *
 * Planning: turn a model diff into text splices
 * ------------------------------------------------------------------ */

/**
 * Walk `next` against `current` and record the splices that would realise it.
 * Returns false as soon as a change cannot be expressed against the source text,
 * in which case the caller re-renders instead.
 */
function planEdits(
  document: Document,
  source: string,
  formatting: DocumentFormatting,
  path: Array<string | number>,
  current: unknown,
  next: unknown,
  plan: Splice[],
): boolean {
  if (deepEqual(current, next)) return true;

  if (isPlainObject(current) && isPlainObject(next)) {
    const node = document.getIn(path, true);
    if (!isMap(node)) return false;
    // Removing every entry one by one would leave `watchdogs:` with no value,
    // which reads back as null rather than the empty mapping that was asked for.
    if (path.length > 0 && Object.keys(next).length === 0 && Object.keys(current).length > 0)
      return planReplace(document, source, formatting, path, next, plan);
    for (const key of Object.keys(current))
      if (!hasOwn(next, key) && !planDelete(node, source, key, plan)) return false;
    for (const key of Object.keys(next)) {
      if (hasOwn(current, key)) {
        if (!planEdits(document, source, formatting, [...path, key], own(current, key), own(next, key), plan))
          return false;
      } else if (!planInsert(node, source, formatting, key, own(next, key), plan)) return false;
    }
    return true;
  }

  if (Array.isArray(current) && Array.isArray(next) && current.length === next.length)
    return next.every((value, index) =>
      planEdits(document, source, formatting, [...path, index], current[index], value, plan));

  return planReplace(document, source, formatting, path, next, plan);
}

/** Replace one value in place, keeping the key, its layout and its comment. */
function planReplace(
  document: Document,
  source: string,
  formatting: DocumentFormatting,
  path: Array<string | number>,
  next: unknown,
  plan: Splice[],
): boolean {
  if (path.length === 0) return false;
  const node = document.getIn(path, true);
  if (!isNodeWithRange(node)) return false;

  // A block scalar's body cannot be swapped for an inline one by splicing.
  if (isScalar(node) && (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED')) return false;

  const start = node.range[0];
  // A block collection's range runs past the newline that terminates it, while a
  // scalar's stops at the value. Splicing over that newline would pull the next
  // line up onto this one, so leave it where it is.
  let end = node.range[1];
  while (end > start && source[end - 1] === '\n') end -= 1;

  const ownLine = source.slice(lineStart(source, start), start).trim() === '';
  // `roles: [Alice]` must not come back as a block list just because it grew.
  const flow = (isSeq(node) || isMap(node)) && node.flow === true;
  const text = renderValue(next, formatting, flow);

  // An emptied collection belongs beside its key, not alone on the next line.
  if (ownLine && (text === '{}' || text === '[]')
    && planCollapseOntoKey(document, source, path, start, end, text, plan)) return true;

  if (text.includes('\n') && !ownLine) return false;

  plan.push({ start, end, text: ownLine ? indentContinuation(text, columnOf(source, start)) : text });
  return true;
}

/** Rewrite `key:\n  <block>` as `key: {}` when the block became empty. */
function planCollapseOntoKey(
  document: Document,
  source: string,
  path: Array<string | number>,
  start: number,
  end: number,
  text: string,
  plan: Splice[],
): boolean {
  const key = path[path.length - 1];
  if (typeof key !== 'string') return false;
  const parent = document.getIn(path.slice(0, -1), true);
  const pair = parent === undefined ? undefined : findPair(parent as Node, key);
  if (!pair || !isNodeWithRange(pair.key)) return false;
  const colon = source.indexOf(':', pair.key.range[1]);
  // Anything but whitespace between the key and its value is a comment; keep it.
  if (colon < 0 || colon >= start || source.slice(colon + 1, start).trim() !== '') return false;
  plan.push({ start: colon + 1, end, text: ` ${text}` });
  return true;
}

/** Remove a whole `key: value` entry, including the line it sits on. */
function planDelete(node: Node, source: string, key: string, plan: Splice[]): boolean {
  const pair = findPair(node, key);
  if (!pair || !isNodeWithRange(pair.key)) return false;
  const end = isNodeWithRange(pair.value) ? pair.value.range[2] : pair.key.range[2];
  plan.push({ start: lineStart(source, pair.key.range[0]), end, text: '' });
  return true;
}

/** Append a new `key: value` entry to an existing block mapping. */
function planInsert(
  node: Node,
  source: string,
  formatting: DocumentFormatting,
  key: string,
  value: unknown,
  plan: Splice[],
): boolean {
  if (!isMap(node) || node.flow) return false;
  const last = [...node.items].reverse().find(isPair);
  // An empty mapping has no sibling to copy an indent or a position from.
  if (!last || !isNodeWithRange(last.key)) return false;
  const column = columnOf(source, last.key.range[0]);
  const at = isNodeWithRange(last.value) ? last.value.range[2] : last.key.range[2];
  const entry = indentContinuation(renderValue({ [key]: value }, formatting), column);
  const prefix = at > 0 && source[at - 1] !== '\n' ? '\n' : '';
  plan.push({ start: at, end: at, text: `${prefix}${' '.repeat(column)}${entry}\n` });
  return true;
}

function applySplices(source: string, plan: Splice[]): string {
  const ordered = [...plan].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const splice of ordered) out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
  return out;
}

/* ------------------------------------------------------------------ *
 * Fallback: re-render the whole document
 * ------------------------------------------------------------------ */

function reRender(
  document: Document,
  source: string,
  formatting: DocumentFormatting,
  model: YamlModel,
): string {
  applyToDocument(document, [], documentValue(document), model);
  return restoreCommentAlignment(source, document.toString({ lineWidth: 0, ...formatting }));
}

function applyToDocument(
  document: Document,
  path: Array<string | number>,
  current: unknown,
  next: unknown,
): void {
  if (deepEqual(current, next)) return;
  if (isPlainObject(current) && isPlainObject(next)) {
    for (const key of Object.keys(next)) applyToDocument(document, [...path, key], own(current, key), own(next, key));
    for (const key of Object.keys(current)) if (!hasOwn(next, key)) document.deleteIn([...path, key]);
    return;
  }
  if (Array.isArray(current) && Array.isArray(next) && current.length === next.length) {
    for (const [index, value] of next.entries()) applyToDocument(document, [...path, index], current[index], value);
    return;
  }
  if (next === undefined) { document.deleteIn(path); return; }
  // Mutating an existing scalar keeps its comment and quoting; replacing it loses both.
  const existing = document.getIn(path, true);
  if (isScalar(existing) && isScalarValue(next) && existing.type !== 'BLOCK_LITERAL' && existing.type !== 'BLOCK_FOLDED') {
    existing.value = next;
    return;
  }
  if (path.length === 0) document.contents = document.createNode(next);
  else document.setIn(path, document.createNode(next));
}

/**
 * `yaml` keeps a comment's text but not the padding in front of it. Put the
 * original spacing back on lines that are otherwise byte-identical to the
 * source; ambiguous or altered lines are left as rendered, and the caller
 * re-parses the result, so this can never change what the file means.
 */
function restoreCommentAlignment(source: string, rendered: string): string {
  const AMBIGUOUS = '';
  const originals = new Map<string, string>();
  for (const line of source.split('\n')) {
    const at = trailingCommentIndex(line);
    if (at < 0) continue;
    const collapsed = `${line.slice(0, at).replace(/\s+$/, '')} ${line.slice(at)}`;
    if (collapsed === line) continue;
    originals.set(collapsed, originals.has(collapsed) ? AMBIGUOUS : line);
  }
  if (originals.size === 0) return rendered;
  return rendered.split('\n').map(line => originals.get(line) || line).join('\n');
}

/** Index of a line's trailing `#` comment, ignoring `#` inside quoted scalars. */
function trailingCommentIndex(line: string): number {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character !== "'") continue;
      if (line[index + 1] === "'") index += 1; else quote = undefined;
    } else if (quote === '"') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '#' && index > 0 && /\s/.test(line[index - 1])) return index;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function parseSource(source: string): Document {
  const document = parseDocument(source, PARSE_OPTIONS);
  if (document.errors.length)
    throw new Error(document.errors.map(error => error.message).join('; '));
  return document;
}

function documentValue(document: Document): unknown {
  return document.contents == null ? {} : document.toJS({ maxAliasCount: 100 });
}

function mapKeys(document: Document, path: string[]): string[] {
  const node = document.getIn(path, true);
  if (!isMap(node)) return [];
  return node.items.flatMap(item => (isPair(item) && isScalar(item.key) ? [String(item.key.value)] : []));
}

function findPair(node: Node, key: string): Pair | undefined {
  if (!isMap(node)) return undefined;
  return node.items.find((item): item is Pair =>
    isPair(item) && isScalar(item.key) && String(item.key.value) === key);
}

function renderValue(value: unknown, formatting: DocumentFormatting, flow = false): string {
  const document = new Document(value);
  if (flow && (isSeq(document.contents) || isMap(document.contents))) document.contents.flow = true;
  return document
    .toString({ lineWidth: 0, indent: formatting.indent, indentSeq: formatting.indentSeq })
    .replace(/\n$/, '');
}

/** Indent every line but the first, which is spliced in after existing text. */
function indentContinuation(text: string, column: number): string {
  if (!text.includes('\n')) return text;
  const pad = ' '.repeat(column);
  return text.split('\n').map((line, index) => (index === 0 || line === '' ? line : `${pad}${line}`)).join('\n');
}

const lineStart = (source: string, offset: number): number => source.lastIndexOf('\n', offset - 1) + 1;
const columnOf = (source: string, offset: number): number => offset - lineStart(source, offset);

type RangedNode = Node & { range: [number, number, number] };

function isNodeWithRange(node: unknown): node is RangedNode {
  return (isScalar(node) || isMap(node) || isSeq(node)) && Array.isArray((node as { range?: unknown }).range);
}

function isScalarValue(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return hasOwn(value, key) ? value[key] : undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  const [left, right] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => hasOwn(right, key) && deepEqual(left[key], right[key]));
}
