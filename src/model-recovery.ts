import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from './atomic-file.js';
import type { ResolvedRole } from './config.js';

export type FailureClass =
  | 'model-entitlement-or-quota'
  | 'transient-rate-limit'
  | 'overload'
  | 'authentication'
  | 'policy'
  | 'unknown-api-error';

export interface FailureEvidence {
  class: FailureClass;
  httpStatus?: number;
  model?: string;
  confidence: 'low' | 'medium' | 'high';
  source: 'claude-pane' | 'acp' | 'auth-proxy';
  observedAt: string;
}

export interface ModelRecoveryLedger {
  schemaVersion: 1;
  chainFingerprint: string;
  declaredModel: string;
  effectiveModel: string;
  index: number;
  evidenceCount: number;
  evidenceSource?: FailureEvidence['source'];
  lastEvidenceAt?: string;
  transitionedAt?: string;
  heldDown: boolean;
  reconciledAt: string;
}

export type RecoveryAction =
  | { kind: 'none'; ledger: ModelRecoveryLedger }
  | { kind: 'advance'; from: string; to: string; ledger: ModelRecoveryLedger }
  | { kind: 'hold'; model: string; ledger: ModelRecoveryLedger };

const fingerprint = (chain: string[]): string =>
  createHash('sha256').update(JSON.stringify(chain)).digest('hex');
const pathOf = (dir: string) => join(dir, '.model-recovery.json');

export function classifyFailureText(
  text: string,
  source: FailureEvidence['source'] = 'claude-pane',
  observedAt = new Date().toISOString(),
): FailureEvidence | undefined {
  const tail = text.split('\n').slice(-30).join('\n');
  const status = tail.match(/\b(?:HTTP\s*)?(401|403|429|529)\b/i)?.[1];
  const httpStatus = status ? Number(status) : undefined;
  const base = { httpStatus, source, observedAt };
  if (httpStatus === 529 || /\boverload(?:ed)?\b/i.test(tail))
    return { ...base, class: 'overload', confidence: 'high' };
  if (httpStatus === 401 || httpStatus === 403 || /\binvalid (?:api )?key\b/i.test(tail))
    return { ...base, class: 'authentication', confidence: 'high' };
  if (/\bpolicy|usage policy|content policy\b/i.test(tail))
    return { ...base, class: 'policy', confidence: 'high' };
  if (httpStatus === 429) {
    const entitlement = /\b(model|subscription|plan)\b.{0,80}\b(not (?:available|included|enabled|covered)|unsupported|access)\b/i.test(tail)
      || /\b(quota|usage limit|billing limit)\b.{0,80}\b(exceeded|reached|unavailable)\b/i.test(tail);
    return {
      ...base,
      class: entitlement ? 'model-entitlement-or-quota' : 'transient-rate-limit',
      confidence: entitlement ? 'high' : 'medium',
    };
  }
  if (/\bAPI Error\b/i.test(tail))
    return { ...base, class: 'unknown-api-error', confidence: 'low' };
  return undefined;
}

export function reconcileModelRecovery(
  dir: string,
  role: ResolvedRole,
  now = new Date().toISOString(),
): ModelRecoveryLedger | undefined {
  const chain = role.model_chain;
  if (!chain) return undefined;
  const fp = fingerprint(chain);
  let existing: ModelRecoveryLedger | undefined;
  try { existing = JSON.parse(readFileSync(pathOf(dir), 'utf8')) as ModelRecoveryLedger; }
  catch { existing = undefined; }
  if (existing?.schemaVersion === 1 && existing.chainFingerprint === fp
      && chain[existing.index] === existing.effectiveModel) return existing;
  const ledger: ModelRecoveryLedger = {
    schemaVersion: 1,
    chainFingerprint: fp,
    declaredModel: chain[0],
    effectiveModel: chain[0],
    index: 0,
    evidenceCount: 0,
    heldDown: false,
    reconciledAt: now,
  };
  writeModelRecovery(dir, ledger);
  return ledger;
}

export function recordModelFailure(
  dir: string,
  role: ResolvedRole,
  evidence: FailureEvidence,
  threshold = 3,
): RecoveryAction {
  const ledger = reconcileModelRecovery(dir, role, evidence.observedAt);
  if (!ledger) throw new Error('model recovery requires model_chain');
  if (ledger.heldDown || evidence.class !== 'model-entitlement-or-quota'
      || evidence.confidence !== 'high'
      || (evidence.model !== undefined && evidence.model !== ledger.effectiveModel))
    return { kind: 'none', ledger };
  const next = {
    ...ledger,
    evidenceCount: ledger.evidenceCount + 1,
    evidenceSource: evidence.source,
    lastEvidenceAt: evidence.observedAt,
  };
  if (next.evidenceCount < threshold) {
    writeModelRecovery(dir, next);
    return { kind: 'none', ledger: next };
  }
  if (next.index + 1 >= role.model_chain!.length) {
    const held = { ...next, heldDown: true, transitionedAt: evidence.observedAt };
    writeModelRecovery(dir, held);
    writeStatus(dir, held);
    return { kind: 'hold', model: held.effectiveModel, ledger: held };
  }
  const advanced = {
    ...next,
    index: next.index + 1,
    effectiveModel: role.model_chain![next.index + 1],
    evidenceCount: 0,
    transitionedAt: evidence.observedAt,
  };
  writeModelRecovery(dir, advanced);
  writeStatus(dir, advanced);
  return { kind: 'advance', from: ledger.effectiveModel, to: advanced.effectiveModel, ledger: advanced };
}

export function effectiveModelForRole(dir: string, role: ResolvedRole): string | undefined {
  return reconcileModelRecovery(dir, role)?.effectiveModel ?? role.model;
}

export function modelRecoveryHeld(dir: string): boolean {
  if (!existsSync(pathOf(dir))) return false;
  try { return (JSON.parse(readFileSync(pathOf(dir), 'utf8')) as ModelRecoveryLedger).heldDown === true; }
  catch { return true; } // fail closed on corrupt authorization state
}

export function resetModelRecovery(dir: string, role: ResolvedRole): ModelRecoveryLedger | undefined {
  const path = pathOf(dir);
  if (existsSync(path)) replaceFileAtomically(path, '');
  return reconcileModelRecovery(dir, role);
}

const writeModelRecovery = (dir: string, ledger: ModelRecoveryLedger) =>
  replaceFileAtomically(pathOf(dir), `${JSON.stringify(ledger, null, 2)}\n`);
const writeStatus = (dir: string, ledger: ModelRecoveryLedger) =>
  replaceFileAtomically(join(dir, '.model-status'), `${JSON.stringify({
    schemaVersion: 1,
    declaredModel: ledger.declaredModel,
    effectiveModel: ledger.effectiveModel,
    heldDown: ledger.heldDown,
    transitionedAt: ledger.transitionedAt,
  }, null, 2)}\n`);
