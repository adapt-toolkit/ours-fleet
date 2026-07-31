import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyFailureText, effectiveModelForRole, modelRecoveryHeld, recordModelFailure,
} from '../src/model-recovery.js';
import type { ResolvedRole } from '../src/config.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-model-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const role = (): ResolvedRole => ({
  name: 'A',
  harness: 'claude-code',
  session: 'tmux',
  permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
  permissionsDeclared: true,
  identity: 'A',
  sourceFile: 'fleet.yaml',
  model: 'primary',
  model_chain: ['primary', 'fallback'],
  monitor: {
    mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 0,
    inject: 'notification', interrupt: false, turn_fail_threshold: 2,
  },
});

describe('model recovery', () => {
  it.each([
    ['API Error: HTTP 429 rate limit exceeded', 'transient-rate-limit'],
    ['API Error: HTTP 529 overloaded', 'overload'],
    ['API Error: HTTP 401 invalid api key', 'authentication'],
    ['API Error: usage policy refusal', 'policy'],
    ['API Error: unknown', 'unknown-api-error'],
    ['API Error: HTTP 429 model primary is not included in this subscription plan',
      'model-entitlement-or-quota'],
  ] as const)('classifies %s without broadening recovery', (text, expected) => {
    expect(classifyFailureText(text)?.class).toBe(expected);
  });

  it('advances only after sustained high-confidence evidence and holds at exhaustion', () => {
    const evidence = classifyFailureText(
      'API Error: HTTP 429 model primary is not included in this subscription plan',
      'claude-pane',
      '2026-07-31T12:00:00.000Z',
    )!;
    expect(recordModelFailure(dir, role(), { ...evidence, model: 'primary' }, 2).kind).toBe('none');
    const advance = recordModelFailure(dir, role(), { ...evidence, model: 'primary' }, 2);
    expect(advance).toMatchObject({ kind: 'advance', from: 'primary', to: 'fallback' });
    expect(effectiveModelForRole(dir, role())).toBe('fallback');
    expect(recordModelFailure(dir, role(), { ...evidence, model: 'fallback' }, 2).kind).toBe('none');
    expect(recordModelFailure(dir, role(), { ...evidence, model: 'fallback' }, 2).kind).toBe('hold');
    expect(modelRecoveryHeld(dir)).toBe(true);
    expect(readFileSync(join(dir, '.model-recovery.json'), 'utf8')).not.toContain('subscription plan');
  });

  it('reconciles deterministically when the declared chain changes', () => {
    effectiveModelForRole(dir, role());
    const changed = role();
    changed.model = 'new-primary';
    changed.model_chain = ['new-primary'];
    expect(effectiveModelForRole(dir, changed)).toBe('new-primary');
    expect(modelRecoveryHeld(dir)).toBe(false);
  });
});
