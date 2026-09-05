import { describe, it, expect } from 'vitest';
import { makeClaudeCodeAdapter } from '../src/harness/claude-code.js';
import { resolveIsolation } from '../src/isolation/policy.js';
import { makeBubblewrapBackend } from '../src/isolation/bubblewrap.js';
import type { ResolvedRole } from '../src/config.js';
import type { WrapContext } from '../src/isolation/types.js';

// AC-10: isolation composes with the shared agent-session launch and ROUTINES.
describe('isolation composition (AC-10)', () => {
  const ctx: WrapContext = {
    stateDir: '/home/fleet/.ours-fleet/agents/Sec', runCwd: '/repo', home: '/home/fleet',
  };
  const role = {
    name: 'Sec', harness: 'claude-code', identity: 'Sec', sourceFile: 'x',
    model: 'claude-opus-4-8', harness_options: { permission_mode: 'plan' }, isolation: {},
    session: 'acp', session_options: { acp: { command: ['claude-agent-acp'] } },
  } as unknown as ResolvedRole;

  it('keeps the harness-selected agent process after the bwrap separator', () => {
    const launch = makeClaudeCodeAdapter().agentSession.prepareLaunch(role, { env: {} });
    const argv = makeBubblewrapBackend().wrap(launch.argv, resolveIsolation({}, ctx), ctx);

    const tail = argv.slice(argv.lastIndexOf('--') + 1);
    expect(tail).toEqual(['claude-agent-acp']);
  });

  it('mounts the state dir rw so ROUTINES.md is readable/writable inside the sandbox', () => {
    const policy = resolveIsolation({}, ctx);
    expect(policy.mounts.find(m => m.src === ctx.stateDir)?.mode).toBe('rw');
  });
});
