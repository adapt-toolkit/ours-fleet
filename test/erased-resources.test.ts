import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetCommandAuditStore, type FleetAuditPresentation } from '../src/fleet-command-audit.js';
import { FleetLifecycleOutbox } from '../src/owner-channel/lifecycle-outbox.js';
import { eraseResourcePresentations } from '../src/erased-resources.js';
import { stateRoot } from '../src/paths.js';
let root: string, prior: string | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-erased-audit-')); prior = process.env.OURS_FLEET_HOME; process.env.OURS_FLEET_HOME = root; });
afterEach(() => { if (prior === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = prior; rmSync(root, { recursive: true, force: true }); });
const presentation = (id: string): FleetAuditPresentation => ({ kind: 'task', operation: 'create', eventId: 'event-' + id, id, title: id + ' secret title', newState: 'backlog', reason: id + ' secret reason', roomName: id + ' secret room', agents: [] });
it('redacts exact audit content and stale writers while preserving unrelated work and replay evidence', () => {
  const path = join(stateRoot(), 'agents', 'Coordinator', '.fleet-command-audit.json');
  const store = new FleetCommandAuditStore(path);
  const argv = ['task', 'create', 'target private argv'];
  const target = store.begin('req-target', 'caller', argv);
  store.finish(target.correlationId, 'caller', { class: 'success', effect: 'completed', resourceIds: { task: 'target' }, presentations: [presentation('target')] });
  const other = store.begin('req-other', 'caller', ['task', 'create', 'other']);
  store.finish(other.correlationId, 'caller', { class: 'success', effect: 'completed', resourceIds: { task: 'other' }, presentations: [presentation('other')] });
  eraseResourcePresentations([{ kind: 'task', id: 'target' }]);
  const assertClean = () => {
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('target secret'); expect(text).not.toContain('target private argv'); expect(text).toContain('other secret title');
  };
  assertClean();
  store.invocation(other.correlationId, 'caller', 'delivered'); // stale pre-erasure in-memory store
  assertClean();
  expect(store.begin('req-target', 'caller', argv).correlationId).toBe(target.correlationId);
  expect(() => store.begin('req-target', 'caller', ['task', 'create', 'different'])).toThrow(/reused/);
  expect(JSON.parse(readFileSync(path, 'utf8')).attempts).toHaveLength(2);
});
it('keeps outbox digests/delivery and prevents pending or persisted labels from reappearing', () => {
  const path = join(stateRoot(), 'agents', 'Coordinator', '.owner-channel-lifecycle-outbox.json');
  const outbox = new FleetLifecycleOutbox(path);
  outbox.enqueue([presentation('target'), presentation('other')]);
  const digest = outbox.pending()[0].digest;
  eraseResourcePresentations([{ kind: 'task', id: 'target' }]);
  expect(JSON.stringify(outbox.pending())).not.toContain('target secret');
  outbox.finish(digest, 'delivered');
  expect(readFileSync(path, 'utf8')).not.toContain('target secret');
  const reopened = new FleetLifecycleOutbox(path);
  expect(reopened.integrity().ok).toBe(true); expect(reopened.pending()).toHaveLength(1);
  expect(reopened.pending()[0].presentation.id).toBe('other');
});
