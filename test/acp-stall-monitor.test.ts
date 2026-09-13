import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DurableMonitorDelivery } from '../src/monitor-delivery.js';
import { AcpSession } from '../src/session/acp.js';

it('retains a monitor hint behind a real watchdog operator fence until a synchronized successor drains it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'acp-stall-monitor-'));
  let session: AcpSession | undefined;
  let delivery: DurableMonitorDelivery | undefined;
  const saved = () => JSON.parse(readFileSync(join(stateDir, '.monitor-ingress.json'), 'utf8'));
  const base = { name: 'A', stateDir, cwd: stateDir,
    permissions: { approval: 'allow' as const, filesystem: 'workspace' as const, unattended: 'deny' as const },
    log: () => {},
  };
  try {
    session = await AcpSession.start({ ...base, mode: 'fresh',
      argv: [process.execPath, join(import.meta.dirname, 'fixtures/stall-acp-agent.mjs')],
      env: { STALL_FIXTURE_MODE: 'cancel-error' }, permissionMetadataSource: 'codex-acp',
      stallRecovery: { timeoutMs: 500, tickMs: 60_000, cancelWaitMs: 1_000 },
    });
    const original = session.submitPrompt('original');
    await vi.waitFor(() => expect(session!.conversationPage({ limit: 100 }).events
      .some(event => JSON.stringify(event).includes('willRetry'))).toBe(true));
    delivery = new DurableMonitorDelivery({ stateDir, session, log: () => {} });
    delivery.start('stable-source');
    await delivery.admit({ scope: 'stable-source', cursor: 7, events: [{ key: 'message_received:peer:7',
      event: { event: 'message_received', from: 'peer', msg_id: 7 } }] });
    const internal = session as unknown as { activeTurn: { lastProgressAt: number };
      stallWatchdog: { tick(): Promise<void> } };
    internal.activeTurn.lastProgressAt -= 2_000;
    await internal.stallWatchdog.tick();
    expect(await original).toMatchObject({ cancellationSource: 'stall-watchdog' });
    // Cross the journal's periodic pump as well as its synchronous state-event wake.
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(session.isAlive()).toBe(true);
    expect(session.snapshot()).toMatchObject({ readiness: 'failed', lastError: expect.stringContaining('operator attention') });
    expect(saved()).toMatchObject({ coveredCursor: 7, rows: [{ state: 'queued' }] });
    expect(session.conversationPage({ limit: 100 }).events.filter(event => event.kind === 'prompt.started')).toHaveLength(1);
    delivery.close();
    await session.close();
    const wire = join(stateDir, 'successor-wire');
    session = await AcpSession.start({ ...base, mode: 'resume',
      argv: [process.execPath, join(import.meta.dirname, 'fixtures/acp-agent.mjs')],
      env: { ACP_FIXTURE_WIRE_LOG: wire },
    });
    expect(session.snapshot().readiness).toBe('idle');
    delivery = new DurableMonitorDelivery({ stateDir, session, log: () => {} });
    delivery.start('stable-source');
    // No new admit/mail: constructor replay plus startup readiness owns the wake.
    await vi.waitFor(() => expect(saved().rows).toMatchObject([{ state: 'terminal', outcome: 'completed' }]));
    expect(saved().rows).toHaveLength(1);
    expect(saved().coveredCursor).toBe(7);
    expect(readFileSync(wire, 'utf8')).toBe('prompt\n');
  } finally {
    delivery?.close();
    await session?.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
