import { describe, expect, it, vi } from 'vitest';

import {
  dispatchOwnerCommand, isOwnerCommandText, ownerCommandHelp, ownerCommands,
  type OwnerCommandContext,
} from '../src/owner-channel/commands.js';
import { ownerNotices } from '../src/owner-channel/notices.js';
import type { SessionEvent, SessionSnapshot } from '../src/session/types.js';

function context(overrides: Partial<OwnerCommandContext> = {}): OwnerCommandContext & {
  replies: string[];
} {
  const replies: string[] = [];
  const snapshot: SessionSnapshot = { backend: 'acp', alive: true, readiness: 'idle' };
  return {
    replies,
    role: 'Coordinator',
    version: '9.9.9-test',
    snapshot: () => snapshot,
    interrupt: vi.fn(async () => undefined),
    runHarnessCommand: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    fleetList: vi.fn(async () => 'Coordinator: acp'),
    recentEvents: () => [],
    readWorklogTail: vi.fn(async () => undefined),
    reply: async text => { replies.push(text); },
    ...overrides,
  };
}

describe('owner command registry', () => {
  it('recognizes only trimmed slash-prefixed text as a command attempt', () => {
    expect(isOwnerCommandText('/help')).toBe(true);
    expect(isOwnerCommandText('  /help  ')).toBe(true);
    expect(isOwnerCommandText('help')).toBe(false);
    expect(isOwnerCommandText('please run /compact')).toBe(false);
    expect(isOwnerCommandText('')).toBe(false);
  });

  it('renders every registered command with usage and description in help', () => {
    const help = ownerCommandHelp();
    for (const command of ownerCommands) {
      expect(help).toContain(command.usage ?? `/${command.name}`);
      expect(help).toContain(command.summary);
    }
    // The registry is the single source of truth for the deterministic set.
    for (const name of ['help', 'status', 'interrupt', 'clear', 'compact', 'model',
      'restart', 'force-restart', 'ls', 'peek', 'worklog', 'version'])
      expect(ownerCommands.some(command => command.name === name)).toBe(true);
    expect(help).toContain('/commands');
  });

  it('prepends a caller error to help output when given', () => {
    const help = ownerCommandHelp('unknown command /deploy');
    expect(help).toContain('unknown command /deploy');
    expect(help).toContain('/help');
  });

  it('replies with help for /help and its /commands alias, case-insensitively', async () => {
    for (const text of ['/help', '/commands', '/HELP']) {
      const ctx = context();
      await dispatchOwnerCommand(text, ctx);
      expect(ctx.replies).toEqual([ownerCommandHelp()]);
    }
  });

  it('replies with help for an unknown command instead of forwarding', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/deploy prod now', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('/deploy');
    expect(ctx.replies[0]).toContain('/help');
    expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
    expect(ctx.restart).not.toHaveBeenCalled();
  });

  it('reports status from the session snapshot', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/status', ctx);
    expect(ctx.replies).toEqual([ownerNotices.status('Coordinator',
      { backend: 'acp', alive: true, readiness: 'idle' })]);
  });

  it('interrupts the active turn and confirms', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/interrupt', ctx);
    expect(ctx.interrupt).toHaveBeenCalledOnce();
    expect(ctx.replies).toEqual([ownerNotices.interrupted('Coordinator')]);
  });

  it('reports an interrupt failure without throwing', async () => {
    const ctx = context({ interrupt: vi.fn(async () => { throw new Error('boom'); }) });
    await dispatchOwnerCommand('/interrupt', ctx);
    expect(ctx.replies).toEqual([ownerNotices.interruptFailed('Coordinator')]);
  });

  it('passes /clear and /compact to the harness as raw slash text', async () => {
    for (const name of ['clear', 'compact']) {
      const ctx = context();
      await dispatchOwnerCommand(`/${name}`, ctx);
      expect(ctx.runHarnessCommand).toHaveBeenCalledOnce();
    expect(ctx.runHarnessCommand).toHaveBeenCalledWith(`/${name}`);
    }
  });

  it('passes /model with a valid id to the harness', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/model claude-sonnet-5', ctx);
    expect(ctx.runHarnessCommand).toHaveBeenCalledOnce();
    expect(ctx.runHarnessCommand).toHaveBeenCalledWith('/model claude-sonnet-5');
  });

  it('returns help for /model without an argument', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/model', ctx);
    expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('/model <model-id>');
  });

  it('returns help for a malformed /model argument', async () => {
    for (const bad of ['claude sonnet', 'x'.repeat(200), 'a\nb', '$(rm -rf /)', '--flag']) {
      const ctx = context();
      await dispatchOwnerCommand(`/model ${bad}`, ctx);
      expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
      expect(ctx.replies).toHaveLength(1);
      expect(ctx.replies[0]).toContain('/help');
    }
  });

  it('returns help when a no-argument command is given arguments', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/clear everything', ctx);
    expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('/help');
  });

  it('maps /restart and /force-restart to the fleet restart modes', async () => {
    const keep = context();
    await dispatchOwnerCommand('/restart', keep);
    expect(keep.restart).toHaveBeenCalledOnce();
    expect(keep.restart).toHaveBeenCalledWith('keep');
    const fresh = context();
    await dispatchOwnerCommand('/force-restart', fresh);
    expect(fresh.restart).toHaveBeenCalledOnce();
    expect(fresh.restart).toHaveBeenCalledWith('fresh');
  });

  it('relays the fleet listing for /ls', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/ls', ctx);
    expect(ctx.fleetList).toHaveBeenCalledOnce();
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('Coordinator: acp');
  });

  it('reports the fleet version for /version', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/version', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('9.9.9-test');
  });

  it('tails the worklog for /worklog and reports when it is missing', async () => {
    const present = context({ readWorklogTail: vi.fn(async () => 'did a thing\ndid another') });
    await dispatchOwnerCommand('/worklog', present);
    expect(present.replies).toHaveLength(1);
    expect(present.replies[0]).toContain('did another');
    const missing = context();
    await dispatchOwnerCommand('/worklog', missing);
    expect(missing.replies).toHaveLength(1);
    expect(missing.replies[0].toLowerCase()).toContain('no worklog');
  });

  it('summarizes recent activity shapes for /peek without leaking text bodies', async () => {
    const events: SessionEvent[] = [
      { version: 1, seq: 1, at: 't', kind: 'thought', text: 'SECRET private reasoning' },
      { version: 1, seq: 2, at: 't', kind: 'tool_call', title: 'Read README.md' },
      { version: 1, seq: 3, at: 't', kind: 'tool_update', status: 'completed' },
      { version: 1, seq: 4, at: 't', kind: 'agent_text', text: 'SECRET draft answer' },
      { version: 1, seq: 5, at: 't', kind: 'turn_stop', stopReason: 'end_turn' },
    ];
    const ctx = context({ recentEvents: () => events });
    await dispatchOwnerCommand('/peek', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('tool_call');
    expect(ctx.replies[0]).toContain('Read README.md');
    expect(ctx.replies[0]).toContain('turn_stop');
    expect(ctx.replies[0]).not.toContain('SECRET');
  });

  it('reports an empty /peek when there is no recent activity', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/peek', ctx);
    expect(ctx.replies).toHaveLength(1);
  });

  it('replies with a failure notice when a command effect throws', async () => {
    const ctx = context({ fleetList: vi.fn(async () => { throw new Error('spawn failed'); }) });
    // The dispatcher rethrows after the notice so the channel can log the cause.
    await expect(dispatchOwnerCommand('/ls', ctx)).rejects.toThrow('spawn failed');
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('⚠️');
    expect(ctx.replies[0]).not.toContain('spawn failed');
  });
});
