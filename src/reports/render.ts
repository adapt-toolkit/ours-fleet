import { createHash } from 'node:crypto';
import type {
  ReportArtifact, ReportSection, ReportTone, ReportValue, ReportViewModel,
} from './types.js';

const MEDIA_TYPE = 'text/html; charset=utf-8' as const;
const SAFE_FRAGMENT = /^[a-z0-9](?:[a-z0-9_.:-]{0,95})$/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export const escapeReportHtml = (value: unknown): string => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function reportAnchor(prefix: string, raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (SAFE_FRAGMENT.test(normalized) && `${prefix}-${normalized}`.length <= 110) return `${prefix}-${normalized}`;
  return `${prefix}-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

function reportTime(raw: string): { text: string; datetime?: string } {
  if (!RFC3339_UTC.test(raw) || Number.isNaN(Date.parse(raw))) return { text: `${raw} (unverified time)` };
  return { text: raw, datetime: raw };
}

function validateModel(model: ReportViewModel): void {
  const sectionIds = new Set<string>();
  const targets = new Set<string>();
  for (const section of model.sections) {
    const id = reportAnchor('section', section.id);
    if (sectionIds.has(id)) throw new Error(`duplicate report section anchor: ${id}`);
    sectionIds.add(id);
    targets.add(id);
    if (section.kind === 'task-navigator') {
      const panelIds = new Set<string>();
      const taskIds = new Set<string>();
      for (const panel of section.panels) {
        const panelId = reportAnchor('list', panel.id);
        if (panelIds.has(panelId)) throw new Error(`duplicate task list anchor: ${panelId}`);
        panelIds.add(panelId); targets.add(panelId);
        for (const task of panel.tasks) {
          const taskId = itemAnchor(section.id, task.id);
          if (taskIds.has(taskId)) throw new Error(`duplicate task anchor: ${taskId}`);
          taskIds.add(taskId); targets.add(taskId);
        }
      }
      if (!panelIds.has(reportAnchor('list', section.defaultList))) throw new Error('default task list is not included');
      continue;
    }
    if (section.kind === 'list-board' || section.kind === 'inbox') continue;
    if (section.kind === 'cards' || section.kind === 'records') {
      const itemIds = new Set<string>();
      for (const item of section.items) {
        const itemId = itemAnchor(section.id, item.id);
        if (itemIds.has(itemId)) throw new Error(`duplicate report card anchor: ${itemId}`);
        itemIds.add(itemId); targets.add(itemId);
      }
      continue;
    }
    if (section.kind !== 'table') continue;
    const rowIds = new Set<string>();
    for (const row of section.rows) {
      if (row.cells.length !== section.columns.length) throw new Error(`report table ${section.id} has a row with the wrong cell count`);
      if (!row.id) continue;
      const rowId = itemAnchor(section.id, row.id);
      if (rowIds.has(rowId)) throw new Error(`duplicate report row anchor: ${rowId}`);
      rowIds.add(rowId);
      targets.add(rowId);
    }
  }
  const linkedValues: ReportValue[] = [...(model.summary ?? [])];
  for (const section of model.sections) {
    const values = section.kind === 'table' ? section.rows.flatMap(row => row.cells)
      : section.kind === 'details' ? section.values
        : section.kind === 'cards' ? section.items.flatMap(item => item.values)
          : section.kind === 'records' ? section.items.flatMap(item => item.groups.flatMap(group => group.values))
            : section.kind === 'list-board' ? section.items.flatMap(item => item.recent)
              : section.kind === 'inbox' ? [...section.attention, ...section.active].flatMap(item => item.groups.flatMap(group => group.values))
                : section.kind === 'task-navigator' ? section.panels.flatMap(panel => panel.tasks.flatMap(item => item.groups.flatMap(group => group.values))) : [];
    linkedValues.push(...values);
    if (section.kind === 'list-board') linkedValues.push(...section.items.map(item => ({ label: 'List', value: item.name, target: item.taskTarget })));
  }
  for (const value of linkedValues) if (value.target) {
      const target = value.target.id ? itemAnchor(value.target.section, value.target.id)
        : reportAnchor('section', value.target.section);
      if (!targets.has(target)) throw new Error(`report link target does not exist: ${target}`);
  }
}

function tone(value: ReportTone | undefined): ReportTone {
  return value && ['neutral', 'good', 'warning', 'bad', 'unknown'].includes(value)
    ? value : 'neutral';
}

function itemAnchor(sectionId: string, rowId: string): string {
  return reportAnchor('item', `${sectionId}:${rowId}`);
}

function valueHtml(item: ReportValue): string {
  const rendered = item.value === null ? '<span class="unknown">Unknown</span>'
    : escapeReportHtml(item.value);
  const linked = item.target
    ? `<a href="#${item.target.id ? itemAnchor(item.target.section, item.target.id) : reportAnchor('section', item.target.section)}">${rendered}</a>`
    : rendered;
  return `<span class="value tone-${tone(item.tone)}${item.multiline ? ' multiline' : ''}">${linked}</span>`;
}

function sectionHtml(section: ReportSection): string {
  const id = reportAnchor('section', section.id);
  const heading = `<h2 id="${id}">${escapeReportHtml(section.title)}</h2>`;
  if (section.kind === 'notice') {
    return `<section class="notice tone-${tone(section.tone)}" aria-labelledby="${id}">${heading}<p>${escapeReportHtml(section.text)}</p></section>`;
  }
  const description = section.description ? `<p>${escapeReportHtml(section.description)}</p>` : '';
  if (section.kind === 'details') {
    const entries = section.values.map(item => `<div><dt>${escapeReportHtml(item.label)}</dt><dd>${valueHtml(item)}</dd></div>`).join('');
    const paragraphs = (section.paragraphs ?? []).map(p => `<p class="prose">${escapeReportHtml(p)}</p>`).join('');
    return `<section aria-labelledby="${id}">${heading}${description}<dl class="details">${entries}</dl>${paragraphs}</section>`;
  }
  if (section.kind === 'cards') {
    const cards = section.items.map(item => {
      const entries = item.values.map(value => `<div><dt>${escapeReportHtml(value.label)}</dt><dd>${valueHtml(value)}</dd></div>`).join('');
      const paragraphs = (item.paragraphs ?? []).map(p => `<p class="prose">${escapeReportHtml(p)}</p>`).join('');
      return `<details class="task-card tone-${tone(item.tone)}" id="${itemAnchor(section.id, item.id)}"${item.open ? ' open' : ''}><summary><strong>${escapeReportHtml(item.title)}</strong>${item.subtitle ? `<span>${escapeReportHtml(item.subtitle)}</span>` : ''}</summary><div class="task-body"><dl class="details">${entries}</dl>${paragraphs}</div></details>`;
    }).join('');
    const emptyCards = section.items.length ? '' : `<p class="empty">${escapeReportHtml(section.empty ?? 'No records.')}</p>`;
    const cardTruncation = section.truncated ? `<p class="truncation" role="status">Showing ${section.truncated.shown} of ${section.truncated.total} records. Output was truncated.</p>` : '';
    return `<section aria-labelledby="${id}">${heading}${description}${emptyCards}<div class="card-list">${cards}</div>${cardTruncation}</section>`;
  }
  if (section.kind === 'records') {
    const records = section.items.map(item => {
      const groups = item.groups.map(group => `<section class="record-group"><h4>${escapeReportHtml(group.title)}</h4><div class="table-wrap"><table style="--columns:2" class="field-table"><tbody>${group.values.map(value => `<tr><th scope="row">${escapeReportHtml(value.label)}</th><td>${valueHtml(value)}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
      return `<details class="record tone-${tone(item.tone)}" id="${itemAnchor(section.id, item.id)}"${item.open ? ' open' : ''}><summary><strong>${escapeReportHtml(item.title)}</strong><span>${escapeReportHtml(item.subtitle)}</span></summary><div class="record-body">${groups}</div></details>`;
    }).join('');
    const emptyRecords = section.items.length ? '' : `<p class="empty">${escapeReportHtml(section.empty ?? 'No records.')}</p>`;
    const recordTruncation = section.truncated ? `<p class="truncation" role="status">Showing ${section.truncated.shown} of ${section.truncated.total} records. Output was truncated.</p>` : '';
    return `<section aria-labelledby="${id}">${heading}${description}${emptyRecords}<div class="record-list">${records}</div>${recordTruncation}</section>`;
  }
  if (section.kind === 'list-board') {
    const lists = section.items.map(item => {
      const recent = item.recent.length ? `<ol class="recent-tasks">${item.recent.map(task => `<li>${valueHtml(task)}</li>`).join('')}</ol>` : '<p class="empty">No tasks in this list.</p>';
      const clipped = item.recentTotal > item.recent.length ? `<p class="list-truncation">${item.recent.length} most recently updated of ${item.recentTotal}; updated-descending, then ID ascending.</p>` : item.recent.length ? '<p class="list-truncation">All tasks; updated-descending, then ID ascending.</p>' : '';
      const created = item.createdAt ? `<time datetime="${escapeReportHtml(item.createdAt)}">${escapeReportHtml(item.createdAt)}</time>` : '<span class="unknown">Unknown / not supplied</span>';
      return `<article class="list-unit" id="${itemAnchor(section.id, item.id)}"><header><p class="list-type">${item.builtIn ? 'Built-in list' : 'Custom list'}</p><h3>${escapeReportHtml(item.name)}</h3><p>Created: ${created}</p></header><ul class="list-signals" aria-label="Task counts"><li><strong>${item.counts.total}</strong><span>Total</span></li><li><strong>${item.counts.active}</strong><span>Active</span></li><li class="${item.counts.blocked ? 'has-warning' : ''}"><strong>${item.counts.blocked}</strong><span>Blocked</span></li><li><strong>${item.counts.terminal}</strong><span>Terminal</span></li></ul><div class="list-recent"><h4>Task index</h4>${recent}${clipped}</div><p class="list-entry"><a href="#${reportAnchor('section', item.taskTarget.section)}">Go to ${escapeReportHtml(item.name)} tasks ↓</a></p></article>`;
    }).join('');
    const listTruncation = section.truncated ? `<p class="truncation" role="status">Showing ${section.truncated.shown} of ${section.truncated.total} lists. Output was truncated.</p>` : '';
    return `<section aria-labelledby="${id}">${heading}${section.description ? `<p>${escapeReportHtml(section.description)}</p>` : ''}<div class="list-board">${lists}</div>${listTruncation}</section>`;
  }
  if (section.kind === 'inbox') {
    const listNav = section.lists.map(list => `<li${list.selected ? ' class="selected" aria-current="page"' : ''}><span class="list-name">${escapeReportHtml(list.name)}</span><span class="list-count">${list.count}</span>${list.blocked ? `<span class="blocked-count">${list.blocked} blocked</span>` : ''}</li>`).join('');
    const taskRows = (items: Array<{ id:string; title:string; brief:string; status:string; blocker?:string; updated:string; groups:Array<{title:string;values:ReportValue[]}> }>, toneName: ReportTone) => items.map(item => {
      const groups = item.groups.map(group => `<section class="record-group"><h4>${escapeReportHtml(group.title)}</h4><div class="table-wrap"><table style="--columns:2" class="field-table"><tbody>${group.values.map(value => `<tr><th scope="row">${escapeReportHtml(value.label)}</th><td>${valueHtml(value)}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
      return `<details class="inbox-task tone-${tone(toneName)}" id="${itemAnchor(section.id,item.id)}"${toneName === 'warning' ? ' open' : ''}><summary><span class="inbox-title">${escapeReportHtml(item.title)}</span><span class="inbox-brief">${escapeReportHtml(item.brief)}</span><span class="inbox-meta"><strong>${escapeReportHtml(item.status)}</strong>${item.blocker ? ` · ${escapeReportHtml(item.blocker)}` : ''} · Updated ${escapeReportHtml(item.updated)}</span></summary><div class="inbox-detail">${groups}</div></details>`;
    }).join('');
    const attention = section.attention.length ? taskRows(section.attention,'warning') : '<p class="clear-state">Nothing is blocked or waiting for review.</p>';
    const active = section.active.length ? taskRows(section.active,'good') : '<p class="empty">No active tasks in this list.</p>';
    const terminal = section.terminal.length ? `<details class="terminal-group"><summary>Recently finished (${section.terminal.length})</summary><ul>${section.terminal.map(item => `<li><strong>${escapeReportHtml(item.title)}</strong><span>${escapeReportHtml(item.status)} · ${escapeReportHtml(item.outcome)} · Updated ${escapeReportHtml(item.updated)}</span></li>`).join('')}</ul></details>` : '';
    return `<section class="inbox-shell" aria-labelledby="${id}"><aside class="inbox-sidebar" aria-label="Task lists"><h2>Lists</h2><ul>${listNav}</ul><p>Lists shown for orientation. This file contains <strong>${escapeReportHtml(section.selected.name)}</strong>.</p></aside><div class="inbox-main"><header><p class="eyebrow">Selected list</p><h2 id="${id}">${escapeReportHtml(section.selected.name)}</h2><p>${escapeReportHtml(section.description)}</p><p class="selection-count">${section.selected.shown} shown of ${section.selected.total} tasks</p></header><section class="attention"><h3>Needs attention</h3>${attention}</section><section><h3>Active work</h3>${active}</section>${terminal}</div></section>`;
  }
  if (section.kind === 'task-navigator') {
    const panelAnchor = (raw: string) => reportAnchor('list', raw);
    const links = section.lists.map(list => `<li><a href="#${panelAnchor(list.id)}"><span>${escapeReportHtml(list.name)}${list.id === section.defaultList ? ' <small>Starts here</small>' : ''}</span><strong>${list.count}</strong>${list.blocked ? `<small>${list.blocked} blocked</small>` : ''}</a></li>`).join('');
    const taskRows = (items: Array<{ id:string; title:string; brief:string; status:string; blocked?:string; updated:string; groups:Array<{title:string;values:ReportValue[]}> }>) => items.map(item => {
      const groups = item.groups.map(group => `<section class="record-group"><h4>${escapeReportHtml(group.title)}</h4><div class="table-wrap"><table style="--columns:2" class="field-table"><tbody>${group.values.map(value => `<tr><th scope="row">${escapeReportHtml(value.label)}</th><td>${valueHtml(value)}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
      return `<tr class="task-summary" id="${itemAnchor(section.id,item.id)}" data-task-id="${escapeReportHtml(item.id)}" data-task-title="${escapeReportHtml(item.title)}" data-task-brief="${escapeReportHtml(item.brief)}" data-task-status="${escapeReportHtml(item.status)}"><th scope="row">${escapeReportHtml(item.title)}</th><td>${escapeReportHtml(item.brief)}</td><td><strong class="status-label">${escapeReportHtml(item.status)}</strong>${item.blocked ? '<span class="blocked-indicator">Blocked</span>' : ''}</td></tr><tr class="task-detail-row"><td colspan="3"><details class="task-table-details"><summary>View full details for ${escapeReportHtml(item.title)}</summary><div class="inbox-detail">${item.blocked ? `<p class="blocked-reason"><strong>Blocked:</strong> ${escapeReportHtml(item.blocked)}</p>` : ''}${groups}</div></details></td></tr>`;
    }).join('');
    const panels = section.panels.map(panel => `<section class="list-panel${panel.id === section.defaultList ? ' default-panel' : ''}" id="${panelAnchor(panel.id)}" tabindex="-1"><header><p class="eyebrow">Task list</p><h2>${escapeReportHtml(panel.name)}</h2><p>${escapeReportHtml(panel.description)}</p><p class="selection-count">${panel.shown} shown of ${panel.total} tasks</p></header>${panel.tasks.length ? `<div class="table-wrap task-index"><table style="--columns:3"><thead><tr><th scope="col">Name</th><th scope="col">Brief description</th><th scope="col">Status</th></tr></thead><tbody>${taskRows(panel.tasks)}</tbody></table></div>` : '<p class="empty">No tasks in this list.</p>'}</section>`).join('');
    const selectors = section.lists.map(list => `.navigator-shell:has(#${panelAnchor(list.id)}:target) a[href="#${panelAnchor(list.id)}"]`).join(',');
    return `<section class="navigator" aria-labelledby="${id}"><style>@supports selector(body:has(*)){.navigator:not(:has(.list-panel:target)) .navigator-sidebar a[href="#${panelAnchor(section.defaultList)}"],${selectors}{background:var(--fg);color:var(--bg)}@media(max-width:44rem){.navigator-panels .list-panel{display:none}.navigator:not(:has(.list-panel:target)) .default-panel,.navigator-panels .list-panel:target{display:block}}}</style><header class="navigator-hero"><p class="eyebrow">Fleet tasks</p><h1 id="${id}">${escapeReportHtml(section.title)}</h1><p>${escapeReportHtml(section.description)}</p></header><div class="navigator-shell"><aside class="navigator-sidebar" aria-label="Included task lists"><h2>Jump to list</h2><ul>${links}</ul><p class="bounded-note">Only the bounded lists included in this file are available.</p></aside><div class="navigator-panels">${panels}</div></div></section>`;
  }
  const head = section.columns.map(column => `<th scope="col">${escapeReportHtml(column)}</th>`).join('');
  const rows = section.rows.map(row => {
    const rowId = row.id ? ` id="${itemAnchor(section.id, row.id)}"` : '';
    return `<tr${rowId}>${row.cells.map((cell, index) => `${index === 0 ? '<th scope="row">' : '<td>'}${valueHtml(cell)}${index === 0 ? '</th>' : '</td>'}`).join('')}</tr>`;
  }).join('');
  const empty = section.rows.length ? '' : `<p class="empty">${escapeReportHtml(section.empty ?? 'No records.')}</p>`;
  const truncation = section.truncated
    ? `<p class="truncation" role="status">Showing ${section.truncated.shown} of ${section.truncated.total} records. Output was truncated.</p>` : '';
  return `<section aria-labelledby="${id}">${heading}${description}${empty}${section.rows.length ? `<div class="table-wrap"><table style="--columns:${section.columns.length}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>` : ''}${truncation}</section>`;
}

export function reportCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalEntries(values: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(values ?? {}).sort(([a], [b]) => reportCompare(a, b));
}

export function renderReportHtml(model: ReportViewModel): string {
  validateModel(model);
  const isFocusedInbox = model.sections.length === 1 && (model.sections[0]?.kind === 'inbox' || model.sections[0]?.kind === 'task-navigator');
  const nav = model.sections.map(section => `<li><a href="#${reportAnchor('section', section.id)}">${escapeReportHtml(section.title)}</a></li>`).join('');
  const summary = model.summary?.length
    ? `<dl class="summary">${model.summary.map(item => `<div><dt>${escapeReportHtml(item.label)}</dt><dd>${valueHtml(item)}</dd></div>`).join('')}</dl>` : '';
  const filters = canonicalEntries(model.filters).map(([key, value]) => `<li><strong>${escapeReportHtml(key)}:</strong> ${escapeReportHtml(value)}</li>`).join('');
  const observations = canonicalEntries(model.observedAt).map(([key, value]) => {
    const time = reportTime(value);
    return `<li><strong>${escapeReportHtml(key)}:</strong> ${time.datetime ? `<time datetime="${time.datetime}">${time.text}</time>` : escapeReportHtml(time.text)}</li>`;
  }).join('');
  const unavailable = [...(model.unavailable ?? [])].sort(reportCompare);
  const unavailableHtml = unavailable.length ? `<aside class="notice tone-warning"><h2>Unavailable data</h2><ul>${unavailable.map(x => `<li>${escapeReportHtml(x)}</li>`).join('')}</ul></aside>` : '';
  const reportMetadata = isFocusedInbox
    ? `<details class="report-metadata"><summary>Report details</summary><div>${filters ? `<h2>Filters</h2><ul>${filters}</ul>` : ''}${observations ? `<h2>Source observation times</h2><ul>${observations}</ul>` : ''}</div></details>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="generator" content="${escapeReportHtml(`${model.source.name} ${model.source.version}`)}"><title>${escapeReportHtml(model.title)}</title>
<style>:root{color-scheme:light dark;--bg:#fff;--fg:#17202a;--muted:#5d6873;--line:#c8d0d8;--panel:#f5f7f9;--link:#075ea8;--good:#176b3a;--warn:#805b00;--bad:#a32020;--attention-bg:#fff4d6;--attention-fg:#352300;--attention-border:#8a5700;--attention-card-bg:#ffffff;--attention-card-fg:#17202a;--attention-accent:#684000}@media(prefers-color-scheme:dark){:root{--bg:#11161b;--fg:#edf2f7;--muted:#acb7c2;--line:#46515c;--panel:#1b232b;--link:#73bffc;--good:#70d69a;--warn:#ffd166;--bad:#ff8585;--attention-bg:#2a210d;--attention-fg:#fff2c2;--attention-border:#e0ad3e;--attention-card-bg:#171c22;--attention-card-fg:#f4f7fa;--attention-accent:#ffd166}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}header,main,footer{max-width:76rem;margin:auto;padding:1rem 1.25rem}header{border-bottom:1px solid var(--line)}h1{font-size:clamp(1.7rem,4vw,2.5rem);margin:.2rem 0}h2{margin-top:2rem}a{color:var(--link);text-underline-offset:.15em}a:focus,summary:focus{outline:3px solid currentColor;outline-offset:3px}.meta,.empty{color:var(--muted)}nav ul{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;list-style:none;padding-left:0}.summary,.details{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.75rem}.summary div,.details div,.notice{padding:.8rem;border:1px solid var(--line);border-radius:.4rem;background:var(--panel)}dt{font-size:.85rem;color:var(--muted)}dd{margin:.15rem 0 0;font-weight:650;overflow-wrap:anywhere}.card-list{display:grid;gap:.75rem}.task-card{color:var(--fg);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:.45rem;background:var(--panel)}.task-card.tone-good{color:var(--fg);border-left-color:var(--good)}.task-card.tone-warning{color:var(--fg);border-left-color:var(--warn)}.task-card.tone-bad{color:var(--fg);border-left-color:var(--bad)}.task-card summary{cursor:pointer;padding:.9rem 1rem;color:var(--fg)}.task-card summary strong,.task-card summary span{display:block}.task-card summary span{color:var(--muted);font-size:.9rem;margin-top:.15rem}.task-body{padding:0 1rem 1rem}.navigator-hero{max-width:76rem;margin:1rem auto;border:0;border-radius:1rem;padding:clamp(1.25rem,4vw,2.5rem);color:#fff;background:linear-gradient(135deg,#18356f 0%,#4a3aa8 100%);box-shadow:0 .8rem 2rem rgba(29,36,88,.18)}.navigator-hero h1{font-size:clamp(2rem,5vw,3.5rem);line-height:1.05;margin:.1rem 0}.navigator-hero .eyebrow,.navigator-hero p{color:#fff}.navigator-shell{display:grid;grid-template-columns:15rem minmax(0,1fr);gap:1.5rem;align-items:start}.navigator-panels{min-width:0}.navigator-sidebar{position:sticky;top:1rem;border:1px solid var(--line);border-radius:.6rem;background:var(--panel);padding:1rem}.navigator-sidebar h2{margin-top:0}.navigator-sidebar ul{list-style:none;padding:0;margin:0}.navigator-sidebar a{display:grid;grid-template-columns:1fr auto;gap:.15rem .5rem;padding:.65rem;border-radius:.35rem;color:var(--fg);text-decoration:none}.navigator-sidebar a small{display:block;font-weight:400}.navigator-sidebar a>small{grid-column:1/-1;color:var(--warn)}.bounded-note{font-size:.8rem;color:var(--muted)}.task-index{margin-top:1rem}.task-index table{min-width:48rem}.task-summary>th{width:16rem;border-left:4px solid var(--link);color:var(--link);font-size:1.05rem;font-weight:800}.task-summary>td:last-child{width:9rem}.status-label,.blocked-indicator{display:block}.blocked-indicator{margin-top:.2rem;color:var(--warn);font-size:.78rem;font-weight:700}.task-detail-row>td{padding:.35rem .7rem 1rem;background:var(--panel)}.task-table-details summary{cursor:pointer;font-size:.85rem;font-weight:600;color:var(--muted)}.blocked-reason{border-left:4px solid var(--warn);padding:.6rem;color:var(--fg)}.list-panel{scroll-margin-top:1rem;margin-bottom:3rem}.list-panel:target{outline:3px solid var(--link);outline-offset:.45rem;border-radius:.5rem}.list-panel>header{border-bottom:1px solid var(--line);padding:0 0 1rem}.list-panel>header h2{font-size:2rem;margin:.1rem 0}.inbox-shell{display:grid;grid-template-columns:15rem minmax(0,1fr);gap:1.5rem;align-items:start}.inbox-sidebar{position:sticky;top:1rem;border:1px solid var(--line);border-radius:.6rem;background:var(--panel);padding:1rem}.inbox-sidebar h2{margin-top:0}.inbox-sidebar ul{list-style:none;padding:0;margin:0}.inbox-sidebar li{display:grid;grid-template-columns:1fr auto;gap:.15rem .5rem;padding:.65rem;border-radius:.35rem}.inbox-sidebar li.selected{background:var(--fg);color:var(--bg);font-weight:700}.inbox-sidebar .blocked-count{grid-column:1/-1;font-size:.78rem;color:var(--warn)}.inbox-sidebar li.selected .blocked-count{color:inherit}.inbox-sidebar>p{font-size:.8rem;color:var(--muted)}.inbox-main>header{border:0;border-radius:1rem;padding:clamp(1.25rem,4vw,2.5rem);color:#fff;background:linear-gradient(135deg,#18356f 0%,#4a3aa8 100%);box-shadow:0 .8rem 2rem rgba(29,36,88,.18)}.inbox-main>header h2{font-size:clamp(2rem,5vw,3.5rem);line-height:1.05;margin:.1rem 0}.inbox-main>header .eyebrow,.inbox-main>header p{color:#fff}.inbox-main>header .selection-count{display:inline-block;margin:.5rem 0 0;padding:.3rem .65rem;border:1px solid rgba(255,255,255,.55);border-radius:999px;background:rgba(255,255,255,.12)}.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;font-weight:700;color:var(--muted)}.selection-count{font-weight:700}.attention{margin-top:1.5rem;border:1px solid var(--attention-border);border-left:5px solid var(--attention-border);border-radius:.75rem;padding:0 1rem 1rem;background:var(--attention-bg);color:var(--attention-fg)}.attention h3{color:var(--attention-fg)}.attention .inbox-task{background:var(--attention-card-bg);color:var(--attention-card-fg)}.attention .inbox-title,.attention .inbox-brief,.attention .inbox-meta,.attention .field-table,.attention .value{color:var(--attention-card-fg)}.attention .tone-warning{color:var(--attention-accent)}.attention .clear-state{color:var(--attention-fg)}.inbox-task{color:var(--fg);border:1px solid var(--line);border-radius:.5rem;background:var(--panel);margin:.65rem 0}.inbox-task.tone-warning,.inbox-task.tone-good{color:var(--fg)}.inbox-task summary{cursor:pointer;padding:1rem}.inbox-title,.inbox-brief,.inbox-meta{display:block}.inbox-title{font-weight:750}.inbox-brief{margin:.25rem 0}.inbox-meta{font-size:.85rem;color:var(--muted)}.inbox-detail{padding:0 1rem 1rem}.clear-state{border:1px solid var(--good);border-radius:.4rem;padding:.8rem}.terminal-group{margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted)}.terminal-group summary{cursor:pointer;font-weight:700}.terminal-group li span{display:block;font-size:.85rem}.report-metadata{margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem;color:var(--muted)}.report-metadata summary{cursor:pointer;font-weight:700}.report-metadata h2{font-size:1rem;margin:1rem 0 .25rem}.list-board{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr));gap:1rem}.list-unit{border:1px solid var(--line);border-radius:.65rem;background:var(--panel);padding:1rem;display:flex;flex-direction:column}.list-unit header h3{font-size:1.35rem;margin:.1rem 0}.list-unit header p{margin:.15rem 0;color:var(--muted)}.list-type{text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;font-weight:700}.list-signals{display:grid;grid-template-columns:repeat(4,1fr);gap:.4rem;list-style:none;padding:0;margin:1rem 0}.list-signals li{border:1px solid var(--line);border-radius:.35rem;padding:.5rem;text-align:center}.list-signals strong,.list-signals span{display:block}.list-signals strong{font-size:1.25rem}.list-signals span{font-size:.75rem;color:var(--muted)}.list-signals .has-warning{border-color:var(--warn)}.recent-tasks{padding-left:1.4rem}.recent-tasks li{margin:.35rem 0}.list-truncation{font-size:.85rem;color:var(--muted)}.list-entry{margin-top:auto;padding-top:.75rem;font-weight:700}.record-list{display:grid;gap:1rem}.record{color:var(--fg);border:1px solid var(--line);border-radius:.5rem;background:var(--panel)}.record.tone-good,.record.tone-warning,.record.tone-bad{color:var(--fg)}.record.tone-good{border-left:4px solid var(--good)}.record.tone-warning{border-left:4px solid var(--warn)}.record.tone-bad{border-left:4px solid var(--bad)}.record summary{cursor:pointer;padding:1rem}.record summary strong,.record summary span{display:block}.record summary span{color:var(--muted);font-size:.9rem}.record-body{padding:0 1rem 1rem}.record-group h4{margin:1rem 0 .4rem}.field-table{min-width:100%}.field-table th{width:12rem}.field-table .multiline{white-space:pre-wrap;font-weight:400}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:.4rem}table{border-collapse:collapse;width:100%;min-width:max(100%,calc(var(--columns) * 9rem))}th,td{text-align:left;padding:.6rem .7rem;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere;min-width:8rem}thead{background:var(--panel)}tbody tr:last-child>*{border-bottom:0}.tone-good{color:var(--good)}.tone-warning{color:var(--warn)}.tone-bad{color:var(--bad)}.tone-unknown,.unknown{color:var(--muted);font-style:italic}.truncation{font-weight:700}.prose{white-space:pre-wrap;overflow-wrap:anywhere}footer{border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}@media(max-width:44rem){.navigator-hero{margin:.5rem .75rem;padding:1.1rem 1rem;box-shadow:none}.navigator-hero h1{font-size:2rem}.navigator-hero p{margin:.35rem 0}.navigator-shell{grid-template-columns:1fr;gap:1rem}.navigator-sidebar{position:static;margin:0}.navigator-sidebar h2{font-size:1rem;margin:0 0 .5rem}.navigator-sidebar ul{display:flex;flex-wrap:wrap;gap:.35rem}.navigator-sidebar li{flex:1 1 8rem}.navigator-sidebar a{padding:.5rem}.bounded-note{margin:.5rem 0 0}.list-panel{margin-bottom:1rem}.list-panel>header h2{font-size:1.65rem}.task-index{overflow:visible;border:0}.task-index>table{display:block;min-width:0;width:100%}.task-index>table>thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.task-index>table>tbody{display:grid;gap:.75rem}.task-summary{display:grid;grid-template-columns:minmax(0,1fr) auto;border:1px solid var(--line);border-bottom:0;border-radius:.55rem .55rem 0 0;background:var(--bg)}.task-summary>th,.task-summary>td{display:block;min-width:0;border:0;padding:.65rem}.task-summary>th{grid-column:1;grid-row:1;width:auto;border-left:4px solid var(--link)}.task-summary>td:nth-child(2){grid-column:1/-1;grid-row:2;padding-top:0}.task-summary>td:last-child{grid-column:2;grid-row:1;width:auto;text-align:right}.task-detail-row{display:block;margin-top:-.75rem}.task-detail-row>td{display:block;border:1px solid var(--line);border-top:0;border-radius:0 0 .55rem .55rem;padding:.45rem .65rem}.task-table-details summary{font-size:.8rem}.inbox-shell{grid-template-columns:1fr}.inbox-shell{grid-template-columns:1fr}.inbox-sidebar{position:static}.inbox-sidebar ul{display:grid;grid-template-columns:repeat(2,1fr)}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}@media(forced-colors:active){.inbox-main>header{background:Canvas;color:CanvasText;border:2px solid CanvasText}.inbox-main>header .eyebrow,.inbox-main>header p{color:CanvasText}.attention{border:2px solid CanvasText}}@media print{.navigator-sidebar{position:static}.list-panel{display:block!important;outline:0!important}:root{color-scheme:light}nav{display:none}body{font-size:10pt}.table-wrap{overflow:visible}table{min-width:100%}th,td{min-width:0}.task-card{break-inside:avoid}.task-card:not([open])>:not(summary),.record:not([open])>:not(summary),.inbox-task:not([open])>:not(summary),.task-table-details:not([open])>:not(summary){display:block}section{break-inside:avoid}a{color:inherit;text-decoration:none}}</style></head><body>
${isFocusedInbox ? '' : `<header><p class="meta">Fleet read-only report</p><h1>${escapeReportHtml(model.title)}</h1>${model.description ? `<p>${escapeReportHtml(model.description)}</p>` : ''}${summary}<nav aria-label="Report sections"><h2>Contents</h2><ul>${nav}</ul></nav>${filters ? `<section aria-labelledby="filters-heading"><h2 id="filters-heading">Filters</h2><ul>${filters}</ul></section>` : ''}${observations ? `<section aria-labelledby="observations-heading"><h2 id="observations-heading">Source observation times</h2><ul>${observations}</ul></section>` : ''}</header>`}
<main>${unavailableHtml}${model.sections.map(sectionHtml).join('')}${reportMetadata}</main>
<footer>${(() => { const t = reportTime(model.generatedAt); return `Generated at ${t.datetime ? `<time datetime="${t.datetime}">${t.text}</time>` : escapeReportHtml(t.text)}`; })()} by ${escapeReportHtml(model.source.name)} ${escapeReportHtml(model.source.version)}. This script-free artifact is read-only and contains no Fleet actions.</footer></body></html>\n`;
}

function safeFilenamePart(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80);
  return safe || 'report';
}

export function createReportArtifact(model: ReportViewModel, resourceId?: string): ReportArtifact {
  const html = renderReportHtml(model);
  const filename = `fleet-${safeFilenamePart(model.reportKind)}${resourceId ? `-${safeFilenamePart(resourceId)}` : ''}.html`;
  return {
    html,
    metadata: {
      schemaVersion: 1, reportKind: model.reportKind, filename, mediaType: MEDIA_TYPE,
      byteSize: Buffer.byteLength(html), source: model.source, generatedAt: model.generatedAt,
      filters: Object.fromEntries(canonicalEntries(model.filters)),
      truncated: model.sections.some(section => section.kind === 'task-navigator'
        ? section.panels.some(panel => panel.shown < panel.total)
        : (section.kind === 'table' || section.kind === 'cards' || section.kind === 'records' || section.kind === 'list-board') && Boolean(section.truncated)),
      unavailable: [...(model.unavailable ?? [])].sort(reportCompare),
      observedAt: Object.fromEntries(canonicalEntries(model.observedAt)),
      truncation: model.sections.flatMap(section => section.kind === 'task-navigator'
        ? section.panels.filter(panel => panel.shown < panel.total).map(panel => ({ section: `${section.id}:${panel.id}`, shown: panel.shown, total: panel.total }))
        : (section.kind === 'table' || section.kind === 'cards' || section.kind === 'records' || section.kind === 'list-board') && section.truncated
          ? [{ section: section.id, ...section.truncated }] : []),
    },
  };
}
