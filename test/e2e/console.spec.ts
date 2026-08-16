import { test, expect } from '@playwright/test';

test('bootstrap, inventory, live navigation, send, create, and security boundaries', async ({ page, request, browserName }) => {
  const bootstrap = (await (await request.post('/__test/bootstrap')).json()).url as string;
  await page.goto(bootstrap);
  await expect(page.getByRole('heading', { name: 'Fleet topology' })).toBeVisible();
  await expect(page.getByText('Ours', { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:49371/');
  await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Terminal', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Interactive fleet topology')).toBeVisible();
  await expect(page.getByLabel('Topology connection legend')).toContainText('Oversight');
  await expect(page.getByLabel('Topology connection legend')).toContainText('Temporary spawn');
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  await expect(page.getByRole('heading', { name: '1. Choose how agents run' })).toBeVisible();
  await expect(page.getByLabel('Configuration detail level')).toContainText('Basic');
  await page.getByLabel('Fleet model').selectOption('gpt-5.6-sol');
  await expect(page.getByLabel('Fleet reasoning effort')).toHaveValue('low');
  await page.getByLabel('Fleet reasoning effort').selectOption('ultra');
  await page.getByLabel('Configuration detail level').getByRole('button', { name: 'Advanced' }).click();
  await expect(page.getByPlaceholder('exact vendor model ID')).toHaveValue('gpt-5.6-sol');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: '2. Name the agents and give each a job' })).toBeVisible();
  await page.getByRole('button', { name: 'Topology' }).click();
  await expect(page.locator('[data-node-id="agent:Alpha"]')).toBeVisible();
  // Inactive roles stay hidden in the role table; the graph shows the whole
  // configuration, including roles that are configured but not running.
  await expect(page.locator('.role-table').getByText('Dormant', { exact: true })).toHaveCount(0);
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
  await expect(page.getByText('Dormant', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Inactive Dormant/ })).toBeVisible();
  await page.getByRole('button', { name: /Inactive Dormant/ }).click();
  await expect(page.getByText('Inactive — start is the only applicable lifecycle action.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restart & resume' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Watchdogs' }).click();
  await expect(page.getByRole('heading', { name: 'Watchdogs' })).toBeVisible();
  await expect(page.getByRole('button', { name: /nightwatch/ })).toBeVisible();
  await expect(page.locator('.status-chip.attention').first()).toContainText('Attention');
  await page.getByRole('button', { name: /nightwatch/ }).click();
  await expect(page.getByRole('heading', { name: 'nightwatch' })).toBeVisible();
  await expect(page.getByText('20260731T120000Z').first()).toBeVisible();
  await expect(page.getByText('20260731T110000Z')).toBeVisible();
  await expect(page.getByText('20260731T100000Z')).toBeVisible();
  const aliceRow = page.locator('.watchdog-role', { hasText: 'Alice' });
  await expect(aliceRow).toContainText('blocked');
  await expect(aliceRow).toContainText('Waiting on a trust dialog.');
  await expect(aliceRow).toContainText('expected: healthy — observed: blocked: Waiting on a trust dialog.');
  await expect(aliceRow).toContainText('alerted -> FleetCoordinator at');
  // <details> content is present in the DOM (and would satisfy toContainText)
  // even while collapsed, so the only real proof the toggle works is visibility.
  const evidenceItem = aliceRow.getByText('[status] readiness=awaiting_permission');
  await expect(evidenceItem).not.toBeVisible();
  await aliceRow.getByText('Evidence (1)').click();
  await expect(evidenceItem).toBeVisible();
  const watchdogView = page.locator('.watchdog-detail');
  await expect(watchdogView.getByRole('button', { name: /restart|stop|send/i })).toHaveCount(0);
  // Stub writeText instead of exercising the real OS clipboard (no clipboard-write
  // permission is granted to this context, and readText additionally needs
  // clipboard-read) — this still proves the button calls the Clipboard API with
  // the exact JSON.stringify(report, null, 2) payload the CLI's --json prints.
  await page.evaluate(() => {
    (window as unknown as { __copiedJson: string }).__copiedJson = '';
    navigator.clipboard.writeText = async text => {
      (window as unknown as { __copiedJson: string }).__copiedJson = text;
    };
  });
  await page.getByRole('button', { name: 'Copy JSON' }).click();
  await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible();
  const copiedJson = await page.evaluate(() => (window as unknown as { __copiedJson: string }).__copiedJson);
  expect(JSON.parse(copiedJson)).toMatchObject({ watchdog: 'nightwatch', run_id: '20260731T120000Z', status: 'anomalies' });

  // Run-switching: selecting the older (all-healthy) run must replace the
  // panel, not just append to it — the newest run's blocked finding should
  // be gone entirely, and Alice should read as a plain healthy row.
  await page.getByRole('button', { name: /20260731T110000Z/ }).click();
  await expect(aliceRow).toContainText('healthy');
  await expect(page.getByText('blocked')).toHaveCount(0);
  await expect(page.getByText('Waiting on a trust dialog.')).toHaveCount(0);
  await expect(page.getByText(/expected: healthy — observed:/)).toHaveCount(0);
  await expect(page.getByText(/alerted ->/)).toHaveCount(0);
  await expect(page.getByText('suppressed (open finding within cooldown)')).toHaveCount(0);

  // Error report: the per-role table is replaced entirely by the error
  // message and diagnostic tail.
  await page.getByRole('button', { name: /20260731T100000Z/ }).click();
  await expect(page.getByText('timeout')).toBeVisible();
  await expect(page.locator('pre')).toContainText('connection refused');
  await expect(page.locator('.watchdog-role')).toHaveCount(0);

  await page.getByRole('button', { name: '← Back to watchdogs' }).click();
  await expect(page.getByRole('heading', { name: 'Watchdogs' })).toBeVisible();

  await page.getByRole('button', { name: 'Topology' }).click();
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toMatch(/manifest|json/);
  expect((await manifest.json()).display).toBe('standalone');
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const installErrors = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors;
    // Playwright's temporary browser context is incognito by construction; no
    // manifest/icon/worker installability error is allowed beyond that fixture constraint.
    expect(installErrors.filter(error => error.errorId !== 'in-incognito')).toEqual([]);
  }
  await request.post('/__test/restart-auth');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Fleet topology' })).toBeVisible();
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
  await expect(page.getByText('Inspect the fixture')).toBeVisible();
  await expect(page.getByText('Plan', { exact: true })).toBeVisible();
  await expect(page.getByText('Inspect input')).toBeVisible();
  await expect(page.getByText('Edit fixture.ts')).toBeVisible();
  await expect(page.locator('.usage-badge')).toContainText('context 42%');
  await page.getByText('Edit fixture.ts').click();
  await expect(page.getByText('/workspace/fixture.ts:7')).toBeVisible();
  await expect(page.getByText('new value')).toBeVisible();
  await expect(page.getByText(/"path": "fixture.ts"/)).toBeVisible();
  await page.getByRole('button', { name: 'overview' }).click();
  await expect(page.getByRole('button', { name: 'Remove role…' })).toBeVisible();
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
  await expect(page.getByLabel('Setup detail level')).toContainText('Basic');
  await expect(page.getByLabel('Known model').locator('option')).toHaveText([
    'Use harness default (resolved after launch)', 'GPT-5.6-Sol — gpt-5.6-sol', 'GPT-5.6-Terra — gpt-5.6-terra',
  ]);
  await page.getByLabel('Known model').selectOption('gpt-5.6-sol');
  await expect(page.getByLabel('Reasoning effort')).toHaveValue('low');
  await page.getByLabel('Reasoning effort').selectOption('ultra');
  await page.getByRole('button', { name: 'Advanced' }).click();
  const modelId = page.getByRole('textbox', { name: 'Model', exact: true });
  await expect(modelId).toHaveValue('gpt-5.6-sol');
  await page.getByLabel('Monitor mode').selectOption('native');
  await expect(page.getByLabel('Monitor wake sources')).toHaveCount(0);
  await page.getByLabel('Monitor mode').selectOption('fleet');
  await expect(page.getByLabel('Monitor injection').locator('option')).toHaveCount(1);
  await expect(page.getByLabel('Monitor injection').locator('option')).toHaveText('Notification summary');
  await page.getByLabel('Monitor batch milliseconds').fill('750');
  await page.getByLabel('Monitor wake sources').getByText('inbound error').click();
  await page.getByLabel('Monitor interruption').selectOption('true');
  await page.getByRole('button', { name: 'Review effective plan' }).click();
  const effectivePlan = page.locator('.review');
  await expect(effectivePlan.getByText('Effective plan')).toBeVisible();
  await expect(effectivePlan.getByText('gpt-5.6-sol', { exact: true })).toBeVisible();
  await expect(effectivePlan.getByText('ultra', { exact: true })).toBeVisible();
  await expect(page.getByText(/"batch_ms":750/)).toBeVisible();
  await expect(page.getByText(/"inbound_error"/)).toBeVisible();
  await page.getByRole('button', { name: 'Create atomically' }).click();
  await expect(page.getByRole('heading', { name: 'Researcher' })).toBeVisible();

  await page.getByRole('button', { name: 'Topology' }).click();
  await page.getByLabel('Filter roles').fill('');
  // Selecting a card now opens the inspector; opening the agent is explicit.
  await page.locator('[data-node-id="agent:Terminal"]').click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
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
  // Firefox's private Playwright context does not expose a usable service
  // worker; Chromium is the deterministic PWA/cache oracle for this suite.
  if (browserName === 'chromium') {
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.context().setOffline(true);
    await page.goto('http://127.0.0.1:49371/offline-check');
    await expect(page.getByRole('heading', { name: 'Local daemon unavailable' })).toBeVisible();
    await expect(page.getByText('Alpha', { exact: true })).toHaveCount(0);
    await page.context().setOffline(false);
    await page.goto('http://127.0.0.1:49371/');
    await expect(page.getByRole('heading', { name: 'Fleet topology' })).toBeVisible();
    const cached = await page.evaluate(async () => (await Promise.all(
      (await caches.keys()).map(async key => (await caches.open(key)).keys()),
    )).flat().map(request => new URL(request.url).pathname));
    expect(cached).toContain('/offline.html');
    expect(cached.every(path => path === '/offline.html' || path.startsWith('/assets/'))).toBe(true);
  }
  const removalDialogs: string[] = [];
  page.on('dialog', async dialog => {
    removalDialogs.push(dialog.message());
    await dialog.accept(dialog.type() === 'prompt' ? 'Alpha' : undefined);
  });
  // Removal moved from a per-card control into the node inspector; the removal
  // contract it triggers is unchanged.
  await page.locator('[data-node-id="agent:Alpha"]').click();
  await page.getByRole('button', { name: 'Remove Alpha' }).click();
  await expect.poll(() => removalDialogs.length).toBeGreaterThanOrEqual(3);
  expect(removalDialogs.join('\n')).toContain("Stop and uninstall the exact backend registration for 'Alpha'.");
  expect(removalDialogs.join('\n')).toContain('/fixture/recovery/Alpha');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText(/ours-fleet web open/)).toBeVisible();
  expect((await page.context().cookies()).filter(cookie =>
    ['ofs_session', 'ofs_device'].includes(cookie.name))).toHaveLength(0);
});

