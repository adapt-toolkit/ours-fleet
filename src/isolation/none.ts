import type { IsolationBackend } from './types.js';

/** The identity backend: no sandbox. wrap() returns the argv unchanged. Used for
 *  `backend: none` and as the fail-open target when `on_unavailable: warn`. */
export function makeNoneBackend(): IsolationBackend {
  return {
    id: 'none',
    async available() { return { ok: true, detail: 'no isolation (identity backend)' }; },
    wrap(argv) { return argv; },
  };
}
