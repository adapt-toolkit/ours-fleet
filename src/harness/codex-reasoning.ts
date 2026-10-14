/** Efforts supported by Fleet's Codex Brain contract. Keep native eligibility in sync. */
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export function isCodexReasoningEffort(value: unknown): value is string {
  return typeof value === 'string' && (CODEX_REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Only inspected model tuning may bypass the managed CLI native-config guard. */
export function isManagedCliCodexConfig(config: unknown): boolean {
  if (config == null) return true;
  return typeof config === 'object' && !Array.isArray(config)
    && Object.entries(config).every(([key, value]) =>
      key === 'model_reasoning_effort' && isCodexReasoningEffort(value));
}
