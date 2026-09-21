import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getAdapter } from '../src/harness/registry.js';
import { analyzeRolePermissions } from '../src/permissions.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';
import type { CommonPermissions, ResolvedRole } from '../src/config.js';

/**
 * The shipped skills are the ONLY instructions a spawning agent reads. If they
 * describe permissions the CLI does not implement, the agent builds a role the
 * CLI then refuses — which is exactly what happened: both variants prescribed
 * `--approval ask --filesystem workspace --unattended deny` as a default while
 * telling the agent to stop at a failed doctor check, and that combination is
 * what doctor fails.
 *
 * So these tests do not check that the skills are well written. They check that
 * what the skills SAY matches what the code DOES.
 */

const VARIANTS = [
  { id: 'claude-code', harness: 'claude-code', path: 'integrations/claude-code/skills' },
  { id: 'codex', harness: 'codex', path: 'integrations/codex/ours-fleet/skills' },
] as const;

const skill = (variantPath: string, name: string) =>
  readFileSync(join(process.cwd(), variantPath, name, 'SKILL.md'), 'utf8');

const roleWith = (harness: string, permissions: CommonPermissions): ResolvedRole => ({
  name: 'Spawned', harness, identity: 'Spawned', sourceFile: '(skill example)',
  permissions, permissionsDeclared: true,
});

/**
 * Every `ours-fleet spawn` command a skill prints, with the permission intent
 * it actually passes. Defaults come from config.ts, because an example that
 * omits a flag gets the built-in — which is part of what it prescribes.
 */
function spawnExamples(text: string): Array<{ command: string; permissions: CommonPermissions }> {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map(m => m[1]);
  return blocks
    .map(b => b.replace(/\\\n\s*/g, ' '))                 // join continuations
    .flatMap(b => b.split('\n'))
    .filter(line => line.includes('ours-fleet spawn'))
    .map(command => ({
      command: command.trim(),
      permissions: {
        approval: (/--approval (\S+)/.exec(command)?.[1] ?? 'ask') as CommonPermissions['approval'],
        filesystem: (/--filesystem (\S+)/.exec(command)?.[1] ?? 'workspace') as CommonPermissions['filesystem'],
        unattended: (/--unattended (\S+)/.exec(command)?.[1] ?? 'deny') as CommonPermissions['unattended'],
      },
    }));
}

describe('following only the shipped skill produces a role doctor accepts', () => {
  for (const v of VARIANTS) {
    const examples = spawnExamples(skill(v.path, 'spawn-ours-agent'));

    it(`${v.id}: prints at least one runnable spawn command`, () => {
      expect(examples.length).toBeGreaterThan(0);
      // A placeholder in a permission flag would make the recipe unrunnable and
      // silently fall through to the built-in default below.
      for (const e of examples)
        for (const value of Object.values(e.permissions))
          expect(value, e.command).toMatch(/^[a-z-]+$/);
    });

    it(`${v.id}: no spawn command it prints would FAIL doctor`, () => {
      for (const e of examples) {
        const a = analyzeRolePermissions(roleWith(v.harness, e.permissions));
        const doctorFails = !a.floor!.meets && a.floorSeverity === 'fail';
        expect(doctorFails, `${e.command}\n  missing: ${a.floor!.missing.join(', ')}`).toBe(false);
      }
    });

    it(`${v.id}: prescribes a command that CLEARS the floor for an unattended role`, () => {
      // Not merely "doctor does not fail it": an agent following this skill for
      // the usual case — a role working with nobody watching — must end up with
      // every floor capability, or it will silently do less than its briefing.
      const clearing = examples.filter(e =>
        analyzeRolePermissions(roleWith(v.harness, e.permissions)).floor!.meets);
      expect(clearing.length, 'no example meets the unattended floor').toBeGreaterThan(0);
    });
  }
});

describe('native permission mapping', () => {
  it.each([
    ['codex', 'codex', 'auto', 'agent'],
    ['codex', 'codex', 'allow', 'agent-full-access'],
    ['claude-code', 'claude-code', 'auto', 'acceptEdits'],
    ['claude-code', 'claude-code', 'allow', 'bypassPermissions'],
  ] as const)('%s: %s approval=%s maps to native %s',
    (_variantId, harness, approval, nativeMode) => {
      const role = roleWith(harness, {
        approval, filesystem: 'workspace', unattended: 'deny',
      });
      role.session = 'acp';
      expect(getAdapter(harness).effectivePermissionMode!(role)).toMatchObject({
        fleetMode: approval,
        nativeMode,
      });
    });
});
