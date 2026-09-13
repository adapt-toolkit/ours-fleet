import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompactionNotices } from '../src/owner-channel/compaction-notices.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(enabled = true, send = vi.fn(async () => {})) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-compaction-notices-')); dirs.push(dir);
  const path = join(dir, 'outbox.json');
  let authorized = true;
  const options = { path, enabled, send, authorized: () => authorized, log: vi.fn() };
  return { path, options, send, notices: new CompactionNotices(options), revoke: () => { authorized = false; } };
}
const event = (status: string, replayed = false) => ({
  sessionId: 's1', compactionId: 'c1', status, replayed,
  contact: 'A'.repeat(64), replyTo: 'B'.repeat(64),
});

it('sends one start and terminal with durable claims before each side effect', async () => {
  const fixture = setup();
  fixture.send.mockImplementation(async () => {
    expect(readFileSync(fixture.path, 'utf8')).toContain('sending');
  });
  await Promise.all([fixture.notices.observe(event('in_progress')), fixture.notices.observe(event('completed'))]);
  await fixture.notices.observe(event('completed'));
  expect(fixture.send.mock.calls.map(call => call[1])).toEqual([
    'Compacting the conversation…', 'Compaction done.',
  ]);
  const restarted = new CompactionNotices(fixture.options);
  await restarted.observe(event('in_progress'));
  await restarted.observe(event('completed'));
  expect(fixture.send).toHaveBeenCalledTimes(2);
});

it('keeps replay, terminal-only history and default opt-out silent', async () => {
  const fixture = setup(false);
  await fixture.notices.observe(event('in_progress'));
  const enabled = new CompactionNotices({ ...fixture.options, enabled: true });
  await enabled.observe(event('in_progress', true));
  await enabled.observe(event('completed', true));
  await enabled.observe(event('completed'));
  await enabled.observe(event('in_progress'));
  expect(fixture.send).not.toHaveBeenCalled();
});

it('fails closed on disk failure and corrupt outbox without sending', async () => {
  const fixture = setup();
  writeFileSync(fixture.path, '{}'); // Parent is a file: atomic mkdir/write must fail.
  const missingParent = new CompactionNotices({ ...fixture.options, path: join(fixture.path, 'missing', 'state.json') });
  await missingParent.observe(event('in_progress'));
  writeFileSync(fixture.path, 'PRIVATE_BROKEN_STATE');
  await new CompactionNotices(fixture.options).observe(event('in_progress'));
  expect(fixture.send).not.toHaveBeenCalled();
  expect(JSON.stringify(fixture.options.log.mock.calls)).not.toContain('PRIVATE_BROKEN_STATE');
});

it('does not replay a claimed send after restart before its outcome was recorded', async () => {
  const fixture = setup();
  await fixture.notices.observe(event('in_progress'));
  const data = JSON.parse(readFileSync(fixture.path, 'utf8'));
  data.rows[0].start = 'sending';
  writeFileSync(fixture.path, JSON.stringify(data));
  const restored = new CompactionNotices(fixture.options);
  await restored.observe(event('in_progress'));
  await restored.observe(event('completed'));
  expect(fixture.send).toHaveBeenCalledTimes(1);
  expect(readFileSync(fixture.path, 'utf8')).toContain('unknown');
});

it('does not resend ambiguous start or emit its completion', async () => {
  const send = vi.fn(async () => { throw new Error('PRIVATE_TRANSPORT_DETAIL'); });
  const fixture = setup(true, send);
  await fixture.notices.observe(event('in_progress'));
  const restarted = new CompactionNotices(fixture.options);
  await restarted.observe(event('in_progress'));
  await restarted.observe(event('completed'));
  expect(send).toHaveBeenCalledTimes(1);
  expect(readFileSync(fixture.path, 'utf8')).toContain('unknown');
  expect(JSON.stringify(fixture.options.log.mock.calls)).not.toContain('PRIVATE_TRANSPORT_DETAIL');
});

it('rechecks recipient authorization before terminal send', async () => {
  const fixture = setup();
  await fixture.notices.observe(event('in_progress'));
  fixture.revoke();
  await fixture.notices.observe(event('failed'));
  expect(fixture.send).toHaveBeenCalledTimes(1);
});

it('keeps raw future status and summary data out of persisted and transmitted notices', async () => {
  const fixture = setup();
  await fixture.notices.observe({ ...event('in_progress'), summary: 'SECRET' } as ReturnType<typeof event>);
  await fixture.notices.observe(event('FUTURE_PRIVATE_STATUS'));
  await fixture.notices.observe(event('unknown_ended'));
  expect(JSON.stringify(fixture.send.mock.calls)).not.toContain('SECRET');
  expect(readFileSync(fixture.path, 'utf8')).not.toContain('FUTURE_PRIVATE_STATUS');
  expect(fixture.send).toHaveBeenCalledTimes(2);
});