test('topology edges terminate on their cards on a viewport wider than the layout', async ({ page, request }) => {
  const bootstrap = (await (await request.post('/__test/bootstrap')).json()).url as string;
  // The reported geometry defect only appears once the canvas is wider than
  // the fixed card layout, so reproduce the owner's console viewport exactly.
  await page.setViewportSize({ width: 2048, height: 384 });
  await page.goto(bootstrap);
  await expect(page.getByLabel('Interactive fleet topology')).toBeVisible();
  await expect(page.locator('[data-node-id="agent:Alpha"]')).toBeVisible();

  const edges = await page.evaluate(() => {
    // Located by stable id rather than by the card's accessible name, which now
    // also carries the node's completeness badge.
    const card = (id: string) => document.querySelector(`[data-node-id="${id}"]`)!;
    const covers = (element: Element, point: DOMPoint) => {
      const box = element.getBoundingClientRect();
      return point.x >= box.left && point.x <= box.right
        && point.y >= box.top && point.y <= box.bottom;
    };
    // getScreenCTM folds in any SVG user-space scaling, so this measures where
    // the edge is actually painted, not where its attributes claim it is.
    return [...document.querySelectorAll('.edge line')].map(node => {
      const line = node as SVGLineElement;
      const matrix = line.getScreenCTM()!;
      const start = new DOMPoint(line.x1.baseVal.value, line.y1.baseVal.value)
        .matrixTransform(matrix);
      const end = new DOMPoint(line.x2.baseVal.value, line.y2.baseVal.value)
        .matrixTransform(matrix);
      return {
        label: line.parentElement!.querySelector('title')!.textContent,
        startsOnWatchdog: covers(card('watchdog:nightwatch'), start),
        endsOnAgent: covers(card('agent:Alpha'), end),
        canvasWidth: Math.round(
          document.querySelector('.topology-canvas')!.getBoundingClientRect().width),
      };
    });
  });

  expect(edges).toHaveLength(1);
  expect(edges[0].canvasWidth).toBeGreaterThan(1_000);
  expect(edges[0]).toMatchObject({
    label: 'watches', startsOnWatchdog: true, endsOnAgent: true,
  });
});

