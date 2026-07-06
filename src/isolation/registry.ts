import { realExec, type Exec } from '../exec.js';
import { makeBubblewrapBackend } from './bubblewrap.js';
import { makeNoneBackend } from './none.js';
import type { IsolationBackend, ResolvedIsolation } from './types.js';

export type { IsolationBackend } from './types.js';
export { makeBubblewrapBackend, unsharesNet } from './bubblewrap.js';
export { makeNoneBackend } from './none.js';

/** Outcome of resolving a policy's `backend:` (incl. `auto`) against host reality. */
export interface Selection {
  backend: IsolationBackend;
  /** True when the requested backend was unavailable and we fell back to none. */
  degraded: boolean;
  detail: string;
}

/**
 * Pick the isolation backend for a resolved policy, honouring `auto` (bwrap-first,
 * rootless — OQ-5) and the `on_unavailable` degradation policy.
 *
 * - `none`         → the identity backend.
 * - `bubblewrap`   → bwrap if available, else degrade/refuse per on_unavailable.
 * - `podman`       → not implemented yet (Phase 6) ⇒ treated as unavailable.
 * - `auto`         → bwrap if available, else degrade/refuse.
 *
 * On `on_unavailable: strict` with nothing available, throws (fail closed).
 */
export async function selectIsolationBackend(
  policy: ResolvedIsolation, exec: Exec = realExec,
): Promise<Selection> {
  if (policy.backend === 'none')
    return { backend: makeNoneBackend(), degraded: false, detail: 'backend: none' };

  const candidates: IsolationBackend[] = [];
  if (policy.backend === 'auto' || policy.backend === 'bubblewrap')
    candidates.push(makeBubblewrapBackend(exec));
  // podman: Phase 6 — no candidate yet, so it falls through to on_unavailable.

  let lastDetail = policy.backend === 'podman'
    ? 'podman backend not implemented yet (Phase 6)'
    : 'no isolation backend available';
  for (const b of candidates) {
    const a = await b.available();
    if (a.ok) return { backend: b, degraded: false, detail: a.detail };
    lastDetail = `${b.id} unavailable: ${a.detail}`;
  }

  if (policy.onUnavailable === 'strict')
    throw new Error(`isolation strict mode: refusing to launch un-isolated — ${lastDetail}`);
  return { backend: makeNoneBackend(), degraded: true, detail: lastDetail };
}
