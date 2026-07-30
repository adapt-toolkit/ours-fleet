import type { HarnessAdapter } from './types.js';

const adapters = new Map<string, HarnessAdapter>();

export function registerAdapter(a: HarnessAdapter): void {
  adapters.set(a.id, a);
}

export function getAdapter(id: string): HarnessAdapter {
  const a = adapters.get(id);
  if (!a) throw new Error(`unknown harness '${id}'; registered: ${[...adapters.keys()].join(', ') || '(none)'}`);
  return a;
}

export function knownAdapters(): string[] {
  return [...adapters.keys()];
}

/**
 * The adapters ours-fleet ships. Tests register extras, so "everything in the
 * registry" is not the same question — this is the set doctor falls back to
 * when a broken configuration names no harness at all.
 */
const PRODUCTION_ADAPTERS = ['claude-code', 'codex'];

/** Production adapters actually registered in this process. */
export function productionAdapters(): string[] {
  return PRODUCTION_ADAPTERS.filter(id => adapters.has(id));
}
