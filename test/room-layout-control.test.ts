import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLayoutControl } from '../src/rooms-tasks/layout-control.js';
import type { LayoutInstance } from '../src/rooms-tasks/layout.js';
let root: string, previous: string | undefined;
beforeEach(() => { previous = process.env.OURS_FLEET_HOME; root = mkdtempSync(join(tmpdir(), 'layout-control-')); process.env.OURS_FLEET_HOME = root; mkdirSync(join(root, '.ours-fleet')); });
afterEach(() => { if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous; rmSync(root, { recursive: true, force: true }); });
function fixture() {
  let sessionId = 'thread-1', stopping = false;
  const runtime = { snapshot: { instance: 'launch', cid: 'cid' }, admit: vi.fn(async () => () => {}), joinAdditionalRoom: vi.fn(async () => {}) };
  const session = { snapshot: () => ({ alive: true, sessionId }), queuePrompt: vi.fn(async () => ({ promptId: 'prompt', completion: Promise.resolve({ succeeded: true }) })) };
  const retire = vi.fn(async () => {});
  const handle = createLayoutControl({ agent: 'Worker', temporary: true, standalone: true, runtime: runtime as any, session: session as any, retire, stopping: () => stopping });
  return { handle, runtime, session, retire, replace: () => { sessionId = 'thread-2'; }, stop: () => { stopping = true; } };
}
describe('native layout exact-instance control', () => {
  it('rejects replacement sessions before membership or prompt delivery', async () => {
    const f = fixture(), instance = await f.handle({ action: 'inspect' }) as LayoutInstance; f.replace();
    await expect(f.handle({ action: 'join', instance, invite: 'invite', roomCid: 'room' })).rejects.toThrow('changed');
    expect(f.runtime.joinAdditionalRoom).not.toHaveBeenCalled();
  });
  it('queues later assignments on the existing session', async () => {
    const f = fixture(), instance = await f.handle({ action: 'inspect' }) as LayoutInstance;
    const assignment = { id: 'design:worker', room_id: 'room', room_cid: 'cid', goal: 'Design', participant: 'worker' };
    await f.handle({ action: 'assign', instance, assignment });
    expect(f.session.queuePrompt).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(assignment)), expect.anything());
    expect(f.session.queuePrompt).toHaveBeenCalledWith(expect.stringContaining('No reply or room publication is required'), expect.anything());
  });
  it('serializes retirement intent ahead of subsequent admissions', async () => {
    const f = fixture(), instance = await f.handle({ action: 'inspect' }) as LayoutInstance;
    const retired = f.handle({ action: 'retire', instance });
    await expect(f.handle({ action: 'join', instance, invite: 'invite', roomCid: 'room' })).rejects.toThrow('live standalone');
    await retired; expect(f.retire).toHaveBeenCalledOnce(); expect(f.runtime.joinAdditionalRoom).not.toHaveBeenCalled();
  });
  it('refuses a supervisor stopping even while the harness is still alive', async () => {
    const f = fixture(); f.stop(); await expect(f.handle({ action: 'inspect' })).rejects.toThrow('live standalone');
  });
});
