import type { AcpBodyBrainAdapterDescriptor, HarnessAdapter } from './types.js';
import { createAcpBodyBrainInjectedProvider } from '../session/acp-body-brain-provider.js';

const adapters = new Map<string, HarnessAdapter>();
const bodyBrainAdapters = new Map<string, AcpBodyBrainAdapterDescriptor>();

const BODY_BRAIN_PRODUCTION = Object.freeze({
  codex: Object.freeze({ adapterId: 'codex-acp', adapterVersion: '1.1.7' }),
  'claude-code': Object.freeze({ adapterId: 'claude-code-acp', adapterVersion: '0.63.0' }),
} as const);

export const CODEX_BODY_BRAIN_DESCRIPTOR: AcpBodyBrainAdapterDescriptor = Object.freeze({
  schemaVersion: 1, harnessId: 'codex', adapterId: 'codex-acp', adapterVersion: '1.1.7',
  createProvider: createAcpBodyBrainInjectedProvider,
});
export const CLAUDE_CODE_BODY_BRAIN_DESCRIPTOR: AcpBodyBrainAdapterDescriptor = Object.freeze({
  schemaVersion: 1, harnessId: 'claude-code', adapterId: 'claude-code-acp', adapterVersion: '0.63.0',
  createProvider: createAcpBodyBrainInjectedProvider,
});
const PINNED_BODY_BRAIN = Object.freeze({
  codex: CODEX_BODY_BRAIN_DESCRIPTOR,
  'claude-code': CLAUDE_CODE_BODY_BRAIN_DESCRIPTOR,
});

function exactDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.isFrozen(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && !descriptor.get && !descriptor.set && 'value' in descriptor;
  });
}

export function registerAdapter(a: HarnessAdapter): void {
  // Enforced here rather than left to the type system: an adapter that silently
  // omits the capability is how the neutral-permission warnings ended up with no
  // caller and no reader.
  if (typeof a.translatePermissions !== 'function')
    throw new Error(
      `harness adapter '${a.id}' must implement translatePermissions(): either translate ` +
      `neutral permissions or return { supported: false, reason }`);
  if (typeof a.nativePermissionOverrides !== 'function')
    throw new Error(
      `harness adapter '${a.id}' must implement nativePermissionOverrides(): report the ` +
      `native permission settings a role states in harness_options, or {}`);
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

/**
 * Phase-4 registry is deliberately separate from the legacy harness registry:
 * a registered CLI harness is not evidence that a Body–Brain implementation
 * exists. Production consumption therefore fails closed until C2 registers it.
 */
export function registerBodyBrainAdapterDescriptor(descriptor: AcpBodyBrainAdapterDescriptor): void {
  if (!exactDataObject(descriptor, [
    'schemaVersion', 'harnessId', 'adapterId', 'adapterVersion', 'createProvider',
  ])) throw new Error('BodyBrain adapter descriptor must be an exact frozen data object');
  const expected = BODY_BRAIN_PRODUCTION[descriptor.harnessId as keyof typeof BODY_BRAIN_PRODUCTION];
  if (!expected) throw new Error(`unknown production BodyBrain harness '${String(descriptor.harnessId)}'`);
  if (descriptor.schemaVersion !== 1 || descriptor.adapterId !== expected.adapterId
      || descriptor.adapterVersion !== expected.adapterVersion
      || typeof descriptor.createProvider !== 'function')
    throw new Error(`invalid BodyBrain adapter descriptor for '${descriptor.harnessId}'`);
  if (descriptor !== PINNED_BODY_BRAIN[descriptor.harnessId])
    throw new Error(`foreign BodyBrain adapter descriptor for '${descriptor.harnessId}'`);
  if (bodyBrainAdapters.has(descriptor.harnessId))
    throw new Error(`duplicate BodyBrain adapter descriptor '${descriptor.harnessId}'`);
  bodyBrainAdapters.set(descriptor.harnessId, descriptor);
}

export function getBodyBrainAdapterDescriptor(
  harnessId: 'codex' | 'claude-code',
): AcpBodyBrainAdapterDescriptor {
  if (!Object.hasOwn(BODY_BRAIN_PRODUCTION, harnessId))
    throw new Error(`unknown production BodyBrain harness '${String(harnessId)}'`);
  const descriptor = bodyBrainAdapters.get(harnessId);
  if (!descriptor) throw new Error(`BodyBrain adapter '${harnessId}' is not registered`);
  return descriptor;
}

/** Deterministic bytewise production IDs whose BodyBrain descriptors exist. */
export function knownBodyBrainAdapterDescriptors(): string[] {
  return [...bodyBrainAdapters.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
