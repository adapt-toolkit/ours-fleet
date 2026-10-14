import { describe, expect, it } from 'vitest';
import { RoleSessionControlAdapter } from '../src/application/session-control.js';

// A fake role control socket: records commands and answers like a supervisor with the given features.
function supervisor(features: string[], generation = 'g1') {
  const commands: Array<{ command: string; [key: string]: unknown }> = [];
  const request = (async (_dir: string, message: { command: string }) => {
    commands.push(message);
    switch (message.command) {
      case 'snapshot': return { ok: true, result: { backend: 'acp', protocolVersion: 3, features } };
      case 'conversation_page': return { ok: true, result: { events: [], hasMore: false, snapshot: { sessionGeneration: generation, readiness: 'idle', queueDepth: 0, pendingPermissionIds: [] } } };
      case 'submit_prompt_v2': case 'submit_voice_prompt': return { ok: true, result: { commandId: 'c', promptId: 'p', state: 'starting', queuedBehind: 0 } };
      default: return { ok: false, kind: 'error', message: `unknown command ${message.command}` };
    }
  }) as never;
  return { adapter: new RoleSessionControlAdapter('/unused', request), commands };
}
const prompt = (expectedSessionGeneration?: string) => ({ commandId: 'c', text: 'See attached file', actorBrowserSession: 'b', source: 'owner_admin_console' as const, expectedSessionGeneration });

describe('generation-bound prompts', () => {
  it('refuses live admission and targeted cancel on older supervisors without fallback', async () => {
    const { adapter, commands } = supervisor(['generation_bound_prompts']);
    await expect(adapter.submitPromptV2({ ...prompt('g1'), requireIdle: true })).rejects.toMatchObject({ code: 'capability_unavailable' });
    await expect(adapter.interruptPromptV2({ commandId: 'cancel', expectedSessionGeneration: 'g1', promptId: 'p' })).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(commands.every(c => c.command === 'snapshot')).toBe(true);
  });
  it('passes requireIdle to the atomic admission path', async () => {
    const { adapter, commands } = supervisor(['generation_bound_prompts','idle_bound_prompts']);
    await adapter.submitPromptV2({ ...prompt('g1'), requireIdle: true });
    expect(commands.at(-1)).toMatchObject({command:'submit_voice_prompt',requireIdle:true,expectedSessionGeneration:'g1'});
  });

  it('uses the atomic supervisor command when the supervisor advertises it', async () => {
    const { adapter, commands } = supervisor(['conversation_v3', 'generation_bound_prompts']);
    await adapter.submitPromptV2(prompt('g1'));
    expect(commands.map(c => c.command)).toEqual(['snapshot', 'submit_voice_prompt']);
    expect(commands.at(-1)).toMatchObject({ expectedSessionGeneration: 'g1', commandId: 'c' });
  });
  it('checks the generation itself and sends an ordinary prompt to older supervisors', async () => {
    const { adapter, commands } = supervisor(['conversation_v3']);
    await adapter.submitPromptV2(prompt('g1'));
    expect(commands.map(c => c.command)).toEqual(['snapshot', 'conversation_page', 'submit_prompt_v2']);
    expect(commands.at(-1)).toMatchObject({ commandId: 'c', text: 'See attached file' });
  });
  it('rejects a changed session without submitting', async () => {
    const { adapter, commands } = supervisor(['conversation_v3'], 'g2');
    await expect(adapter.submitPromptV2(prompt('g1'))).rejects.toMatchObject({ code: 'stale_state' });
    expect(commands.map(c => c.command)).not.toContain('submit_prompt_v2');
  });
  it('leaves unbound prompts on the ordinary command without extra calls', async () => {
    const { adapter, commands } = supervisor([]);
    await adapter.submitPromptV2(prompt());
    expect(commands.map(c => c.command)).toEqual(['submit_prompt_v2']);
  });
});
