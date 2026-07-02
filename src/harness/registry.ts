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
