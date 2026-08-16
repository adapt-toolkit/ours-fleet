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
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

  it('keeps the integration gate out of the ordinary suite', () => {
    // vitest.config.ts collects test/**/*.test.ts; the gate is a .spec.ts under
    // test/integration, so `npm test` cannot pick it up by accident.
    expect(read('vitest.config.ts')).toContain("include: ['test/**/*.test.ts']");
    expect(read('vitest.integration.config.ts')).toContain('fileParallelism: false');
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
