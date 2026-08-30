/** Shared recursive configuration redaction boundary for operator-facing models. */
export function isSensitiveConfigKey(key: string): boolean {
  return /(?:secret|token|password|credential|private[_-]?key|auth|invite|api[_-]?key)/i.test(key);
}
