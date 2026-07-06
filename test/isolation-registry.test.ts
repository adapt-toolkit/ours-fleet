import { describe, it, expect } from 'vitest';
import { makeNoneBackend } from '../src/isolation/none.js';
import { selectIsolationBackend } from '../src/isolation/registry.js';
import { resolveIsolation } from '../src/isolation/policy.js';
import type { WrapContext, IsolationConfig } from '../src/isolation/types.js';
import type { Exec } from '../src/exec.js';

const ctx: WrapContext = {
  stateDir: '/s/Dev', runCwd: '/s/Dev', home: '/home/fleet',
};
const policy = (cfg: IsolationConfig) => resolveIsolation(cfg, ctx);

const bwrapOk: Exec = async (_c, args) =>
  args.includes('--version') ? { stdout: 'bubblewrap 0.11.1', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 };
const bwrapMissing: Exec = async () => ({ stdout: '', stderr: 'not found', code: 127 });

describe('none backend', () => {
  it('is an identity wrap that returns argv unchanged', () => {
    const b = makeNoneBackend();
    expect(b.id).toBe('none');
    expect(b.wrap(['claude', 'go'], policy({}), ctx)).toEqual(['claude', 'go']);
  });
  it('is always available', async () => {
    expect((await makeNoneBackend().available()).ok).toBe(true);
  });
});

describe('selectIsolationBackend', () => {
  it('backend: none selects the none backend, not degraded', async () => {
    const s = await selectIsolationBackend(policy({ backend: 'none' }), bwrapOk);
    expect(s.backend.id).toBe('none');
    expect(s.degraded).toBe(false);
  });

  it('backend: bubblewrap selects bubblewrap when available', async () => {
    const s = await selectIsolationBackend(policy({ backend: 'bubblewrap' }), bwrapOk);
    expect(s.backend.id).toBe('bubblewrap');
    expect(s.degraded).toBe(false);
  });

  it('backend: auto is bwrap-first when bwrap is available', async () => {
    const s = await selectIsolationBackend(policy({ backend: 'auto' }), bwrapOk);
    expect(s.backend.id).toBe('bubblewrap');
  });

  it('warn: degrades to none when the requested backend is unavailable', async () => {
    const s = await selectIsolationBackend(policy({ backend: 'bubblewrap', on_unavailable: 'warn' }), bwrapMissing);
    expect(s.backend.id).toBe('none');
    expect(s.degraded).toBe(true);
    expect(s.detail).toMatch(/bubblewrap|bwrap|unavailable/i);
  });

  it('auto + warn: degrades to none when no backend is available', async () => {
    const s = await selectIsolationBackend(policy({ backend: 'auto', on_unavailable: 'warn' }), bwrapMissing);
    expect(s.backend.id).toBe('none');
    expect(s.degraded).toBe(true);
  });

  it('strict: throws when the requested backend is unavailable', async () => {
    await expect(selectIsolationBackend(policy({ backend: 'bubblewrap', on_unavailable: 'strict' }), bwrapMissing))
      .rejects.toThrow(/strict|unavailable|refus/i);
  });
});
