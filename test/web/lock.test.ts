import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireWebServerLock } from '../../src/web/lock.js';

describe('web server single-instance lock', () => {
  it('refuses a live owner and releases only its own lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-lock-'));
    const first = acquireWebServerLock(dir);
    expect(() => acquireWebServerLock(dir)).toThrow(/another ours-fleet web server/);
    first.release();
    expect(existsSync(first.path)).toBe(false);
    const second = acquireWebServerLock(dir);
    second.release();
  });
});
