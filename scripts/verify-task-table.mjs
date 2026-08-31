import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = resolve(process.argv[2] ?? '');
const expected = ['Active', 'Backlog', 'Cancelled', 'Done', 'Failed', 'Provisioning', 'Review'];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(pathToFileURL(file).href);
const statuses = [...new Set(await page.locator('.task-summary .status-label').allTextContents())].sort();
if (JSON.stringify(statuses) !== JSON.stringify(expected)) throw new Error(`status coverage mismatch: ${statuses.join(', ')}`);
const tables = await page.locator('.task-index>table').count();
const summaries = await page.locator('.task-summary').count();
const detailRows = await page.locator('.task-detail-row').count();
if (summaries !== detailRows || tables !== 3) throw new Error(`invalid table/detail structure: ${tables}/${summaries}/${detailRows}`);
if (await page.locator('text=Needs attention').count()) throw new Error('invented Needs attention category remains');
const parity = await page.locator('.task-summary').evaluateAll(rows => rows.map(row => {
  const detail = row.nextElementSibling;
  const fields = Object.fromEntries([...detail.querySelectorAll('.field-table tr')].map(field => [field.querySelector('th')?.textContent?.trim(), field.querySelector('td')?.textContent?.trim()]));
  const list = row.closest('.list-panel')?.querySelector(':scope>header h2')?.textContent?.trim();
  return { id: row.dataset.taskId === fields['Task ID'], title: row.dataset.taskTitle === fields.Title, brief: row.dataset.taskBrief === fields.Brief, status: row.dataset.taskStatus === fields['Lifecycle status'], list: list === fields.List };
}));
if (parity.some(item => Object.values(item).some(value => !value))) throw new Error(`row/detail parity failed: ${JSON.stringify(parity)}`);
await page.locator('.task-table-details summary').first().focus();
await page.keyboard.press('Enter');
if (!(await page.locator('.task-table-details').first().getAttribute('open') !== null)) throw new Error('keyboard disclosure failed');
const mobile = [];
await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = false; }));
for (const width of [320, 390]) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`${pathToFileURL(file).href}#list-release`);
  const metrics = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, visiblePanels: [...document.querySelectorAll('.list-panel')].filter(node => getComputedStyle(node).display !== 'none').length }));
  const visible = await page.locator('#list-release .task-summary').evaluateAll(rows => rows.map(row => ({ name: row.querySelector('th')?.getBoundingClientRect().width ?? 0, brief: row.children[1]?.getBoundingClientRect().width ?? 0, status: row.children[2]?.getBoundingClientRect().width ?? 0 })));
  if (metrics.client !== metrics.scroll || metrics.visiblePanels !== 1 || visible.some(item => item.name <= 0 || item.brief <= 0 || item.status <= 0)) throw new Error(`mobile ${width} failed: ${JSON.stringify({ metrics, visible })}`);
  mobile.push({ width, ...metrics, tasks: visible.length });
}
await page.locator('a[href="#list-waiting"]').click();
const waitingVisible = await page.locator('.list-panel').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).display !== 'none').map(node => node.id));
await page.goBack();
const backVisible = await page.locator('.list-panel').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).display !== 'none').map(node => node.id));
if (waitingVisible.join() !== 'list-waiting' || backVisible.join() !== 'list-release') throw new Error(`mobile hash/back failed: ${waitingVisible}/${backVisible}`);
await page.emulateMedia({ media: 'print' });
const printDetails = await page.locator('.task-table-details .inbox-detail').evaluateAll(nodes => nodes.map(node => ({ display: getComputedStyle(node).display, height: node.getBoundingClientRect().height })));
if (printDetails.some(item => item.display === 'none' || item.height <= 0)) throw new Error('print detail hidden');
await browser.close();
console.log(JSON.stringify({ statuses, tables, summaries, detailRows, parity, mobile, waitingVisible, backVisible, printDetails: printDetails.length }));
