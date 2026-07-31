import { test, expect } from '@playwright/test';

test('bootstrap, inventory, navigation, send, create, and security boundaries', async ({ page, request }) => {
  const bootstrap = (await (await request.post('/__test/bootstrap')).json()).url as string;
  await page.goto(bootstrap);
  await expect(page.getByRole('heading', { name: 'Your fleet' })).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:49371/');
  await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('live · idle')).toBeVisible();
  await expect(page.getByText(/service inactive · authoritative/)).toBeVisible();
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toMatch(/manifest|json/);
  expect((await manifest.json()).display).toBe('standalone');
  const cdp = await page.context().newCDPSession(page);
  const installErrors = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors;
  // Playwright's temporary browser context is incognito by construction; no
  // manifest/icon/worker installability error is allowed beyond that fixture constraint.
  expect(installErrors.filter(error => error.errorId !== 'in-incognito')).toEqual([]);
  await request.post('/__test/restart-auth');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your fleet' })).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:49371/');
  const mission = page.locator('.mission-summary').first();
  await expect(mission).toHaveAttribute('title', /intentionally long mission/);
  expect(await mission.evaluate(element => ({
    lineClamp: getComputedStyle(element).webkitLineClamp,
    overflow: getComputedStyle(element).overflow,
    overflowWrap: getComputedStyle(element).overflowWrap,
  }))).toEqual({ lineClamp: '2', overflow: 'hidden', overflowWrap: 'anywhere' });
  await page.getByLabel('Filter roles').fill('validate');
  await expect(page.getByText('Validate the secure console')).toBeVisible();
  await page.getByText('Alpha', { exact: true }).first().click();
  await expect(page.getByText('authoritative')).toBeVisible();
  await page.getByRole('button', { name: 'activity' }).click();
  await expect(page.getByText('Fixture agent is ready.')).toBeVisible();
  await page.getByPlaceholder('Prompt the live session…').fill('hello fixture');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('accepted; turn may still be running')).toBeVisible();
  await page.getByRole('button', { name: /Create role/ }).click();
  await page.getByLabel('Role / session name').fill('Researcher');
  await page.getByRole('button', { name: 'Review effective plan' }).click();
  await expect(page.getByText('Effective plan')).toBeVisible();
  await page.getByRole('button', { name: 'Create atomically' }).click();
  await expect(page.getByRole('heading', { name: 'Researcher' })).toBeVisible();

  const cookies = await page.context().cookies();
  const session = cookies.find(cookie => cookie.name === 'ofs_session')!;
  const csrfFailure = await request.post('http://127.0.0.1:49371/api/v1/roles/Alpha/input', {
    headers: {
      Host: '127.0.0.1:49371', Origin: 'http://127.0.0.1:49371',
      Cookie: `ofs_session=${session.value}`,
    },
    data: { text: 'missing csrf' },
  });
  expect(csrfFailure.status()).toBe(403);
  const hostile = await request.get('http://127.0.0.1:49371/api/v1/meta', {
    headers: { Host: 'evil.invalid', Origin: 'http://evil.invalid' },
  });
  expect(hostile.status()).toBe(403);

  await page.screenshot({ path: 'test-results/web-console-overview.png', fullPage: true });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.context().setOffline(true);
  await page.goto('http://127.0.0.1:49371/offline-check');
  await expect(page.getByRole('heading', { name: 'Local daemon unavailable' })).toBeVisible();
  await expect(page.getByText('Alpha', { exact: true })).toHaveCount(0);
  await page.context().setOffline(false);
  await page.goto('http://127.0.0.1:49371/');
  await expect(page.getByRole('heading', { name: 'Your fleet' })).toBeVisible();
  const cached = await page.evaluate(async () => (await Promise.all(
    (await caches.keys()).map(async key => (await caches.open(key)).keys()),
  )).flat().map(request => new URL(request.url).pathname));
  expect(cached).toContain('/offline.html');
  expect(cached.every(path => path === '/offline.html' || path.startsWith('/assets/'))).toBe(true);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText(/ours-fleet web open/)).toBeVisible();
  expect((await page.context().cookies()).filter(cookie =>
    ['ofs_session', 'ofs_device'].includes(cookie.name))).toHaveLength(0);
});
