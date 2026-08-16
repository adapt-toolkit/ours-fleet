import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type ModelCatalogSource = 'codex-runtime-catalog' | 'claude-adapter-2.1' | 'fleet-config';

export interface HarnessModelOption {
  id: string;
  label: string;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
  source: ModelCatalogSource;
}

export interface HarnessModelCatalog {
  models: HarnessModelOption[];
  warnings: string[];
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,127}$/.test(value);

/** Read Codex's locally materialized `model/list` result; never invent fallback aliases. */
export function codexModelCatalog(path = join(homedir(), '.codex', 'models_cache.json')): HarnessModelCatalog {
  try {
    if (statSync(path).size > 2_000_000) throw new Error('catalog exceeds the 2 MB safety limit');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { models?: unknown[] };
    const models = (parsed.models ?? []).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return [];
      const model = raw as Record<string, unknown>;
      if (model.visibility !== 'list' || !validId(model.slug)) return [];
      const levels = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.flatMap(level => {
          const effort = (level as { effort?: unknown })?.effort;
          return validId(effort) ? [effort] : [];
        }) : [];
      return [{
        id: model.slug,
        label: typeof model.display_name === 'string' ? model.display_name : model.slug,
        reasoningEfforts: [...new Set(levels)],
        ...(validId(model.default_reasoning_level)
          ? { defaultReasoningEffort: model.default_reasoning_level } : {}),
        source: 'codex-runtime-catalog' as const,
      }];
    });
    if (!models.length) throw new Error('catalog has no picker-visible models');
    return { models, warnings: [] };
  } catch (error) {
    return {
      models: [],
      warnings: [`Codex runtime model catalog unavailable: ${(error as Error).message}. Use Advanced to enter an exact ID.`],
    };
  }
}

/**
 * Claude Code 2.1 has no typed model-list endpoint. These exact IDs are the
 * versioned adapter contract shipped by the installed 2.1 CLI, not aliases and
 * not a claim about account entitlement (which Claude validates at launch).
 */
export function claudeModelCatalog(): HarnessModelCatalog {
  const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  return {
    models: [
      { id: 'claude-fable-5', label: 'Claude Fable 5', reasoningEfforts, source: 'claude-adapter-2.1' },
      { id: 'claude-opus-5', label: 'Claude Opus 5', reasoningEfforts, source: 'claude-adapter-2.1' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', reasoningEfforts, source: 'claude-adapter-2.1' },
    ],
    warnings: ['Claude Code exposes no typed model-list endpoint; choices are exact 2.1 adapter IDs and entitlement is validated at launch.'],
  };
}
