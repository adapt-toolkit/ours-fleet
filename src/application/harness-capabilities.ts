import { getAdapter, knownAdapters, productionAdapters } from '../harness/registry.js';
import type { PrereqCheck } from '../harness/types.js';
import type { OfferedModels } from '../subscriptions/cli.js';

/**
 * A selectable model. `efforts: null` means the efforts are unknown (a model the
 * adapter does not maintain); `[]` means the model is known to have no effort setting.
 */
export interface CapabilityModel {
  id: string;
  label: string;
  efforts: string[] | null;
  available: boolean;
  reason?: string;
  source: 'adapter' | 'runtime-discovery';
}

export interface HarnessCapability {
  harness: string;
  ready: boolean;
  checks: PrereqCheck[];
  sessions: string[];
  modelRequired: boolean;
  customModels: boolean;
  models: CapabilityModel[];
  discovery?: { state: 'known' } | { state: 'unknown'; reason: string };
}

export interface HarnessCapabilitiesReport { harnesses: HarnessCapability[] }

export interface HarnessCapabilityDeps {
  harnesses?: string[];
  codexModels?: () => Promise<OfferedModels>;
  /** Skip executable checks when only model facts are needed. */
  checkReadiness?: boolean;
}

/** Each production adapter's maintained models, narrowed by what the active Codex account offers. */
export async function harnessCapabilities(deps: HarnessCapabilityDeps = {}): Promise<HarnessCapabilitiesReport> {
  // Only harnesses whose adapter is registered in this process can report facts.
  const ids = (deps.harnesses ?? productionAdapters()).filter(id => knownAdapters().includes(id));
  const harnesses = await Promise.all(ids.map(async (id): Promise<HarnessCapability | undefined> => {
    const adapter = getAdapter(id);
    const capabilities = adapter.modelCapabilities?.();
    if (!capabilities) return undefined;
    let ready = true, checks: PrereqCheck[] = [];
    if (deps.checkReadiness !== false) {
      try { ({ ok: ready, checks } = await adapter.checkPrereqs()); }
      catch { ready = false; checks = [{ name: 'availability', ok: false, detail: 'Harness checks unavailable' }]; }
    }
    let models: CapabilityModel[] = capabilities.models.map(model => ({
      id: model.id, label: model.label, efforts: [...model.efforts], available: true, source: 'adapter' as const,
    }));
    let discovery: HarnessCapability['discovery'];
    if (id === 'codex' && deps.codexModels) {
      const offered = await deps.codexModels();
      discovery = offered.state === 'known' ? { state: 'known' } : { state: 'unknown', reason: offered.reason };
      if (offered.state === 'known') {
        models = models.map(model => offered.models.includes(model.id) ? model
          : { ...model, available: false, reason: 'The active Codex account does not offer this model.' });
        // Offered models the adapter does not maintain: selectable, but their efforts are not known.
        for (const extra of offered.models.filter(model => !models.some(known => known.id === model)))
          models.push({ id: extra, label: extra, efforts: null, available: true, source: 'runtime-discovery' });
      } else {
        models = models.map(model => ({ ...model, available: false,
          reason: `Codex could not report the models offered to the active account: ${offered.reason}` }));
      }
    }
    return { harness: id, ready, checks, sessions: [...capabilities.sessions], modelRequired: capabilities.modelRequired,
      customModels: capabilities.customModels, models, ...(discovery ? { discovery } : {}) };
  }));
  return { harnesses: harnesses.filter((item): item is HarnessCapability => item !== undefined) };
}

export interface BrainChoice { harness: string; session?: string; model?: string | null; effort?: string | null }
export type BrainChoiceCheck = { ok: true; model?: CapabilityModel } | { ok: false; code: string; message: string };

/**
 * Strict check of a new harness/model/effort choice. Nothing is substituted: an
 * effort is kept only when the chosen model supports it; an omitted effort keeps
 * the harness default. Existing Brains are resolved by their adapter as before.
 */
export function validateBrainChoice(report: HarnessCapabilitiesReport, choice: BrainChoice): BrainChoiceCheck {
  const harness = report.harnesses.find(item => item.harness === choice.harness);
  if (!harness) return { ok: false, code: 'harness_unsupported',
    message: `Harness '${String(choice.harness)}' is not available; choose one of: ${report.harnesses.map(item => item.harness).join(', ')}` };
  if (choice.session !== undefined && !harness.sessions.includes(choice.session))
    return { ok: false, code: 'session_unsupported',
      message: `${harness.harness} does not support session '${choice.session}'; choose one of: ${harness.sessions.join(', ')}` };
  const effort = choice.effort ?? undefined;
  if (effort !== undefined && (typeof effort !== 'string' || !effort))
    return { ok: false, code: 'effort_invalid', message: 'Effort must be a non-empty string or omitted' };
  const modelId = choice.model ?? undefined;
  if (modelId === undefined) {
    if (harness.modelRequired) return { ok: false, code: 'model_required', message: `${harness.harness} requires an explicit model` };
    if (effort !== undefined) return { ok: false, code: 'effort_unknown',
      message: `The ${harness.harness} default model has no known effort list; choose a model to set effort, or leave effort at the harness default` };
    return { ok: true };
  }
  if (typeof modelId !== 'string' || !modelId.trim()) return { ok: false, code: 'model_invalid', message: 'Model must be a non-empty string' };
  const model = harness.models.find(item => item.id === modelId);
  if (!model) {
    if (!harness.customModels) return { ok: false, code: 'model_unsupported',
      message: `${harness.harness} does not support model '${modelId}'` };
    if (effort !== undefined) return { ok: false, code: 'effort_unknown',
      message: `Efforts for '${modelId}' are unknown to ${harness.harness}; leave effort at the harness default or choose a listed model` };
    return { ok: true };
  }
  if (!model.available) return { ok: false, code: 'model_unavailable', message: `${model.label}: ${model.reason ?? 'unavailable'}` };
  if (effort === undefined) return { ok: true, model };
  if (model.efforts === null) return { ok: false, code: 'effort_unknown',
    message: `Efforts for ${model.label} are unknown; leave effort at the harness default` };
  if (!model.efforts.length) return { ok: false, code: 'effort_unsupported',
    message: `${model.label} has no effort setting; remove the effort` };
  if (!model.efforts.includes(effort)) return { ok: false, code: 'effort_unsupported',
    message: `${model.label} does not support effort '${effort}'; choose one of: ${model.efforts.join(', ')}` };
  return { ok: true, model };
}
