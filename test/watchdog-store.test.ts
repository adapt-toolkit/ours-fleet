import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatRunId, writeReport, listRuns, readReport, latestReport, pruneReports,
  watchdogDir, reportsDir,
} from '../src/watchdog/store.js';
import { errorReport } from '../src/watchdog/report.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-wd-')); process.env.OURS_FLEET_HOME = dir; });
afterEach(() => { delete process.env.OURS_FLEET_HOME; rmSync(dir, { recursive: true, force: true }); });

const rpt = (runId: string) => errorReport({
  watchdog: 'w', run_id: runId, started_at: runId, finished_at: runId, error: 'x',
});

describe('watchdog store', () => {
  it('formats run ids in lexical-chronological UTC form', () => {
    expect(formatRunId(new Date('2026-07-31T11:50:00Z'))).toBe('20260731T115000Z');
  });
  it('writes 0600 files in 0700 dirs and round-trips', () => {
    const p = writeReport('w', rpt('20260731T115000Z'));
    expect((statSync(p).mode & 0o777)).toBe(0o600);
    expect((statSync(watchdogDir('w')).mode & 0o777)).toBe(0o700);
    expect((statSync(reportsDir('w')).mode & 0o777)).toBe(0o700);
    expect(readReport('w', '20260731T115000Z')!.run_id).toBe('20260731T115000Z');
  });
  it('lists newest first and latestReport picks the newest', () => {
    for (const id of ['20260731T115000Z', '20260731T120000Z', '20260731T110000Z'])
      writeReport('w', rpt(id));
    expect(listRuns('w').map(r => r.runId))
      .toEqual(['20260731T120000Z', '20260731T115000Z', '20260731T110000Z']);
    expect(latestReport('w')!.run_id).toBe('20260731T120000Z');
  });
  it('prunes to keep_reports, oldest first (acceptance 8)', () => {
    for (let i = 0; i < 6; i++) writeReport('w', rpt(`20260731T11000${i}Z`));
    expect(pruneReports('w', 4)).toBe(2);
    expect(listRuns('w')).toHaveLength(4);
    expect(listRuns('w').at(-1)!.runId).toBe('20260731T110002Z');
  });
  it('tolerates a corrupt report file in listing (status error, no throw)', () => {
    writeFileSync(join(reportsDir('w'), '20260731T110009Z.json'), '{nope');
    const entry = listRuns('w').find(r => r.runId === '20260731T110009Z')!;
    expect(entry.status).toBe('error');
    expect(readReport('w', '20260731T110009Z')).toBeUndefined();
  });
  it('readReport refuses path traversal in runId', () => {
    expect(readReport('w', '../../../etc/passwd')).toBeUndefined();
  });
});
