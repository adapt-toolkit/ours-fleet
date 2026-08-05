import { describe, expect, it } from 'vitest';

import { promptReceiptNotice } from '../../web/src/prompt-receipt.js';

describe('prompt receipt presentation', () => {
  it('preserves a legacy backend detail string', () => {
    expect(promptReceiptNotice({ detail: 'accepted; custom detail', queuedBehind: 3 }))
      .toBe('accepted; custom detail');
  });

  it('renders durable V2 receipts without inventing completion', () => {
    expect(promptReceiptNotice({ queuedBehind: 0 }))
      .toBe('accepted; turn may still be running');
    expect(promptReceiptNotice({ queuedBehind: 2 }))
      .toBe('accepted; 2 turn(s) queued ahead');
  });
});
