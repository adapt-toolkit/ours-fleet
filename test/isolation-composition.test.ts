import { describe, it, expect } from 'vitest';
import { makeClaudeCodeAdapter } from '../src/harness/claude-code.js';
import { resolveIsolation } from '../src/isolation/policy.js';
import { makeBubblewrapBackend } from '../src/isolation/bubblewrap.js';
import type { ResolvedRole } from '../src/config.js';
import type { WrapContext } from '../src/isolation/types.js';

// AC-10: isolation composes with model + permission_mode + ROUTINES. A wrapped
// role must still deliver --model / --permission-mode to claude, and ROUTINES.md
// (in the state dir) must be readable inside the sandbox.
describe('isolation composition (AC-10)', () => {
  const ctx: WrapContext = {
    stateDir: '/home/fleet/.ours-fleet/agents/Sec', runCwd: '/repo', home: '/home/fleet',
  };
  const role = {
    name: 'Sec', harness: 'claude-code', identity: 'Sec', sourceFile: 'x',
    model: 'claude-opus-4-8', harness_options: { permission_mode: 'plan' }, isolation: {},
  } as unknown as ResolvedRole;

  it('keeps --model and --permission-mode reaching claude after the bwrap separator', () => {
    const launch = makeClaudeCodeAdapter().buildLaunch(role, 'fresh', { sessionId: 'SID' }, { argv: [], env: {} });
    const argv = makeBubblewrapBackend().wrap(launch.argv, resolveIsolation({}, ctx), ctx);

    const tail = argv.slice(argv.lastIndexOf('--') + 1);
    expect(tail[0]).toBe('claude');
    expect(tail).toContain('--model');
    expect(tail).toContain('claude-opus-4-8');
    expect(tail).toContain('--permission-mode');
    expect(tail).toContain('plan');
    expect(tail).toContain('--remote-control');
    expect(tail).toContain('Sec');
  });

  it('mounts the state dir rw so ROUTINES.md is readable/writable inside the sandbox', () => {
    const policy = resolveIsolation({}, ctx);
    expect(policy.mounts.find(m => m.src === ctx.stateDir)?.mode).toBe('rw');
  });
});
