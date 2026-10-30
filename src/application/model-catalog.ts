import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { packagedPresetRoot } from '../preset-bootstrap.js';

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

/** One model a harness adapter knows, with the exact efforts it supports ([] = no effort setting). */
export interface PackagedModel {
  harness: 'codex' | 'claude-code';
  session: 'acp';
  model: string;
  label: string;
  efforts: string[];
}

export interface PackagedModelCatalog { schema_version: 2; catalog_revision: number; models: PackagedModel[] }

const KNOWN_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Validate the packaged model catalog maintained with the Claude Code and Codex adapters. */
export function validatePackagedModelCatalog(value: unknown, path = 'packaged model catalog'): PackagedModelCatalog {
  const catalog = value as PackagedModelCatalog;
  if (!catalog || catalog.schema_version !== 2 || !Number.isInteger(catalog.catalog_revision)
    || !Array.isArray(catalog.models) || catalog.models.length === 0)
    throw new Error(`invalid ${path}`);
  const tuples = new Set<string>();
  for (const model of catalog.models) {
    if (!model || !['codex', 'claude-code'].includes(model.harness) || model.session !== 'acp'
      || typeof model.model !== 'string' || !model.model
      || typeof model.label !== 'string' || !model.label.trim()
      || !Array.isArray(model.efforts) || new Set(model.efforts).size !== model.efforts.length
      || model.efforts.some(effort => !KNOWN_EFFORTS.includes(effort)))
      throw new Error(`unsupported model state in ${path}: ${String(model?.model)}`);
    const tuple = `${model.harness}\0${model.session}\0${model.model}`;
    if (tuples.has(tuple)) throw new Error(`duplicate supported model in ${path}: ${model.model}`);
    tuples.add(tuple);
  }
  return catalog;
}

/** The packaged catalog, optionally limited to one harness. */
export function packagedModelCatalog(harness?: PackagedModel['harness']): PackagedModel[] {
  const path = join(packagedPresetRoot(), 'brain-catalog.json');
  const models = validatePackagedModelCatalog(JSON.parse(readFileSync(path, 'utf8')), path).models;
  return harness ? models.filter(model => model.harness === harness) : models;
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
 * versioned adapter contract verified with CLI 2.1.281, not aliases and
 * not a claim about account entitlement (which Claude validates at launch).
 */
export function claudeModelCatalog(): HarnessModelCatalog {
  return {
    models: packagedModelCatalog('claude-code').map(model => ({
      id: model.model, label: model.label, reasoningEfforts: model.efforts, source: 'claude-adapter-2.1' as const,
    })),
    warnings: ['Claude Code exposes no typed model-list endpoint; choices require a current Claude runtime (verified with 2.1.281); older bundled SDKs need CLAUDE_CODE_EXECUTABLE. Entitlement is validated at launch.'],
  };
}
