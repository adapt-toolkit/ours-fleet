import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpSession } from '../src/session/acp.js';
import { RoleControlServer, controlRequest } from '../src/session/control.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(approval: 'ask' | 'allow' | 'deny' = 'allow') {
  const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-acp-'));
  dirs.push(stateDir);
  return AcpSession.start({
    name: 'A',
    argv: [process.execPath, fixture],
    cwd: stateDir,
    env: {},
    stateDir,
    mode: 'fresh',
    permissions: { approval, filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
  });
}

describe('AcpSession', () => {
  it('initializes ACP v1, streams typed events, and completes a prompt', async () => {
    const session = await start();
    const result = await session.submitPrompt('hello');
    expect(result).toMatchObject({
      accepted: true, outcome: 'completed', succeeded: true, detail: 'end_turn',
    });
    expect(session.eventsSince(0).some(event =>
      event.kind === 'agent_text' && event.text === 'echo:hello')).toBe(true);
    await session.close();
  });

  it('a refused turn is delivered but not successful (1.2)', async () => {
    const session = await start();
    const result = await session.submitPrompt('refuse this');
    expect(result).toMatchObject({
      accepted: true,          // the agent did answer — delivery happened
      outcome: 'refused',      // …and declined to do the work
      succeeded: false,        // …so no caller may treat it as done
      detail: 'refusal',
    });
    await session.close();
  });

  it('a cancelled turn is delivered but not successful (1.2)', async () => {
    const session = await start();
    const result = await session.submitPrompt('cancel this');
    expect(result).toMatchObject({ accepted: true, outcome: 'cancelled', succeeded: false });
    await session.close();
  });

  it('an offline session neither accepts nor succeeds', async () => {
    const session = await start();
    await session.close();
    const result = await session.submitPrompt('hello');
    expect(result).toMatchObject({ accepted: false, outcome: 'failed', succeeded: false });
  });

  it('applies common automatic approval to ACP permission requests', async () => {
    const session = await start('allow');
    const result = await session.submitPrompt('permission');
    expect(result.accepted).toBe(true);
    expect(session.eventsSince(0).filter(event => event.kind === 'agent_text').map(event => event.text))
      .toContain(':allow');
    await session.close();
  });

  it('keeps ask-mode permission pending for an attached controller', async () => {
    const session = await start('ask');
    session.setControllerAttached(true);
    const prompt = session.submitPrompt('permission');
    let permission = session.eventsSince(0).find(event => event.kind === 'permission');
    for (let i = 0; i < 20 && !permission; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      permission = session.eventsSince(0).find(event => event.kind === 'permission');
    }
    expect(permission?.permissionId).toBeTruthy();
    expect(session.snapshot().readiness).toBe('awaiting_permission');
    expect(session.respondPermission(permission!.permissionId!, 'allow')).toBe(true);
    expect((await prompt).accepted).toBe(true);
    session.setControllerAttached(false);
    await session.close();
  });

  it('exposes prompt submission and snapshots over the role control socket', async () => {
    const session = await start();
    const stateDir = dirs.at(-1)!;
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    const snapshot = await controlRequest(stateDir, { command: 'snapshot' });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.result).toMatchObject({ backend: 'acp', alive: true });
    const prompt = await controlRequest(stateDir, { command: 'submit_prompt', text: 'control' });
    expect(prompt.ok).toBe(true);
    await control.close();
    await session.close();
  });
});