test('password and intentional unprotected access are clear in Chromium', async ({ page }) => {
  await page.goto('http://127.0.0.1:49373/');
  await expect(page.getByLabel('Control-panel password')).toBeVisible();
  await page.getByLabel('Control-panel password').fill('wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('invalid control-panel password')).toBeVisible();
  await page.getByLabel('Control-panel password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Fleet topology' })).toBeVisible();

  await page.goto('http://127.0.0.1:49372/');
  await expect(page.getByRole('heading', { name: 'Fleet topology' })).toBeVisible();
  await expect(page.getByText(/Unprotected mode: anyone who can reach/)).toBeVisible();
});

test('sketch, connect and add to the fleet from an empty console without launching', async ({ page, request }) => {
  await request.post('http://127.0.0.1:49374/__test/reset');
  const bootstrap = (await (await request.post('http://127.0.0.1:49374/__test/bootstrap')).json()).url as string;
  await page.goto(bootstrap);

  // An empty fleet lands on the graph, not on a form.
  await expect(page.getByRole('heading', { name: 'Sketch your fleet' })).toBeVisible();
  await expect(page.getByText('Nothing runs until you say so.')).toBeVisible();

  // Sketch an agent. It exists immediately, warns about what it still needs,
  // and offers no way to start it.
  await page.getByRole('button', { name: '＋ Add your first agent' }).click();
  await expect(page.locator('[data-node-id="agent:Agent1"]')).toBeVisible();
  await expect(page.getByLabel('Agent1 details')).toContainText('mission');
  await expect(page.getByRole('button', { name: 'Add to fleet' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Launch/ })).toHaveCount(0);

  // Complete it through the inspector.
  await page.getByLabel('Agent1 details').getByLabel('Mission').fill('Review pull requests');
  await page.getByLabel('Agent1 details').getByLabel('Mission').blur();
  await expect(page.locator('[data-node-id="agent:Agent1"]')).toContainText('ready to add');

  // Agent oversight is deferred out of this phase: no inert control, and the
  // inspector says where it is configured instead.
  await expect(page.getByRole('button', { name: /oversees/i })).toHaveCount(0);
  // The whole rendered sentence, not fragments of it: JSX drops the newline that
  // follows an element, so `<code>oversee:</code>` collides with the next word
  // unless the space is explicit, and a fragment assertion still matches.
  await expect(page.getByLabel('Agent1 details')).toContainText(
    'Agent oversight — which agent checks on which — is not configured from the graph yet.'
    + ' It arrives in a later phase; until then, set oversee: in the configuration editor.');
  await expect(page.getByLabel('Agent1 details')).not.toContainText('oversee:in');

  // Connect: a watchdog created from the agent is scoped to that agent.
  await page.getByRole('button', { name: '＋ Watchdog for this agent' }).click();
  await expect(page.locator('[data-node-id="watchdog:Watchdog1"]')).toBeVisible();
  await expect(page.getByLabel('Watchdog1 details')).toContainText('coordinator');
  await expect(page.getByLabel('Watchdog1 details')).toContainText('Watchdog: outgoing to agent:Agent1');

  // Configure: adding to the fleet is a reviewed configuration write.
  await page.locator('[data-node-id="agent:Agent1"]').click();
  await page.getByLabel('Agent1 details').getByRole('button', { name: 'Add to fleet' }).click();
  await expect(page.getByRole('dialog', { name: 'Review configuration change' })).toBeVisible();
  await expect(page.getByText('This writes configuration only.')).toBeVisible();
  await expect(page.locator('.config-diff')).toContainText('Agent1');
  await page.getByRole('dialog').getByRole('button', { name: 'Add to fleet' }).click();

  // The sketch became configuration, and the operator's comment survived.
  await expect.poll(async () =>
    (await (await request.get('http://127.0.0.1:49374/__test/fleet-yaml')).json()).text as string)
    .toContain('Agent1');
  await expect(page.locator('[data-node-id="agent:Agent1"]')).toContainText('Configured');
  const yaml = (await (await request.get('http://127.0.0.1:49374/__test/fleet-yaml')).json()).text as string;
  expect(yaml).toContain('# operator header — must survive every console write');
  expect(yaml).toContain('  Agent1:');
  expect(yaml).toContain('    mission: Review pull requests');

  // Still nothing started: promotion writes configuration and stops there.
  await expect(page.getByRole('button', { name: /^Launch/ })).toHaveCount(0);
  await expect(page.locator('[data-node-id="watchdog:Watchdog1"]')).toContainText('Draft');

  // Promoting the agent first must NOT unscope the watchdog that was created
  // from it: the scope edge belongs to the watchdog and is only written when the
  // watchdog itself is added.
  await expect(page.locator('[data-node-id="watchdog:Watchdog1"]')).toContainText('watchdog');
  await page.locator('[data-node-id="watchdog:Watchdog1"]').click();
  await expect(page.getByLabel('Watchdog1 details')).toContainText('Watchdog: outgoing to agent:Agent1');
  await page.getByLabel('Watchdog1 details').getByLabel('Coordinator').fill('Agent1');
  await page.getByLabel('Watchdog1 details').getByLabel('Coordinator').blur();
  await page.getByLabel('Watchdog1 details').getByRole('button', { name: 'Add to fleet' }).click();
  await expect(page.getByRole('dialog', { name: 'Review configuration change' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Add to fleet' }).click();

  await expect.poll(async () =>
    (await (await request.get('http://127.0.0.1:49374/__test/fleet-yaml')).json()).text as string)
    .toContain('watchdogs:');
  const withWatchdog = (await (await request.get('http://127.0.0.1:49374/__test/fleet-yaml')).json()).text as string;
  // Scoped to the agent it was created from — not a watch-everything watchdog.
  expect(withWatchdog).toContain('    watch:');
  expect(withWatchdog).toContain('      - Agent1');
  expect(withWatchdog).toContain('    coordinator: Agent1');
  await expect(page.getByRole('button', { name: /^Launch/ })).toHaveCount(0);
});
