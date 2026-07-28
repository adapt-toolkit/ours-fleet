import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('.github/workflows/scripts/verify-nightly-tags.sh');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(options: { staleCalls?: number; latest?: string; attempts?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-nightly-tags-'));
  dirs.push(dir);
  const state = join(dir, 'calls');
  writeFileSync(state, '0');
  const npm = join(dir, 'npm');
  writeFileSync(npm, `#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$FAKE_STATE")"
count=$((count + 1))
printf '%s' "$count" > "$FAKE_STATE"
case "$*" in
  *dist-tags.nightly*)
    if (( count <= FAKE_STALE_CALLS )); then echo "0.10.0-nightly.2"; else echo "$FAKE_EXPECTED"; fi
    ;;
  *dist-tags.latest*) echo "$FAKE_LATEST" ;;
  *) exit 2 ;;
esac
`);
  chmodSync(npm, 0o755);
  const result = spawnSync('bash', [script, '0.10.0-nightly.3'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_STATE: state,
      FAKE_EXPECTED: '0.10.0-nightly.3',
      FAKE_STALE_CALLS: String(options.staleCalls ?? 0),
      FAKE_LATEST: options.latest ?? '0.9.4',
      NIGHTLY_VERIFY_ATTEMPTS: String(options.attempts ?? 2),
      NIGHTLY_VERIFY_DELAY_SECONDS: '0',
    },
  });
  return { ...result, calls: Number(readFileSync(state, 'utf8')) };
}

describe('nightly dist-tag verification', () => {
  it('passes when all tags are visible', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified npm tags after attempt 1/2');
  });

  it('retries registry propagation instead of leaving a published nightly red', () => {
    const result = run({ staleCalls: 6 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('have not propagated yet (attempt 1/2)');
    expect(result.stdout).toContain('verified npm tags after attempt 2/2');
    expect(result.calls).toBe(12);
  });

  it('still fails after the bounded propagation window', () => {
    const result = run({ staleCalls: 99 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not converge');
    expect(result.stderr).toContain('nightly=0.10.0-nightly.2');
  });

  it('fails immediately if latest points to a prerelease', () => {
    const result = run({ latest: '0.10.0-nightly.3' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('latest unexpectedly points');
    expect(result.calls).toBe(2);
  });
});
