import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(repo, 'test', 'fixtures', 'public-api');
const fixture = join(fixtureDir, 'legacy-session-handle.ts');
const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');

function typecheckFixture(): { ok: boolean; output: string } {
  try {
    execFileSync(process.execPath, [tsc, '-p', join(fixtureDir, 'tsconfig.json')],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output: '' };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const original = readFileSync(fixture, 'utf8');
afterEach(() => { writeFileSync(fixture, original); });

/**
 * `npm run typecheck` only covers `src` and `web`, so nothing here is checked by
 * the ordinary gates — this test compiles the fixture the way a consumer of the
 * published package would compile it.
 */
describe('public SessionHandle.interrupt contract', () => {
  it('accepts both the legacy void implementation and the current outcome one', () => {
    const result = typecheckFixture();
    expect(result.output).toBe('');
    expect(result.ok).toBe(true);
  }, 120_000);

  it('still rejects an implementation that resolves something else entirely', () => {
    writeFileSync(fixture, original.replace(
      'async interrupt(): Promise<void> {}', 'async interrupt(): Promise<number> { return 1; }'));
    const result = typecheckFixture();
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Type 'number' is not assignable to type 'InterruptResult'");
  }, 120_000);
});
