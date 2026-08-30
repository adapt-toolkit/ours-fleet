/**
 * The pack contract, asserted cheaply.
 *
 * The expensive half — actually packing a dist-less copy of the tree and
 * inspecting the archive — lives in test/integration/pack.spec.ts and runs
 * sequentially under `npm run test:pack`. It shells out to tsc and Vite, which
 * inside a parallel Vitest worker starves the suite's other subprocess tests
 * until they hit their timeouts. What stays here is the wiring: the scripts that
 * must exist, and the release paths that must actually invoke the gate. Those
 * are the parts that rot silently, and they cost a file read to check.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const REPO = resolve('.');
const manifest = () => JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const read = (file: string) => readFileSync(join(REPO, file), 'utf8');

describe('the pack contract is declared, not incidental', () => {
  it('builds on prepack, so packing never depends on a leftover dist', () => {
    expect(manifest().scripts.prepack).toBe('npm run build');
  });

  it('keeps dist in files, so the build output is what ships', () => {
    expect(manifest().files).toContain('dist');
  });

  it('ships the complete split default configuration used by init guidance', () => {
    expect(manifest().files).toContain('examples');
  });

  it('still gates publishing on a build and the test suite', () => {
    // prepack owns the artifact; prepublishOnly owns the decision to release it.
    // Both run on `npm publish`, and the build is idempotent — the stamped build
    // id is derived from content, so running it twice cannot change what ships.
    expect(manifest().scripts.prepublishOnly).toBe('npm run build && npm test');
  });

  it('exposes the pack gate as its own script, outside the parallel suite', () => {
    expect(manifest().scripts['test:pack'])
      .toBe('vitest run --config vitest.integration.config.ts');
  });

  it('keeps package lifecycle tests out of the ordinary parallel suite', () => {
    // vitest.config.ts collects test/**/*.test.ts; the gate is a .spec.ts under
    // test/integration, so `npm test` cannot pick either package build up by accident.
    expect(read('vitest.config.ts')).toContain("include: ['test/**/*.test.ts']");
    expect(read('vitest.integration.config.ts')).toContain('fileParallelism: false');
    expect(existsSync(join(REPO, 'test/integration/pack.spec.ts'))).toBe(true);
    expect(existsSync(join(REPO, 'test/integration/package-install.spec.ts'))).toBe(true);
    expect(existsSync(join(REPO, 'test/package.test.ts'))).toBe(false);
  });
});

/**
 * The nightly publish path, which no pull request can exercise.
 *
 * `nightly-publish` only runs on a push to `prerelease`, so a green PR proves
 * nothing about it and both of its failures were found in production. What
 * broke twice is the same collision: the job injects an ephemeral
 * `X.Y.0-nightly.N` version, and the suite asserts that a released
 * `ours-fleet --version` is a bare X.Y.Z. First the job's own `npm test` ran
 * after the rewrite; then `npm publish` reran the suite again through the root
 * package's `prepublishOnly`. These lock both doors.
 */
describe('the nightly publish path gates the committed version only', () => {
  const steps = () => (parse(read('.github/workflows/publish.yml')) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string; uses?: string }> }>;
  }).jobs['nightly-publish'].steps;
  const indexOf = (match: (step: { name?: string; run?: string }) => boolean) =>
    steps().findIndex(match);
  const rewriteAt = () => indexOf(step => (step.run ?? '').includes('set-nightly-versions.sh'));
  const runsSuite = (step: { run?: string }) => /(^|\s|&&)npm test(\s|$)/.test(step.run ?? '');
  const builds = (step: { run?: string }) => (step.run ?? '').trim() === 'npm run build';

  it('runs the full suite before the version rewrite', () => {
    const suite = indexOf(runsSuite);
    expect(suite).toBeGreaterThanOrEqual(0);
    expect(rewriteAt()).toBeGreaterThan(suite);
  });

  it('never reruns the suite against the injected version', () => {
    expect(steps().slice(rewriteAt() + 1).filter(runsSuite)).toEqual([]);
  });

  it('rebuilds after the rewrite, so the shipped stamp carries the nightly version', () => {
    const publishAt = indexOf(step => (step.run ?? '').includes('publish-nightly.sh'));
    const rebuild = steps().findIndex((step, i) => i > rewriteAt() && builds(step));
    expect(rebuild).toBeGreaterThan(rewriteAt());
    expect(publishAt).toBeGreaterThan(rebuild);
  });

  it('keeps the tag verification last, after every publish', () => {
    const verify = indexOf(step => (step.run ?? '').includes('verify-nightly-tags.sh'));
    const publishes = steps()
      .map((step, i) => ({ i, publish: (step.run ?? '').includes('publish-nightly.sh') }))
      .filter(entry => entry.publish);
    expect(publishes).toHaveLength(3);
    expect(verify).toBeGreaterThan(publishes.at(-1)!.i);
  });

  it('publishes the already-built root artifact without re-entering its lifecycle', () => {
    const script = read('.github/workflows/scripts/publish-nightly.sh');
    // The guard is what makes a stray publish impossible; it must stay ahead of
    // every branch below it.
    expect(script.indexOf('publish-guard.sh nightly'))
      .toBeLessThan(script.indexOf('npm publish'));
    expect(script).toMatch(
      /if \[\[ "\$dir" == "\." \]\]; then\s+npm publish \. --tag nightly --access public --ignore-scripts\s+else\s+npm publish \. --tag nightly --access public\s+fi/);
  });

  it('scopes that skip to the only package with a publish lifecycle', () => {
    // --ignore-scripts is applied to the root alone because the root alone has
    // scripts to skip. If an integration ever gains one, widen the skip rather
    // than let npm rerun a release-only suite against a nightly version.
    expect(manifest().scripts.prepublishOnly).toBe('npm run build && npm test');
    for (const dir of ['integrations/claude-code', 'integrations/codex/ours-fleet']) {
      const scripts = JSON.parse(read(`${dir}/package.json`)).scripts ?? {};
      expect(scripts.prepublishOnly).toBeUndefined();
      expect(scripts.prepack).toBeUndefined();
    }
  });
});

describe('the release paths run the pack gate', () => {
  it('CI gates the root package, not only the two integrations', () => {
    // Before this, publish.yml packed integrations/claude-code and
    // integrations/codex but never the root — the one package whose bin target
    // and build stamp are produced by a build step.
    expect(read('.github/workflows/publish.yml')).toContain('npm run test:pack');
  });

  it('the local publish script runs it too', () => {
    expect(read('publish-local.sh')).toContain('npm run test:pack');
  });
});
