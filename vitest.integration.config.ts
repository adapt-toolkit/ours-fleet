import { defineConfig } from 'vitest/config';

/**
 * Integration gates: `npm run test:pack`.
 *
 * These shell out to real toolchains — the pack gate runs tsc and Vite over a
 * copy of the tree. Inside the ordinary parallel suite that starves every other
 * test that spawns a subprocess until it hits its timeout, so these run in their
 * own invocation, one file at a time, and are collected by a pattern
 * (`test/integration/**\/*.spec.ts`) that vitest.config.ts does not match.
 *
 * No globalSetup: the gate builds its own copy and must not depend on this
 * checkout's dist/ existing.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.spec.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
