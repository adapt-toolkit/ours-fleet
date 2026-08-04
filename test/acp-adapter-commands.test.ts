import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveBundledAcpAgent } from '../src/harness/acp-agent.js';

/**
 * Adapter contract for the deterministic owner commands that are forwarded to
 * the harness (/clear, /compact, /model). The owner channel promises that a
 * slash command is either executed locally by the adapter or refused — never
 * silently delivered to the model as a prompt. These assertions pin the
 * verified behavior of the exact adapter artifacts ours-fleet bundles, so an
 * adapter upgrade that changes the command surface fails loudly here and
 * forces HARNESS_LOCAL_COMMANDS in src/owner-channel/commands.ts to be
 * re-verified rather than silently drifting into untruthful behavior.
 */

const bundleText = (packageName: string, binName: string): string | undefined => {
  const resolution = resolveBundledAcpAgent(packageName, binName, binName);
  if (!resolution.bundled) return undefined;
  // argv is [node, entrypoint] for a bundled adapter. The entrypoint may be a
  // thin re-export (claude-agent-acp keeps its logic in sibling dist files),
  // so read every JS file shipped next to it.
  const dist = dirname(resolution.argv[1]);
  return readdirSync(dist)
    .filter(name => name.endsWith('.js'))
    .map(name => readFileSync(join(dist, name), 'utf8'))
    .join('\n');
};

describe('bundled ACP adapter command contract', () => {
  it('codex-acp intercepts /compact locally but has no /clear or /model builtin', () => {
    const text = bundleText('@agentclientprotocol/codex-acp', 'codex-acp');
    if (!text) return; // optional dependency intentionally omitted in this install
    // /compact is a builtin handled without a model turn (runCompact).
    expect(text).toContain('name: "compact"');
    expect(text).toContain('runCompact');
    // No builtin named clear or model exists: such prompts fall through
    // tryHandleCommand (handled: false) into sendPrompt and would reach the
    // model, which is why the owner channel must refuse to forward them.
    expect(text).not.toContain('name: "clear"');
    expect(text).not.toContain('name: "model"');
    expect(text).toContain('tryHandleCommand');
  });

  it('claude-agent-acp routes slash commands into the Claude SDK for local execution', () => {
    const text = bundleText('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp');
    if (!text) return; // optional dependency intentionally omitted in this install
    // The SDK executes slash commands locally and persists their output inside
    // local-command marker tags (the /model path), resets the conversation for
    // /clear, and reports manual /compact completion — the markers below are
    // the shipped evidence for each.
    expect(text).toContain('local-command-stdout');
    expect(text).toContain('conversation_reset');
    expect(text).toContain('/compact');
    expect(text).toContain('/model');
  });
});
