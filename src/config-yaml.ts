import {
  LineCounter, isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments,
} from 'yaml';

export type YamlMode = 'compat' | 'strict';
export type ConfigDiagnosticKind =
  | 'anchor' | 'alias' | 'explicit-tag' | 'non-scalar-key' | 'multiple-documents'
  | 'deprecated-field';

export interface ConfigDiagnostic {
  severity: 'warning';
  kind: ConfigDiagnosticKind;
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface ParsedFleetDocument {
  value: Record<string, unknown>;
  diagnostics: ConfigDiagnostic[];
}

const position = (counter: LineCounter, node: unknown): { line: number; column: number } => {
  const start = (node as { range?: [number] } | undefined)?.range?.[0] ?? 0;
  const at = counter.linePos(start);
  return { line: at.line, column: at.col };
};

/**
 * Parse fleet-owned YAML with an explicit, shared contract. Duplicate keys and
 * syntax errors always fail. YAML graph/type features are warning-first in
 * compat mode and fail under strict mode.
 */
export function parseFleetDocument(
  file: string,
  text: string,
  yamlMode: YamlMode = 'compat',
): ParsedFleetDocument {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, {
    strict: true,
    uniqueKeys: true,
    lineCounter,
    prettyErrors: true,
  });
  const parseErrors = documents.flatMap(document => document.errors);
  if (parseErrors.length) throw new Error(`${file}: ${parseErrors.map(error => error.message).join('; ')}`);

  const diagnostics: ConfigDiagnostic[] = [];
  const add = (kind: ConfigDiagnosticKind, node: unknown, description: string) => {
    const at = position(lineCounter, node);
    diagnostics.push({
      severity: 'warning',
      kind,
      file,
      ...at,
      message: `${file}:${at.line}:${at.column}: non-plain YAML ${description}`,
    });
  };

  if (documents.length > 1)
    add('multiple-documents', documents[1]?.contents, 'multiple documents');

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const tagged = node as { anchor?: string; tag?: string };
    if (tagged.anchor) add('anchor', node, `anchor '&${tagged.anchor}'`);
    if (tagged.tag) add('explicit-tag', node, `explicit tag '${tagged.tag}'`);
    if (isAlias(node)) {
      add('alias', node, `alias '*${String((node as { source?: unknown }).source ?? '')}'`);
      return;
    }
    if (isMap(node)) {
      for (const item of node.items) {
        if (!isPair(item)) continue;
        if (!isScalar(item.key)) add('non-scalar-key', item.key, 'non-scalar mapping key');
        walk(item.key);
        walk(item.value);
      }
      return;
    }
    if (isSeq(node)) for (const item of node.items) walk(item);
  };
  for (const document of documents) walk(document.contents);

  const unique = diagnostics.filter((diagnostic, index, all) =>
    all.findIndex(other => other.kind === diagnostic.kind
      && other.line === diagnostic.line && other.column === diagnostic.column) === index);
  if (yamlMode === 'strict' && unique.length)
    throw new Error(unique.map(diagnostic => diagnostic.message).join('; '));

  const first = documents[0];
  const value = first?.contents == null
    ? {}
    : first.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${file}: top-level YAML document must be a mapping`);
  return { value, diagnostics: unique };
}
