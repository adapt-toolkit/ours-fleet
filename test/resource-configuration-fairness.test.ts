import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, get } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { FleetResourceViews } from '../src/web/resource-views.js';
import { publishFleetResourceCommit } from '../src/application/resource-observer.js';
import { splitRootFor } from '../src/config.js';
import { defaultConfigPath } from '../src/paths.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
function fixture(project: (descriptor: any) => Promise<unknown>, configPath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'configuration-fairness-'));
  cleanup.push(() => rmSync(root, {recursive:true, force:true}));
  const response = Object.assign(new EventEmitter(), {write:vi.fn(() => true), end:vi.fn()});
  const resources = new FleetResourceViews({paths:[root], roots:[root], configPath,
    watch:() => Object.assign(new EventEmitter(), {close(){}})}, project);
  const connection = resources.open(response as any, 'owner', () => true);
  cleanup.push(() => resources.close());
  const register = (epoch = 1, resource = 'configuration') => resources.register('owner', connection.connectionId, 'view', epoch, {viewId:'view', resource});
  const bound = (binding: ReturnType<typeof register>, epoch = 1) => resources.bound('owner', connection.connectionId, 'view', epoch, binding.baselineId);
  return {root, resources, connection, response, register, bound};
}

for (const manifest of ['/tmp/config-fairness/fleet.yaml', '/tmp/config-fairness/custom.YML', '/tmp/config-fairness/manifest.json', undefined]) {
  it(`limits configuration invalidation to manifest, split definitions and ancestors: ${manifest ?? 'default'}`, () => {
    const f = fixture(async () => ({}), manifest);
    const path = manifest ?? defaultConfigPath(), split = splitRootFor(path);
    const affects = (changed: string, resource = 'configuration') => (f.resources as any).affects({viewId:'view', resource}, changed);
    for (const changed of [path, split, join(split, 'roles', 'developer.yaml'), join(split, 'brains', 'model.yaml'), dirname(path), '/'])
      expect(affects(changed), changed).toBe(true);
    for (const changed of [join(f.root, 'Agent', '.session-events.jsonl'), join(f.root, 'Agent', '.conversation', 'events-000001.jsonl'),
      join(dirname(path), '.codex', 'state_5.sqlite-wal'), join(dirname(path), 'web', 'notification-outboxes', 'checkpoint.json'), split + '-unrelated/roles/a.yaml']) {
      expect(affects(changed), changed).toBe(false);
    }
    expect(affects(join(f.root, 'Agent', '.session-events.jsonl'), 'directory')).toBe(true);
  });
}

it('coalesces unrelated runtime commits without losing a real configuration update', async () => {
  let value = 'initial';
  const project = vi.fn(async () => ({value}));
  const f = fixture(project, '/tmp/config-fairness/fleet.yaml');
  await f.bound(f.register());
  for (let n = 0; n < 40; n++) publishFleetResourceCommit(join(f.root, 'Agent', '.session-events.jsonl'));
  await new Promise(setImmediate);
  expect(project).toHaveBeenCalledTimes(1);
  value = 'committed'; publishFleetResourceCommit('/tmp/config-fairness/fleet/roles/developer.yaml');
  await expect.poll(() => project.mock.calls.length).toBe(2);
  expect(f.response.write.mock.calls.some(([s]) => String(s).includes('"value":"committed"'))).toBe(true);
});

it('serves a real HTTP request before a sustained synchronous projection chain completes', async () => {
  let captures = 0, servedAt = -1, requested: Promise<void> | undefined;
  const total = 80;
  const server = createServer((_request, response) => { servedAt = captures; response.end('ready'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as {port:number};
  const f = fixture(async () => {
    captures++;
    if (!requested) requested = new Promise<void>((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}`, response => {
        response.resume(); response.on('end', resolve);
      }).on('error', reject);
    });
    const until = performance.now() + 2;
    while (performance.now() < until) { /* bounded synchronous canonical projection work */ }
    if (captures < total) publishFleetResourceCommit(join(f.root, 'Agent', '.conversation', 'events-000001.jsonl'));
    return {captures};
  });
  await f.bound(f.register(1, 'directory'));
  await requested;
  await expect.poll(() => captures).toBe(total);
  expect(servedAt).toBeGreaterThan(0);
  expect(servedAt).toBeLessThan(total);
});

it('retires a registration before a queued capture begins', async () => {
  const project = vi.fn(async () => ({})), f = fixture(project);
  const binding = f.register();
  await Promise.resolve(); // Retire after the serialized task starts, during its phase yield.
  f.resources.remove('owner', f.connection.connectionId, 'view', 1);
  await expect(f.bound(binding)).rejects.toThrow('binding mismatch');
  await new Promise(setImmediate);
  expect(project).not.toHaveBeenCalled();
});
