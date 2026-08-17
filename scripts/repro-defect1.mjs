/**
 * Live reproduction of defect 1 — owner prompts that fail instead of queueing.
 *
 * Drives the REAL bundled claude-agent-acp adapter through the exact state the
 * live failures were in on this host on 2026-08-17. The conversation store shows
 * every one of the five failures arrived while a tool call sat at
 * `status: "pending"` with `rawInput: {}` — i.e. while the assistant message was
 * still STREAMING its `tool_use` block (all five live cases were long ssh
 * heredocs, which take seconds to stream). Firing an interrupting owner prompt
 * in that window is what produces
 * `Internal error: [ede_diagnostic] result_type=user last_content_type=n/a`.
 *
 * Shape:
 *   1. a monitor-style steered wake makes the ADAPTER start a turn fleet never
 *      tracks (`startedNewTurn`), so `cancelActive` has no `activeTurn` to await;
 *   2. the turn begins streaming a large tool_use block;
 *   3. an owner prompt arrives with `interrupt: true` inside that window.
 *
 * Usage: node scripts/repro-defect1.mjs [attempts]
 * Exits 1 if any attempt reproduced the failure, 0 if none did.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpSession } from '../dist/session/acp.js';
import { bundledAcpAgent } from '../dist/harness/acp-agent.js';

const attempts = Number(process.argv[2] ?? 3);
const stateDir = mkdtempSync(join(tmpdir(), 'dev2-repro-'));
const log = line => console.log(`[repro] ${line}`);

const session = await AcpSession.start({
  name: 'repro',
  argv: bundledAcpAgent('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp', 'claude-agent-acp'),
  cwd: stateDir,
  env: {},
  stateDir,
  mode: 'fresh',
  permissions: { approval: 'never', filesystem: 'full', unattended: 'allow' },
  modeId: 'bypassPermissions',
  permissionMode: { fleetMode: 'allow', native: { permission_mode: 'bypassPermissions' } },
  log: line => log(`session: ${line}`),
});

let diagnostics = 0;
let pendingToolSeen;
session.subscribe(event => {
  if (typeof event.text === 'string' && event.text.includes('ede_diagnostic')) {
    diagnostics++;
    log(`>>> ${event.text}`);
  }
  // The exact live trigger window: the tool_use block has begun but its input
  // has not finished streaming.
  if (event.kind === 'tool_call' && event.status === 'pending') pendingToolSeen?.();
});

// A tool whose INPUT is large, so the tool_use block streams for seconds —
// the same shape as the live `ssh ... 'bash -s' <<'EOS'` heredocs.
const WAKE = 'Run exactly one Bash command. It must be a single bash heredoc that writes a '
  + '120-line shell script to /tmp/dev2-repro-script.sh and then runs it. Every one of the '
  + '120 lines must be a distinct `echo "line NNN: <a different 60-character filler string>"`. '
  + 'Write the whole heredoc out in one tool call. Do nothing else.';

let reproduced = 0;
try {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(`--- attempt ${attempt}/${attempts}`);
    const before = diagnostics;
    const window = new Promise(resolve => { pendingToolSeen = resolve; });
    const wake = await session.queuePrompt(WAKE, {
      steer: true, origin: { kind: 'fleet-monitor' },
    });
    log(`wake: ${JSON.stringify(await wake.completion)}`);

    const opened = await Promise.race([
      window.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 120_000)),
    ]);
    pendingToolSeen = undefined;
    if (!opened) {
      log('no pending tool_call observed; attempt inconclusive');
      continue;
    }
    log(`tool_use block started; fleet-tracked activeTurn=`
      + `${session.activeTurn ? session.activeTurn.id : 'NONE'}`);

    const startedAt = Date.now();
    const owner = await session.queuePrompt('Reply with the single word: pong.', {
      interrupt: true,
      interruptSource: 'owner',
      origin: { kind: 'owner', requestId: `repro-${attempt}`, displayText: 'ping' },
    });
    log(`owner admission after ${Date.now() - startedAt}ms: `
      + `delivery=${owner.delivery ?? '<none reported>'} queuedBehind=${owner.queuedBehind}`);
    const result = await owner.completion;
    log(`owner turn: ${JSON.stringify(result).slice(0, 260)}`);

    if (diagnostics > before || !result.succeeded) {
      reproduced++;
      log(`attempt ${attempt}: REPRODUCED (${result.detail ?? result.outcome})`);
    } else {
      log(`attempt ${attempt}: owner turn ${result.outcome}`);
    }
    await session.interrupt('local-console').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
} finally {
  console.log(`[repro] VERDICT: ${reproduced}/${attempts} attempts reproduced the failure `
    + `(${diagnostics} ede_diagnostic events)`);
  process.exitCode = reproduced > 0 ? 1 : 0;
  await session.close().catch(() => {});
  rmSync(stateDir, { recursive: true, force: true });
}
