import type { HarnessAdapter } from './types.js';

const adapters = new Map<string, HarnessAdapter>();

export function registerAdapter(a: HarnessAdapter): void {
  // Enforced here rather than left to the type system: an adapter that silently
  // omits the capability is how the neutral-permission warnings ended up with no
  // caller and no reader.
  if (typeof a.translatePermissions !== 'function')
    throw new Error(
      `harness adapter '${a.id}' must implement translatePermissions(): either translate ` +
      `neutral permissions or return { supported: false, reason }`);
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
