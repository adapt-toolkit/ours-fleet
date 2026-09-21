import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOursRuntime } from '../src/agent-ours/runtime.js';
import { RuntimeController } from '../src/agent-ours/controller.js';
import { RuntimeJournal } from '../src/agent-ours/state.js';
import type { OursClient } from '@ours.network/sdk/client';

function fixture(options: { temporary?: boolean; releaseFails?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-runtime-test-'));
  const journal = new RuntimeJournal(root);
  const events: string[] = [];
  let time = 0;
  let cid: string | undefined;
  const assignment = {
    instance: 'instance',
    generation: 1,
    daemon: 'daemon',
    name: 'Agent',
    lifetime: options.temporary ? ('temporary' as const) : ('permanent' as const),
    action: 'action',
    allowCreate: true,
    bio: '',
  };
  const client = {
    listIdentities: async () => [],
    createIdentity: async (args: any) => {
      expect(args.requireExistingRoot).toBe(true);
      events.push('create');
      cid = 'CID';
      return { hierarchy: 'role', info: { cid } };
    },
    createTemporaryIdentity: async () => {
      events.push('create-temp');
      cid = 'CID';
      return { hierarchy: 'role', info: { cid } };
    },
    currentIdentity: async () => ({
      name: 'Agent',
      cid,
      temporary: !!options.temporary,
      isRoot: false,
    }),
    releaseLease: async () => {
      events.push('release');
      if (options.releaseFails) throw Error('partial');
      return {
        released: ['Agent'],
        closed: options.temporary ? ['Agent'] : [],
        attempted: 0,
        notified: 0,
        failed: 0,
      };
    },
  } as unknown as OursClient;
  const deps = {
    journal,
    client,
    assertFence: () => {},
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
  const runtime = new AgentOursRuntime(assignment, deps);
  return {
    root,
    journal,
    events,
    assignment,
    deps,
    runtime,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
describe('supervisor identity runtime', () => {
  it('does not start harness before room established; pending retries only observation', async () => {
    const f = fixture({ temporary: true });
    let established = false,
      redeems = 0,
      starts = 0;
    const room = {
      id: 'r',
      cid: 'ROOM',
      seat: 'seat',
      action: 'a',
      redeem: async () => {
        redeems++;
        return { cid: 'ROOM' };
      },
      observe: async () => (established ? ('established' as const) : ('pending' as const)),
      discardSecret: async () => {},
    };
    try {
      await expect(
        f.runtime.startHarness(async () => {
          starts++;
        }),
      ).rejects.toThrow('NOT_READY');
      await expect(f.runtime.prepare(room, 500)).rejects.toThrow('ROOM_PENDING');
      expect(starts).toBe(0);
      expect(redeems).toBe(1);
      established = true;
      await f.runtime.prepare(room);
      await f.runtime.startHarness(async () => {
        starts++;
      });
      expect(starts).toBe(1);
      expect(redeems).toBe(1);
      expect(f.events).toEqual(['create-temp']);
    } finally {
      f.cleanup();
    }
  });
  it('retirement drains admitted calls and permanently fences resume', async () => {
    const f = fixture();
    try {
      await f.runtime.prepare();
      const release = await f.runtime.admit();
      const terminal = f.runtime.terminal();
      await Promise.resolve();
      expect(f.events).not.toContain('release');
      await expect(f.runtime.admit()).rejects.toThrow('NOT_READY');
      release();
      await terminal;
      expect(f.events).toEqual(['create', 'release']);
      await expect(f.runtime.prepare()).rejects.toThrow('NOT_RESUMABLE');
      expect(f.journal.read()?.phase).toBe('RELEASED');
    } finally {
      f.cleanup();
    }
  });
  it('uncertain creation cannot create again after restart', async () => {
    const f = fixture();
    try {
      f.deps.client.createIdentity = async () => {
        throw Error('lost response');
      };
      await expect(f.runtime.prepare()).rejects.toThrow('lost response');
      const replacement = new AgentOursRuntime(f.assignment, f.deps);
      await expect(replacement.prepare()).rejects.toThrow('UNCERTAIN_PROVISIONING');
    } finally {
      f.cleanup();
    }
  });
  it('partial terminal release stays cleanup pending and never resumes', async () => {
    const f = fixture({ releaseFails: true });
    try {
      await f.runtime.prepare();
      await expect(f.runtime.terminal()).rejects.toThrow('partial');
      expect(f.journal.read()?.phase).toBe('CLEANUP_PENDING');
      await expect(f.runtime.prepare()).rejects.toThrow('NOT_RESUMABLE');
    } finally {
      f.cleanup();
    }
  });
  it('mismatched room CID fails before observing seat or harness', async () => {
    const f = fixture();
    try {
      await expect(
        f.runtime.prepare({
          id: 'r',
          cid: 'ROOM',
          seat: 's',
          action: 'a',
          redeem: async () => ({ cid: 'WRONG' }),
          observe: async () => 'pending' as const,
          discardSecret: async () => {},
        }),
      ).rejects.toThrow('WRONG_ROOM_CID');
      expect(f.journal.read()?.phase).toBe('FAILED');
    } finally {
      f.cleanup();
    }
  });
});

it('controller generation change cannot replay an uncertain room invite', async () => {
  const f = fixture({ temporary: true });
  const lockRoot = mkdtempSync(join(tmpdir(), 'runtime-controller-'));
  let redeems = 0;
  try {
    const c = await RuntimeController.acquire(lockRoot, 'daemon', 'Agent', 'instance');
    const runtime = new AgentOursRuntime(f.assignment, {
      ...f.deps,
      journal: c.journal,
      assertFence: c.assertFence,
    });
    const room = {
      id: 'r',
      cid: 'ROOM',
      seat: 'invite-id',
      action: 'admit-a',
      redeem: async () => {
        redeems++;
        return { cid: 'ROOM' };
      },
      observe: async () => 'pending' as const,
      discardSecret: async () => {},
    };
    await expect(runtime.prepare(room, 250)).rejects.toThrow('ROOM_PENDING');
    const generation = c.resumeGeneration();
    const replacement = new AgentOursRuntime(
      { ...f.assignment, generation },
      { ...f.deps, journal: c.journal, assertFence: c.assertFence },
    );
    await replacement.prepare({ ...room, observe: async () => 'established' });
    expect(redeems).toBe(1);
    c.unlock();
  } finally {
    f.cleanup();
    rmSync(lockRoot, { recursive: true, force: true });
  }
});
it('pinned CID and action cannot change on an existing runtime', async () => {
  const f = fixture();
  try {
    await f.runtime.prepare();
    expect(() => new AgentOursRuntime({ ...f.assignment, expectedCid: 'OTHER' }, f.deps)).toThrow(
      'MISMATCH',
    );
    expect(() => new AgentOursRuntime({ ...f.assignment, action: 'new' }, f.deps)).toThrow(
      'MISMATCH',
    );
  } finally {
    f.cleanup();
  }
});
it('malformed release response retains cleanup pending', async () => {
  const f = fixture();
  try {
    await f.runtime.prepare();
    f.deps.client.releaseLease = async () => ({}) as never;
    await expect(f.runtime.terminal()).rejects.toThrow('INVALID_RELEASE_ACK');
    expect(f.runtime.snapshot.phase).toBe('CLEANUP_PENDING');
  } finally {
    f.cleanup();
  }
});
