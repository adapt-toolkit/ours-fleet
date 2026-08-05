export interface PromptReceiptView {
  detail?: unknown;
  queuedBehind?: unknown;
}

/** Preserve the legacy acceptance wording for both legacy and durable V2 receipts. */
export function promptReceiptNotice(receipt: PromptReceiptView): string {
  if (typeof receipt.detail === 'string' && receipt.detail) return receipt.detail;
  const queuedBehind = typeof receipt.queuedBehind === 'number' && Number.isFinite(receipt.queuedBehind)
    ? Math.max(0, Math.floor(receipt.queuedBehind)) : 0;
  return queuedBehind > 0
    ? `accepted; ${queuedBehind} turn(s) queued ahead`
    : 'accepted; turn may still be running';
}
