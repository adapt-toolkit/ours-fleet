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

function run(options: {
  staleCalls?: number; latest?: string; attempts?: number; published?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-nightly-tags-'));
  dirs.push(dir);
  const state = join(dir, 'calls');
  const commands = join(dir, 'commands');
  const repaired = join(dir, 'repaired');
  writeFileSync(state, '0');
  writeFileSync(commands, '');
  const npm = join(dir, 'npm');
  writeFileSync(npm, `#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$FAKE_STATE")"
count=$((count + 1))
printf '%s' "$count" > "$FAKE_STATE"
printf '%s\\n' "$*" >> "$FAKE_COMMANDS"
case "$*" in
  *dist-tags.nightly*)
    if [[ -e "$FAKE_REPAIRED" ]] || (( count > FAKE_STALE_CALLS )); then
      echo "$FAKE_EXPECTED"
    else
      echo "0.10.0-nightly.2"
    fi
    ;;
  *dist-tags.latest*) echo "$FAKE_LATEST" ;;
  *version)
    if [[ "$FAKE_PUBLISHED" == true ]]; then echo "$FAKE_EXPECTED"; else exit 1; fi
    ;;
  dist-tag\\ add*) touch "$FAKE_REPAIRED" ;;
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
      FAKE_COMMANDS: commands,
      FAKE_REPAIRED: repaired,
      FAKE_EXPECTED: '0.10.0-nightly.3',
      FAKE_STALE_CALLS: String(options.staleCalls ?? 0),
      FAKE_LATEST: options.latest ?? '0.9.4',
      FAKE_PUBLISHED: String(options.published ?? false),
      NIGHTLY_VERIFY_ATTEMPTS: String(options.attempts ?? 2),
      NIGHTLY_VERIFY_DELAY_SECONDS: '0',
    },
  });
  return {
    ...result,
    calls: Number(readFileSync(state, 'utf8')),
    commands: readFileSync(commands, 'utf8'),
  };
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
    expect(result.calls).toBe(14);
  });

  it('repairs nightly when the expected published version is visible but its tag is stuck', () => {
    const result = run({ staleCalls: 99, published: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nightly repair requested for 0.10.0-nightly.3');
    expect(result.commands).toContain(
      'dist-tag add @ours.network/fleet@0.10.0-nightly.3 nightly',
    );
    expect(result.commands).not.toContain('dist-tag add @ours.network/fleet@0.10.0-nightly.3 latest');
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
