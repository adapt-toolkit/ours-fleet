import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realExec } from '../src/exec.js';
import { harnessRuntimeDir, resolveIsolation } from '../src/isolation/policy.js';
import { makeBubblewrapBackend } from '../src/isolation/bubblewrap.js';
import type { WrapContext } from '../src/isolation/types.js';

/**
 * 5.1 verified against a REAL sandbox, not a mount vector.
 *
 * A mount-vector test proves we asked for the right thing. These prove the
 * kernel agreed: writes to the shared credential and instruction files fail
 * from inside the sandbox, while the role's own runtime state is writable and a
 * minimal session completes normally.
 */
/**
 * Whether this host can actually sandbox. A machine without working user
 * namespaces is legitimate, so a missing sandbox is not a test failure — but it
 * must never be SILENT. A suite that reports green while the tests carrying the
 * security property never ran is the same defect this release exists to fix:
 * absence of a signal read as absence of a problem.
 */
let sandbox: { ok: boolean; detail: string };

beforeAll(async () => {
  sandbox = await makeBubblewrapBackend(realExec).available();
  if (sandbox.ok) {
    console.log(
      `\n[5.1] sandbox tests RUNNING against real bubblewrap — ${sandbox.detail}\n`);
    return;
  }
  const bar = '!'.repeat(78);
  console.warn(
    `\n${bar}\n`
    + '[5.1] SANDBOX TESTS DID NOT RUN. The credential/configuration boundary is\n'
    + '      UNVERIFIED on this host. A green suite here does NOT mean the sandbox\n'
    + `      boundary was checked.\n      reason: ${sandbox.detail}\n`
    + '      Release sign-off requires these tests to have RUN, not merely passed,\n'
    + '      with the host bwrap version recorded.\n'
    + `${bar}\n`);
});

/** Skip loudly: vitest reports these as SKIPPED, never as passed. */
const requireSandbox = (ctx: { skip(): void }) => { if (!sandbox.ok) ctx.skip(); };

let home: string;
let stateDir: string;
let runCwd: string;
let claudeHome: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ours-fleet-cred-')));
  stateDir = join(home, '.ours-fleet', 'agents', 'Dev');
  runCwd = join(home, 'work');
  claudeHome = join(home, '.claude');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(runCwd, { recursive: true });
  mkdirSync(join(claudeHome, 'plugins'), { recursive: true });
  mkdirSync(harnessRuntimeDir(stateDir, 'claude-code'), { recursive: true });
  // Shared, fleet-wide: credentials, global instructions, shared settings.
  writeFileSync(join(home, '.claude.json'), '{"credentials":"SHARED"}\n');
  writeFileSync(join(claudeHome, 'CLAUDE.md'), 'GLOBAL INSTRUCTIONS\n');
  writeFileSync(join(claudeHome, 'settings.json'), '{"shared":true}\n');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ctx = (): WrapContext => ({
  stateDir, runCwd, home, harness: 'claude-code',
  harnessHome: claudeHome,
  harnessRuntimeDir: harnessRuntimeDir(stateDir, 'claude-code'),
  harnessSharedPaths: [
    join(home, '.claude.json'),
    join(claudeHome, 'CLAUDE.md'),
    join(claudeHome, 'settings.json'),
    join(claudeHome, 'plugins'),
  ],
});

/** Run a shell command inside the sandbox this policy produces. */
async function inSandbox(script: string) {
  const c = ctx();
  const policy = resolveIsolation({}, c);
  const argv = makeBubblewrapBackend().wrap(['sh', '-c', script], policy, c);
  return realExec(argv[0], argv.slice(1));
}

describe('shared harness credentials are read-only inside a real sandbox (5.1)', () => {
  it('refuses a write to the shared credential file', async ctx => {
    requireSandbox(ctx);
    const r = await inSandbox(`echo STOLEN > ${JSON.stringify(join(home, '.claude.json'))}`);
    expect(r.code).not.toBe(0);
    expect(`${r.stderr}`.toLowerCase()).toMatch(/read-only|permission denied/);
    // …and the file on the host is untouched.
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toContain('SHARED');
  });

  it('refuses a write to the shared global instructions', async ctx => {
    requireSandbox(ctx);
    const r = await inSandbox(`echo OVERRIDDEN > ${JSON.stringify(join(claudeHome, 'CLAUDE.md'))}`);
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8')).toBe('GLOBAL INSTRUCTIONS\n');
  });

  it('refuses a write to the shared settings', async ctx => {
    requireSandbox(ctx);
    const r = await inSandbox(`echo BAD > ${JSON.stringify(join(claudeHome, 'settings.json'))}`);
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(claudeHome, 'settings.json'), 'utf8')).toContain('"shared":true');
  });

  it('still lets the agent READ the shared credentials and instructions', async ctx => {
    requireSandbox(ctx);
    const r = await inSandbox(
      `cat ${JSON.stringify(join(home, '.claude.json'))} ${JSON.stringify(join(claudeHome, 'CLAUDE.md'))}`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('SHARED');
    expect(r.stdout).toContain('GLOBAL INSTRUCTIONS');
  });

  it('completes a normal minimal session using its own per-role state', async ctx => {
    requireSandbox(ctx);
    // The harness home is writable — sessions, history, caches all land in the
    // per-role directory — and the work is done in the role's own cwd.
    const r = await inSandbox(
      `set -e; `
      + `echo session > ${JSON.stringify(join(claudeHome, 'history.jsonl'))}; `
      + `mkdir -p ${JSON.stringify(join(claudeHome, 'projects', 'x'))}; `
      + `echo work > ${JSON.stringify(join(runCwd, 'output.txt'))}; `
      + `echo log >> ${JSON.stringify(join(stateDir, 'WORKLOG.md'))}; `
      + `echo DONE`);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DONE');

    // Runtime state landed in the ROLE's directory, not in the shared home.
    const runtime = harnessRuntimeDir(stateDir, 'claude-code');
    expect(readFileSync(join(runtime, 'history.jsonl'), 'utf8')).toBe('session\n');
    expect(readFileSync(join(runCwd, 'output.txt'), 'utf8')).toBe('work\n');
    // The shared home on the host never saw it.
    expect(() => readFileSync(join(claudeHome, 'history.jsonl'), 'utf8')).toThrow();
  });

  it("one role's runtime state is invisible to another role", async ctx => {
    requireSandbox(ctx);
    const sibling = join(home, '.ours-fleet', 'agents', 'Other');
    mkdirSync(join(sibling, 'harness', 'claude-code'), { recursive: true });
    writeFileSync(join(sibling, 'secret.txt'), 'PEER STATE\n');
    const r = await inSandbox(`cat ${JSON.stringify(join(sibling, 'secret.txt'))}`);
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain('PEER STATE');
  });
});
