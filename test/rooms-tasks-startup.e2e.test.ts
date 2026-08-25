import { describe, expect, it } from 'vitest';
import { generateBriefing } from '../src/briefing.js';
import type { ResolvedRole } from '../src/config.js';
import type { BriefingVocab } from '../src/harness/types.js';

const vocab: BriefingVocab = {
  bindTool: 'choose_identity', createTool: 'create_identity',
  temporaryCreateTool: 'create_temporary_identity', setBioTool: 'set_bio',
  setPersonaTool: 'set_persona', currentIdentityTool: 'current_identity',
  sendTool: 'send_message', getMessagesTool: 'get_messages',
  listHistoryTool: 'list_history', getHistoryItemTool: 'get_history_item',
  monitorInstruction: () => 'Check room mail manually.',
  supervisedWakeNote: () => 'Wakes arrive as [fleet-monitor] lines.',
  launchNote: name => `You are ${name}.`,
  restartPrompt: () => 'restart',
};

describe('simple room startup contract end to end', () => {
  it('carries the one-time invite directly from Fleet to the temporary agent briefing', () => {
    const briefing = generateBriefing({
      name: 'reviewer-1', identity: 'reviewer-1', harness: 'codex', session: 'acp',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      permissionsDeclared: true, sourceFile: '(temp)',
      roomMemberStartup: {
        room_id: 'room-1', room_identity_cid: 'A'.repeat(64),
        identity_name: 'reviewer-1', invite_id: 'invite-1', invite: 'secret-once',
        role: 'Reviewer', task: 'Review the implementation and report evidence.',
        owner_seat_cid: 'B'.repeat(64),
      },
    } as ResolvedRole, vocab, {
      stateDir: '/state', worklogPath: '/state/WORKLOG.md',
      routinesPath: '/state/ROUTINES.md', temporaryIdentity: true,
    });

    const create = briefing.indexOf('create_temporary_identity');
    const accept = briefing.indexOf('add_contact');
    const work = briefing.indexOf('Start the Task above now');
    expect(briefing).toContain('secret-once');
    expect(briefing).toContain('Review the implementation and report evidence.');
    expect(create).toBeGreaterThan(0);
    expect(accept).toBeGreaterThan(create);
    expect(work).toBeGreaterThan(accept);
    expect(briefing).not.toContain('fleet_room_briefing_ack');
    expect(briefing).not.toContain('briefing_sha256');
    expect(briefing).not.toContain('room_role_briefing');
  });
});
