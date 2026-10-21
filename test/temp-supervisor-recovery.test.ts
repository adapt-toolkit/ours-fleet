import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTempSupervisor } from '../src/temp-supervisor-recovery.js';
import { SupervisorRecycleRequiredError } from '../src/runner.js';
it('replaces the worker PID after recycle without changing the logical agent argument', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-recycle-')),
    entry = join(root, 'worker.cjs'),
    record = join(root, 'attempts');
  writeFileSync(
    entry,
    `const fs=require('node:fs');const p=${JSON.stringify(record)};const first=!fs.existsSync(p);fs.appendFileSync(p,JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');process.exitCode=first?75:0;`,
  );
  try {
    await runTempSupervisor('Temporary', entry, async () => {
      throw new SupervisorRecycleRequiredError();
    });
    const rows = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    expect(rows).toHaveLength(2);
    expect(rows[0].pid).not.toBe(rows[1].pid);
    for (const row of rows) expect(row.args).toEqual(['_run-temp-worker', 'Temporary']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('does not replace a supervisor after an ordinary failure', async () => {
  await expect(
    runTempSupervisor('Temporary', '/unused', async () => {
      throw Error('startup failed');
    }),
  ).rejects.toThrow('startup failed');
});
