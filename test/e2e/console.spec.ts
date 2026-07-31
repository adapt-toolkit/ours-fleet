import { test, expect } from '@playwright/test';

test('bootstrap, inventory, live navigation, send, create, and security boundaries', async ({ page, request }) => {
  const bootstrap = (await (await request.post('/__test/bootstrap')).json()).url as string;
  await page.goto(bootstrap);
  await expect(page.getByRole('heading', { name: 'All roles' })).toBeVisible();
  await expect(page.getByText('Ours', { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:49371/');
  await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Terminal', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Dormant', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Needs attention 0' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show inactive (1)' })).toBeVisible();
  await expect(page.getByText('live · idle').first()).toBeVisible();
  await expect(page.getByText(/service inactive · authoritative/).first()).toBeVisible();
  await expect(page.getByLabel('Fleet status meanings')).toContainText('Busy active turn or permission');
  await expect(page.getByLabel('Fleet status meanings')).toContainText(
    'Needs attention includes active attention and unknown roles. Inactive roles are shown separately.',
  );
  await expect(page.locator('.status-chip.ready').first()).toHaveText(/Ready/);
  await page.getByRole('button', { name: 'Show inactive (1)' }).click();
  await expect(page.getByText('Dormant', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Inactive Dormant/ })).toBeVisible();
  await page.getByRole('button', { name: /Inactive Dormant/ }).click();
  await expect(page.getByText('Inactive — start is the only applicable lifecycle action.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restart & resume' })).toHaveCount(0);
  await page.getByRole('button', { name: 'All roles' }).click();
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
  await expect(page.getByRole('heading', { name: 'All roles' })).toBeVisible();
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
  await page.bringToFront();
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  await page.getByRole('button', { name: 'activity' }).click();
  await expect(page.getByText('Fixture agent is ready.')).toBeVisible();
  await page.waitForTimeout(6_000);
  expect((await (await request.get('/__test/metrics')).json()).outputCalls).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('Live refresh arrived.')).toBeVisible();
  await expect(page.getByText(/#1–3 · agent text/)).toBeVisible();
  await expect(page.getByText('2 low-level updates hidden')).toBeVisible();
  await expect(page.getByText(/#4 · tool update/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Show technical details' }).click();
  await expect(page.getByText(/#4 · tool update/)).toBeVisible();
  await page.getByRole('button', { name: 'Hide technical details' }).click();
  await page.getByPlaceholder('Prompt the live session…').fill('hello fixture');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('accepted; turn may still be running')).toBeVisible();
  await page.getByRole('button', { name: /Create role/ }).click();
  await page.getByLabel('Role / session name').fill('Researcher');
  await expect(page.getByText('type any ID; blank uses harness default')).toBeVisible();
  await expect(page.getByLabel('Known model').locator('option')).toHaveText([
    'Harness default / custom ID', 'gpt-5.6', 'gpt-5.4',
  ]);
  await page.getByLabel('Known model').selectOption('gpt-5.6');
  const modelId = page.getByRole('textbox', { name: 'Model', exact: true });
  await expect(modelId).toHaveValue('gpt-5.6');
  await modelId.fill('');
  await page.getByLabel('Monitor mode').selectOption('native');
  await expect(page.getByLabel('Monitor wake sources')).toHaveCount(0);
  await page.getByLabel('Monitor mode').selectOption('fleet');
  await expect(page.getByLabel('Monitor injection').locator('option')).toHaveCount(1);
  await expect(page.getByLabel('Monitor injection').locator('option')).toHaveText('Notification summary');
  await page.getByLabel('Monitor batch milliseconds').fill('750');
  await page.getByLabel('Monitor wake sources').getByText('inbound error').click();
  await page.getByText('Interrupt an active turn before wake delivery').click();
  await page.getByRole('button', { name: 'Review effective plan' }).click();
  const effectivePlan = page.locator('.review');
  await expect(effectivePlan.getByText('Effective plan')).toBeVisible();
  await expect(effectivePlan.getByText('harness default', { exact: true })).toBeVisible();
  await expect(effectivePlan.getByText('gpt-5.6')).toHaveCount(0);
  await expect(page.getByText(/"batch_ms":750/)).toBeVisible();
  await expect(page.getByText(/"inbound_error"/)).toBeVisible();
  await page.getByRole('button', { name: 'Create atomically' }).click();
  await expect(page.getByRole('heading', { name: 'Researcher' })).toBeVisible();

  await page.getByRole('button', { name: 'All roles' }).click();
  await page.getByLabel('Filter roles').fill('');
  await page.getByRole('button', { name: /Terminal/ }).click();
  await page.getByRole('button', { name: 'terminal' }).click();
  await expect(page.locator('.terminal-host .xterm')).toBeVisible();
  await expect(page.locator('.terminal-host')).toContainText('ANSI BOLD');
  await expect(page.locator('.terminal-host')).toContainText('┌─ █ ');
  const terminalStyle = await page.locator('.terminal-host .xterm-rows').evaluate(element => ({
    fontFamily: getComputedStyle(element).fontFamily,
    fontWeight: getComputedStyle(element).fontWeight,
  }));
  expect(terminalStyle.fontFamily).toContain('JetBrainsMono Nerd Font');

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
  await expect(page.getByRole('heading', { name: 'All roles' })).toBeVisible();
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

test('password and intentional unprotected access are clear in Chromium', async ({ page }) => {
  await page.goto('http://127.0.0.1:49373/');
  await expect(page.getByLabel('Control-panel password')).toBeVisible();
  await page.getByLabel('Control-panel password').fill('wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('invalid control-panel password')).toBeVisible();
  await page.getByLabel('Control-panel password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All roles' })).toBeVisible();

  await page.goto('http://127.0.0.1:49372/');
  await expect(page.getByRole('heading', { name: 'All roles' })).toBeVisible();
  await expect(page.getByText(/Unprotected mode: anyone who can reach/)).toBeVisible();
});
