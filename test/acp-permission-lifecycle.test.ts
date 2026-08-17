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
  approval?: 'ask' | 'auto' | 'allow' | 'deny';
  permissionMode?: { fleetMode: 'ask' | 'auto' | 'allow'; nativeMode: string };
  permissionMetadataSource?: 'codex-acp';
} = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-acp-perm-'));
  dirs.push(stateDir);
  const session = await AcpSession.start({
    name: 'A', argv: [process.execPath, fixture], cwd: stateDir, env: {},
    stateDir, mode: 'fresh',
    permissions: {
      approval: extra.approval ?? 'ask', filesystem: 'workspace',
      unattended: extra.unattended ?? 'deny',
    },
    permissionMode: extra.permissionMode,
    permissionMetadataSource: extra.permissionMetadataSource,
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
  it('auto-allows a Codex 1.1.7 protected-MCP request under effective allow', async () => {
    const session = await start({
      approval: 'allow', unattended: 'wait',
      permissionMode: { fleetMode: 'allow', nativeMode: 'agent-full-access' },
      permissionMetadataSource: 'codex-acp',
    });
    const queued = await session.queuePrompt('permission protected mcp');
    for (let i = 0; i < 200 && !events(session).some(e =>
      e.kind === 'permission.resolved'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const resolved = events(session).find(e => e.kind === 'permission.resolved');
    expect(resolved?.payload as PermissionResolvedPayload).toMatchObject({
      decision: 'allowed', decisionSource: 'automatic', optionId: 'allow_once',
      policy: 'permissionMode.fleetMode=allow',
    });
    expect(session.snapshot().readiness).not.toBe('awaiting_permission');
    expect(session.snapshot().pendingPermissionId).toBeUndefined();
    expect((await queued.completion).succeeded).toBe(true);
  });

  it.each([
    ['ask', 'ask'],
    ['auto', 'auto'],
  ] as const)('keeps protected MCP pending under effective %s', async (approval, fleetMode) => {
    const session = await start({
      approval, unattended: 'wait', permissionMetadataSource: 'codex-acp',
      permissionMode: { fleetMode, nativeMode: fleetMode === 'ask' ? 'read-only' : 'agent' },
    });
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission protected mcp');
    const requested = await waitForPending(session);
    expect(session.snapshot().readiness).toBe('awaiting_permission');
    expect(session.respondPermission(requested.permissionId!, 'decline')).toBe(true);
    await queued.completion;
  });

  it('denies protected MCP once under deny instead of granting it', async () => {
    const session = await start({
      approval: 'deny', unattended: 'wait', permissionMetadataSource: 'codex-acp',
      permissionMode: { fleetMode: 'auto', nativeMode: 'agent' },
    });
    const result = await session.submitPrompt('permission protected mcp');
    const resolved = events(session).find(e => e.kind === 'permission.resolved');
    expect(resolved?.payload as PermissionResolvedPayload).toMatchObject({
      decision: 'denied', decisionSource: 'automatic',
      policy: 'permissions.approval=deny', optionId: 'decline',
    });
    expect(session.snapshot().pendingPermissionId).toBeUndefined();
    expect(result.succeeded).toBe(true);
  });

  it.each([
    ['generic locationless execute', 'permission locationless execute'],
    ['malformed protected marker', 'permission protected mcp malformed'],
  ])('keeps %s fail-closed under Codex allow', async (_label, prompt) => {
    const session = await start({
      approval: 'allow', unattended: 'wait', permissionMetadataSource: 'codex-acp',
      permissionMode: { fleetMode: 'allow', nativeMode: 'agent-full-access' },
    });
    session.setControllerAttached(true);
    const queued = await session.queuePrompt(prompt);
    const requested = await waitForPending(session);
    expect(session.snapshot().readiness).toBe('awaiting_permission');
    expect(session.respondPermission(requested.permissionId!, 'decline')).toBe(true);
    await queued.completion;
  });

  it('does not trust the protected marker without an authenticated Codex source', async () => {
    const session = await start({
      approval: 'allow', unattended: 'wait',
      permissionMode: { fleetMode: 'allow', nativeMode: 'agent-full-access' },
    });
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission protected mcp');
    const requested = await waitForPending(session);
    expect(session.snapshot().readiness).toBe('awaiting_permission');
    expect(session.respondPermission(requested.permissionId!, 'decline')).toBe(true);
    await queued.completion;
  });

  it('honors an explicit native allow override over neutral ask', async () => {
    const session = await start({
      approval: 'ask', unattended: 'wait', permissionMetadataSource: 'codex-acp',
      permissionMode: { fleetMode: 'allow', nativeMode: 'agent' },
    });
    const result = await session.submitPrompt('permission protected mcp');
    expect(events(session).find(e => e.kind === 'permission.resolved')?.payload)
      .toMatchObject({ decision: 'allowed', optionId: 'allow_once' });
    expect(result.succeeded).toBe(true);
  });

  it('honors an explicit native prompt override over neutral allow', async () => {
    const session = await start({
      approval: 'allow', unattended: 'wait', permissionMetadataSource: 'codex-acp',
      permissionMode: { fleetMode: 'auto', nativeMode: 'agent' },
    });
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission protected mcp');
    const requested = await waitForPending(session);
    expect(session.respondPermission(requested.permissionId!, 'decline')).toBe(true);
    await queued.completion;
  });

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
