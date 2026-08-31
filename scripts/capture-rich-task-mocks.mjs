import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = resolve(process.argv[2] ?? '');
const files = process.argv.slice(3);
if (!process.argv[2]) throw new Error('usage: capture-rich-task-mocks.mjs <directory> [html-file ...]');
if (!files.length) files.push('fleet-tasks.html', 'fleet-task-lists.html');
const screenshots = join(directory, 'screenshots');
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const printBodies = [];

for (const file of files) {
  const prefix = basename(file, '.html').replace(/^fleet-task-lists-/, '');
  await page.emulateMedia({ media: 'screen', colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(pathToFileURL(join(directory, file)).href);
  await page.screenshot({ path: join(screenshots, `${prefix}-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(screenshots, `${prefix}-mobile.png`), fullPage: true });
  await page.emulateMedia({ media: 'print', colorScheme: 'light' });
  await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
  const bodies = await page.locator('details.task-card .task-body, details.record .record-body, details.inbox-task .inbox-detail, details.task-table-details .inbox-detail').evaluateAll(nodes => nodes.map(node => ({ display: getComputedStyle(node).display, height: node.getBoundingClientRect().height, text: node.textContent?.trim().length ?? 0 })));
  if (bodies.some(body => body.display === 'none' || body.height <= 0 || body.text <= 0)) throw new Error(`${file}: a task body is absent from print layout`);
  printBodies.push({ file, bodies });
  await page.screenshot({ path: join(screenshots, `${prefix}-print.png`), fullPage: true });
  await page.pdf({ path: join(screenshots, `${prefix}-print.pdf`), printBackground: true, format: 'A4' });
}

await browser.close();
console.log(JSON.stringify({ screenshots, printBodies }));
