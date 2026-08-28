import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createReportArtifact, renderReportHtml, reportAnchor, writeReportArtifact,
  FleetReportService, ReportRegistry,
  type ReportViewModel,
} from '../src/reports/index.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))));

const model = (): ReportViewModel => ({
  schemaVersion: 1, reportKind: 'overview', title: 'Fleet <overview>',
  description: 'Safe & printable', generatedAt: '2026-08-28T10:00:00.000Z',
  source: { name: 'ours-fleet', version: '1.2.3', buildId: 'abc' },
  filters: { state: 'all', list: 'default' },
  observedAt: { tasks: '2026-08-28T09:59:59.000Z' },
  summary: [{ label: 'Tasks', value: 1, target: { section: 'tasks' } }],
  sections: [
    { kind: 'table', id: 'tasks', title: 'Tasks', columns: ['ID', 'Title'], rows: [
      { id: 'same', cells: [{ label: 'ID', value: 'same' }, { label: 'Title', value: '<script>alert(1)</script>', target: { section: 'rooms', id: 'same' } }] },
    ] },
    { kind: 'table', id: 'rooms', title: 'Rooms', columns: ['ID'], rows: [
      { id: 'same', cells: [{ label: 'ID', value: 'same' }] },
    ] },
  ], unavailable: [],
});

describe('deterministic HTML reports', () => {
  it('is byte-stable, escaped, passive, and uses section-qualified internal links', () => {
    const first = renderReportHtml(model());
    const second = renderReportHtml(model());
    expect(first).toBe(second);
    expect(first).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(first).not.toContain('<script');
    expect(first).not.toMatch(/<(?:form|iframe|object)\b/u);
    expect(first).not.toMatch(/(?:src|href)=["']https?:/u);
    expect(first).toContain('Content-Security-Policy');
    expect(first).toContain(`href="#${reportAnchor('item', 'rooms:same')}"`);
    expect(first).toContain(`id="${reportAnchor('item', 'tasks:same')}"`);
    expect(first).toContain(`id="${reportAnchor('item', 'rooms:same')}"`);
  });

  it('hashes malformed and oversized anchors deterministically', () => {
    const raw = `../<bad>${'x'.repeat(300)}`;
    expect(reportAnchor('item', raw)).toMatch(/^item-[a-f0-9]{16}$/u);
    expect(reportAnchor('item', raw)).toBe(reportAnchor('item', raw));
  });

  it('rejects malformed tables, duplicate IDs, and dangling links', () => {
    const wrongCells = model();
    (wrongCells.sections[0] as any).rows[0].cells.pop();
    expect(() => renderReportHtml(wrongCells)).toThrow(/wrong cell count/u);
    const dangling = model();
    dangling.summary = [{ label: 'Bad', value: 1, target: { section: 'missing' } }];
    expect(() => renderReportHtml(dangling)).toThrow(/target does not exist/u);
  });

  it('writes atomically without clobbering by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-report-')); dirs.push(dir);
    const output = join(dir, 'report.html');
    const artifact = createReportArtifact(model());
    await writeFile(output, 'mine');
    await expect(writeReportArtifact(artifact, { output })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output, 'utf8')).toBe('mine');
    const result = await writeReportArtifact(artifact, { output, overwrite: true });
    expect(result.overwritten).toBe(true);
    expect(await readFile(output, 'utf8')).toBe(artifact.html);
  });

  it('discloses card truncation and renders initially open task details', () => {
    const cards = model();
    cards.sections = [{
      kind: 'cards', id: 'release', title: 'Release', truncated: { shown: 1, total: 4 },
      items: [{ id: 'task-1', title: 'task-1 — Review', open: true, values: [{ label: 'Status', value: 'Review' }] }],
    }];
    cards.summary = [];
    const artifact = createReportArtifact(cards);
    expect(artifact.metadata.truncated).toBe(true);
    expect(artifact.metadata.truncation).toEqual([{ section: 'release', shown: 1, total: 4 }]);
    expect(artifact.html).toContain('<details class="task-card tone-neutral" id="item-release:task-1" open>');
  });

  it('rejects authorized providers that exceed caps or hide truncation', async () => {
    const registry = new ReportRegistry().register({
      kind: 'overview', maxRecords: 1,
      validate: (request): request is any => request.kind === 'overview', resourceId: () => undefined,
      present: () => model(),
    });
    const request = { kind: 'overview' as const, viewer: { surface: 'cli' as const, authority: 'local-owner' as const } };
    const provider = (bounds: { shown: number; total: number; truncated: boolean }) => ({
      surface: 'cli' as const,
      collect: async () => ({ data: {}, observedAt: {}, unavailable: [], stale: [], bounds }),
    });
    const service = new FleetReportService(registry);
    await expect(service.create(request, { provider: provider({ shown: 2, total: 2, truncated: false }),
      generatedAt: '2026-08-28T10:00:00.000Z' })).rejects.toThrow(/record cap/u);
    await expect(service.create(request, { provider: provider({ shown: 1, total: 2, truncated: true }),
      generatedAt: '2026-08-28T10:00:00.000Z' })).rejects.toThrow(/did not disclose/u);
  });
});
