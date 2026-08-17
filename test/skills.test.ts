import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AI_DOCS, SPAWN_SKILL_CONTRACT } from '../src/docs.js';
import { UNATTENDED_FLOOR, analyzeRolePermissions } from '../src/permissions.js';
import { oversightTaxonomyLines } from '../src/session/control.js';
import { getAdapter } from '../src/harness/registry.js';
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

/** Line wrapping is a formatting choice; it must not hide or create a match. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

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

describe('shipped spawn skills are written from one source of truth (7.1)', () => {
  for (const v of VARIANTS) {
    it(`${v.id}: states every required fact and none of the corrected ones`, () => {
      const text = flat(skill(v.path, 'spawn-ours-agent'));
      for (const required of SPAWN_SKILL_CONTRACT.required)
        expect(text, `${v.id} is missing: ${required}`).toContain(flat(required));
      for (const forbidden of SPAWN_SKILL_CONTRACT.forbidden)
        expect(text, `${v.id} still contains: ${forbidden}`).not.toContain(flat(forbidden));
    });

    it(`${v.id}: names every capability the doctor floor check enforces`, () => {
      // Derived from the enforced constant, not from a copy of it: adding a
      // capability to the floor makes this fail until the skills say so.
      const text = skill(v.path, 'spawn-ours-agent');
      for (const capability of UNATTENDED_FLOOR)
        expect(text, `${v.id} does not mention ${capability}`).toContain(capability);
    });

    it(`${v.id}: names the native mode neutral 'allow' really maps to`, () => {
      // The value is computed through the adapter, so the skill cannot drift
      // from the translation the CLI performs.
      const native = getAdapter(v.harness).translatePermissions(
        { approval: 'allow', filesystem: 'workspace', unattended: 'deny' });
      const text = skill(v.path, 'spawn-ours-agent');
      for (const value of Object.values(native.native))
        expect(text, `${v.id} does not name ${String(value)}`).toContain(String(value));
    });
  }

  it('the skills and `ours-fleet docs` name the same permission settings', () => {
    // The closed-when condition for 7.1: the skill and the CLI reference must
    // not disagree about what a setting is called or what it grants.
    for (const term of ['bypassPermissions', 'dontAsk', 'unattended floor:', '--isolation-file'])
      expect(AI_DOCS, `AI_DOCS is missing ${term}`).toContain(term);
    for (const capability of UNATTENDED_FLOOR) expect(AI_DOCS).toContain(capability);
  });

  it.each([
    ['codex', 'codex', 'auto', 'agent'],
    ['codex', 'codex', 'allow', 'agent-full-access'],
    ['claude-code', 'claude-code', 'auto', 'acceptEdits'],
    ['claude-code', 'claude-code', 'allow', 'bypassPermissions'],
  ] as const)('%s: %s approval=%s maps to native %s',
    (variantId, harness, approval, nativeMode) => {
      const variant = VARIANTS.find(candidate => candidate.id === variantId)!;
      const role = roleWith(harness, {
        approval, filesystem: 'workspace', unattended: 'deny',
      });
      role.session = harness === 'codex' ? 'acp' : 'tmux';
      expect(getAdapter(harness).effectivePermissionMode!(role)).toMatchObject({
        fleetMode: approval,
        nativeMode,
      });
      expect(skill(variant.path, 'spawn-ours-agent')).toContain(nativeMode);
      expect(AI_DOCS).toContain(nativeMode);
    });
});

describe('following only the shipped skill produces a role doctor accepts (7.1)', () => {
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

/**
 * The oversight half (7.2). An overseer reads its generated briefing OR this
 * skill; if they disagree about what a `peek` failure proves, one of them is
 * telling it to restart a working agent.
 */
describe('shipped oversee skills use the one result taxonomy (7.2)', () => {
  for (const v of VARIANTS) {
    const text = skill(v.path, 'oversee-agents');

    it(`${v.id}: carries the taxonomy verbatim, not a paraphrase`, () => {
      for (const line of oversightTaxonomyLines())
        expect(text, `${v.id} is missing or has reworded: ${line.slice(0, 60)}…`).toContain(line);
    });

    it(`${v.id}: says one console command is not a liveness verdict`, () => {
      expect(text).toContain('One console command is not a liveness verdict');
      expect(text).toContain('ours-fleet status <Name>');
      expect(text).toContain('ours-fleet peek <Name>');
    });

    it(`${v.id}: restarts only on a confirmed stop`, () => {
      // The wording differs per variant; what must hold is that the restart
      // instruction is tied to `status` confirming the role is offline, and
      // that the old "crashed → restart" shortcut is gone.
      expect(text).toMatch(/only once `status` confirms it is offline/);
      expect(text).not.toContain('for permanent roles `ours-fleet restart');
      expect(text).not.toContain('then restart permanent\nroles');
    });
  }

  it('both variants and the generated briefing agree line for line', () => {
    // The same array, in the same order, in all three places.
    const lines = oversightTaxonomyLines();
    for (const v of VARIANTS) {
      const text = skill(v.path, 'oversee-agents');
      const positions = lines.map(l => text.indexOf(l));
      expect(positions.every(p => p >= 0), v.id).toBe(true);
      expect(positions, `${v.id} lists the taxonomy out of order`)
        .toEqual([...positions].sort((a, b) => a - b));
    }
  });
});
