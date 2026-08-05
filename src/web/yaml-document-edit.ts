import {
  type Document, isMap, isPair, isScalar, parseDocument,
} from 'yaml';

/**
 * Surgical fleet-YAML editing.
 *
 * The web console edits a JSON *model* of the configuration, but the file on
 * disk belongs to the user. A `parse -> plain JS -> stringify` round-trip keeps
 * the data and destroys everything around it: comments, blank lines, key order,
 * quoting and indentation. Once graph gestures write `watchdogs:`/`loops:` on
 * every edit that stops being a one-off annoyance.
 *
 * So instead of re-serializing the model, we reconcile it onto the parsed
 * `Document`: only paths whose value actually changed are touched, and every
 * untouched node keeps its original representation.
 */

const PARSE_OPTIONS = { strict: true, uniqueKeys: true, prettyErrors: true } as const;
const MIN_INDENT = 1;
const MAX_INDENT = 8;
const DEFAULT_INDENT = 2;

export type YamlModel = Record<string, unknown>;

/** Formatting of the source document, so a surgical edit does not reflow it. */
export interface DocumentFormatting {
  indent: number;
  indentSeq: boolean;
}

/**
 * Apply `model` to `source`, returning the new document text.
 *
 * Guarantees:
 * - unchanged subtrees keep their comments, order, quoting and line breaks;
 * - the result parses back to exactly `model` (verified before returning, so a
 *   reconciliation bug can never silently write something else to disk).
 */
export function renderModelOntoSource(source: string, model: YamlModel): string {
  const document = parseSource(source);
  const current = documentValue(document);
  reconcile(document, [], current, model);

  const formatting = detectFormatting(source);
  const rendered = restoreCommentAlignment(
    source, document.toString({ lineWidth: 0, ...formatting }));

  const check = parseSource(rendered);
  if (!deepEqual(documentValue(check), model))
    throw new Error('surgical YAML edit did not reproduce the requested model');
  return rendered;
}

/**
 * Replace every `defaults.env` / `roles.*.env` value — and every `vars:` entry
 * those values interpolate — with `marker`, keeping the document otherwise
 * intact. Used to render a review diff of the real file without leaking secrets.
 */
export function redactSourceSecrets(source: string, marker: string): string {
  const document = parseSource(source);
  const secretVars = new Set<string>();

  const redactEnvMap = (path: string[]): void => {
    const node = document.getIn(path, true);
    if (!isMap(node)) return;
    for (const item of node.items) {
      if (!isPair(item)) continue;
      if (isScalar(item.value) && typeof item.value.value === 'string')
        for (const match of item.value.value.matchAll(/\$\{(\w+)\}/g)) secretVars.add(match[1]);
      item.value = document.createNode(marker);
    }
  };

  redactEnvMap(['defaults', 'env']);
  for (const name of mapKeys(document, ['roles'])) redactEnvMap(['roles', name, 'env']);

  const vars = document.getIn(['vars'], true);
  if (isMap(vars)) for (const item of vars.items) {
    if (isPair(item) && isScalar(item.key) && secretVars.has(String(item.key.value)))
      item.value = document.createNode(marker);
  }
  return restoreCommentAlignment(
    source, document.toString({ lineWidth: 0, ...detectFormatting(source) }));
}

/**
 * `yaml` keeps a comment's text but not the padding in front of it, so a
 * re-render collapses column-aligned trailing comments to a single space —
 * a whole-file reflow on every save. Put the original spacing back on lines
 * that are otherwise byte-identical to the source. Ambiguous or altered lines
 * are left as rendered, and `renderModelOntoSource` re-parses the result
 * afterwards, so this can never change what the file means.
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

/**
 * Best-effort detection of the document's block indentation, so re-rendering a
 * hand-written file does not reflow every nested line. Detection failure falls
 * back to the library defaults; correctness never depends on it.
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
  return node.items.flatMap(item =>
    isPair(item) && isScalar(item.key) ? [String(item.key.value)] : []);
}

/**
 * Walk `next` against `current`, touching the document only where they differ.
 * Mappings recurse key-by-key; sequences of equal length recurse element-wise
 * (so editing one entry keeps the others' comments) and are otherwise replaced
 * wholesale, because index-shifting edits cannot be attributed reliably.
 */
function reconcile(
  document: Document,
  path: Array<string | number>,
  current: unknown,
  next: unknown,
): void {
  if (deepEqual(current, next)) return;

  if (isPlainObject(current) && isPlainObject(next)) {
    for (const key of Object.keys(next)) reconcile(document, [...path, key], own(current, key), own(next, key));
    for (const key of Object.keys(current)) if (!hasOwn(next, key)) document.deleteIn([...path, key]);
    return;
  }

  if (Array.isArray(current) && Array.isArray(next) && current.length === next.length) {
    for (const [index, value] of next.entries()) reconcile(document, [...path, index], current[index], value);
    return;
  }

  if (next === undefined) {
    document.deleteIn(path);
    return;
  }
  if (path.length === 0) document.contents = document.createNode(next);
  else document.setIn(path, document.createNode(next));
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
