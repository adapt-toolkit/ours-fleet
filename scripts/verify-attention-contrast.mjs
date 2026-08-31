import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: verify-attention-contrast.mjs <html-file>');
const rgb = value => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const luminance = color => {
  const values = rgb(color).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); };
const browser = await chromium.launch({ headless: true });
const evidence = [];
const screenshots = join(dirname(file), 'screenshots');
await mkdir(screenshots, { recursive: true });
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  await page.goto(pathToFileURL(file).href);
  const pairs = await page.locator('.attention').first().evaluate(root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const result = [];
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim();
      if (!text) continue;
      const element = walker.currentNode.parentElement;
      if (!element || getComputedStyle(element).display === 'none') continue;
      let background = element;
      while (background && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)') background = background.parentElement;
      const style = getComputedStyle(element);
      result.push({ text: text.slice(0, 60), color: style.color, background: background ? getComputedStyle(background).backgroundColor : getComputedStyle(document.body).backgroundColor, size: Number.parseFloat(style.fontSize), weight: Number.parseInt(style.fontWeight, 10) || 400 });
    }
    return result;
  });
  for (const pair of pairs) {
    pair.ratio = contrast(pair.color, pair.background);
    pair.minimum = pair.size >= 24 || (pair.size >= 18.66 && pair.weight >= 700) ? 3 : 4.5;
    if (pair.ratio < pair.minimum) throw new Error(`${scheme}: contrast ${pair.ratio.toFixed(2)} < ${pair.minimum} for ${pair.text}`);
  }
  evidence.push({ scheme, minimum: Math.min(...pairs.map(pair => pair.ratio)), pairs: pairs.length });
  await page.locator('.attention').first().screenshot({ path: join(screenshots, `attention-${scheme}.png`) });
  await page.close();
}
const forced = await browser.newPage({ viewport: { width: 1440, height: 900 }, forcedColors: 'active' });
await forced.goto(pathToFileURL(file).href);
const forcedStyles = await forced.locator('.attention').first().evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).borderColor }));
await forced.screenshot({ path: join(screenshots, 'combined-forced-colors.png'), fullPage: true });
await browser.close();
console.log(JSON.stringify({ evidence, forcedStyles }));
