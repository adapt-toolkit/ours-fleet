import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpSession } from '../src/session/acp.js';
import type {
  ConversationEventV1, PermissionRequestedPayload, PermissionResolvedPayload,
} from '../src/session/conversation-types.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];
const sessions: AcpSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(extra: {
  permissionTimeoutMs?: number; controllerGraceMs?: number;
  unattended?: 'deny' | 'wait';
} = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-acp-perm-'));
  dirs.push(stateDir);
  const session = await AcpSession.start({
    name: 'A', argv: [process.execPath, fixture], cwd: stateDir, env: {},
    stateDir, mode: 'fresh',
    permissions: {
      approval: 'ask', filesystem: 'workspace',
      unattended: extra.unattended ?? 'deny',
    },
    log: () => {},
    ...(extra.permissionTimeoutMs !== undefined
      ? { permissionTimeoutMs: extra.permissionTimeoutMs } : {}),
    ...(extra.controllerGraceMs !== undefined
      ? { controllerGraceMs: extra.controllerGraceMs } : {}),
  });
  sessions.push(session);
  return session;
}

const events = (session: AcpSession): ConversationEventV1[] =>
  session.conversationPage({ limit: 1_000 }).events;

async function waitForPending(session: AcpSession): Promise<ConversationEventV1> {
  for (let i = 0; i < 200 && !events(session).some(e => e.kind === 'permission.requested'); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  return events(session).find(e => e.kind === 'permission.requested')!;
}

describe('permission lifecycle', () => {
  it('stamps pending permissions with generation and expiry', async () => {
    const session = await start({ permissionTimeoutMs: 60_000 });
    session.setControllerAttached(true);
    void session.queuePrompt('permission please');
    const requested = await waitForPending(session);
    const payload = requested.payload as PermissionRequestedPayload;
    expect(requested.sessionGeneration).toBe(session.conversationSnapshot().sessionGeneration);
    expect(Date.parse(payload.expiresAt!)).toBeGreaterThan(Date.now());
  });

  it('expires an unanswered permission and cancels it toward the agent', async () => {
    const session = await start({ permissionTimeoutMs: 150 });
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission please');
    const requested = await waitForPending(session);
    for (let i = 0; i < 200 && !events(session).some(e => e.kind === 'permission.resolved'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const resolved = events(session).find(e => e.kind === 'permission.resolved')!;
    expect(resolved.permissionId).toBe(requested.permissionId);
    expect(resolved.payload as PermissionResolvedPayload).toMatchObject({
      decision: 'expired', decisionSource: 'automatic',
    });
    // A late answer is stale, not a decision.
    expect(session.respondPermission(requested.permissionId!, 'allow')).toBe(false);
    // The fixture holds the prompt open after a cancelled permission; end it.
    await session.interrupt('owner');
    await queued.completion;
  });

  it('applies the unattended policy after the last controller detaches (grace)', async () => {
    const session = await start({ controllerGraceMs: 120, unattended: 'deny' });
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission please');
    await waitForPending(session);
    // The only controller walks away mid-permission.
    session.setControllerAttached(false);
    await new Promise(resolve => setTimeout(resolve, 300));
    const resolved = events(session).find(e => e.kind === 'permission.resolved')!;
    expect(resolved.payload as PermissionResolvedPayload).toMatchObject({
      decision: 'denied', decisionSource: 'automatic',
      policy: 'permissions.unattended=deny',
    });
    await queued.completion;
  });

  it('keeps a pending permission when a controller returns within the grace', async () => {
    const session = await start({ controllerGraceMs: 200, unattended: 'deny' });
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission please');
    const requested = await waitForPending(session);
    session.setControllerAttached(false);
    await new Promise(resolve => setTimeout(resolve, 50));
    session.setControllerAttached(true);   // tab reconnected in time
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(events(session).some(e => e.kind === 'permission.resolved')).toBe(false);
    expect(session.respondPermission(requested.permissionId!, 'allow')).toBe(true);
    await queued.completion;
  });

  it('validates the session generation on v2 responses', async () => {
    const session = await start();
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission please');
    const requested = await waitForPending(session);
    const generation = session.conversationSnapshot().sessionGeneration;
    expect(session.respondPermissionV2(requested.permissionId!, 'allow', 'stale-generation'))
      .toBe('stale');
    expect(session.respondPermissionV2(requested.permissionId!, 'allow', generation))
      .toBe('accepted');
    // First writer won; the second identical answer is stale.
    expect(session.respondPermissionV2(requested.permissionId!, 'allow', generation))
      .toBe('stale');
    await queued.completion;
  });

  it('records cancelled permission decisions when the turn is interrupted', async () => {
    const session = await start();
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission please');
    const requested = await waitForPending(session);
    await session.interrupt('owner');
    await queued.completion;
    const resolved = events(session).find(e =>
      e.kind === 'permission.resolved' && e.permissionId === requested.permissionId)!;
    expect(resolved.payload as PermissionResolvedPayload).toMatchObject({
      decision: 'cancelled', decisionSource: 'automatic',
    });
  });
});
