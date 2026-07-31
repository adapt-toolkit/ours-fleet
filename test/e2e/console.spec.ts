import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('bootstrap, inventory, navigation, send, create, and security boundaries', async ({ page, request }) => {
  const bootstrap = readFileSync('.e2e-bootstrap', 'utf8').trim();
  await page.goto(bootstrap);
  await expect(page.getByRole('heading', { name: 'Your fleet' })).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:49371/');
  await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible();
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
});
