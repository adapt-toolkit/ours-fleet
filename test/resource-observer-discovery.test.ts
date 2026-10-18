import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Count real discovery passes: each pass enumerates every covered directory once.
vi.mock('node:fs', async importOriginal => { const actual = await importOriginal<typeof import('node:fs')>(); return { ...actual, readdirSync: vi.fn(actual.readdirSync) }; });
const { observeFleetResources } = await import('../src/application/resource-observer.js');
const clean: Array<() => void> = [];
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'fleet-discovery-'));
  clean.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const roles = join(root, 'agents'); fs.mkdirSync(roles);
  const controller = new AbortController(); clean.push(() => controller.abort());
  return { root, roles, controller };
}
const fakeWatch = (handles: Map<string, any>) => (path: string, listener: (event: string, name: string | null) => void) => {
  const handle = Object.assign(new EventEmitter(), { close: vi.fn(), listener }); handles.set(path, handle); return handle as any;
};
const passes = (dir: string) => vi.mocked(fs.readdirSync).mock.calls.filter(([path]) => path === dir).length;
const later = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const macrotask = (fn: () => void) => new Promise<void>(resolve => setImmediate(() => { fn(); resolve(); }));

it('bounds discovery passes for native events in separate macrotasks and delivers the last wake', async () => {
  const f = fixture(), handles = new Map<string, any>(), committed: any[] = [];
  for (let i = 0; i < 50; i++) fs.mkdirSync(join(f.roles, `role-${i}`));
  const observer = observeFleetResources({ roots: [f.roles], watch: fakeWatch(handles) }, state => committed.push(state), f.controller.signal);
  const initial = passes(f.roles);
  let ticks = 0; const ticker = setInterval(() => ticks++, 1); clean.push(() => clearInterval(ticker));
  const started = performance.now();
  // Each native callback is its own macrotask; each one used to run a full pass.
  for (let i = 0; i < 1000; i++) await macrotask(() => handles.get(f.roles).listener('change', `role-${i % 50}`));
  const elapsed = performance.now() - started, last = observer.snapshot().position;
  await expect.poll(() => committed.at(-1)?.position).toBe(last);
  await later(150);
  expect(passes(f.roles) - initial).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 2);
  expect(ticks).toBeGreaterThan(0);
  expect(observer.snapshot().health).toBe('healthy');
});

it('a deferred pass covers a directory created inside the window and invalidates conservatively', async () => {
  const f = fixture(), handles = new Map<string, any>(), committed: any[] = [];
  const observer = observeFleetResources({ roots: [f.roles], watch: fakeWatch(handles) }, state => committed.push(state), f.controller.signal);
  const cursor = observer.cursor(path => path.endsWith('events-000001.jsonl'), f.controller.signal);
  handles.get(f.roles).listener('change', 'a.json'); await Promise.resolve();
  const late = join(f.roles, 'late', '.conversation');
  fs.mkdirSync(late, { recursive: true });
  handles.get(f.roles).listener('rename', 'late');
  // Positions and delivery are immediate; discovery waits for the window.
  await Promise.resolve();
  const delivered = committed.length, before = cursor.snapshot().position;
  expect(handles.has(late)).toBe(false);
  // Written before its directory is watched: no native event will report it.
  fs.writeFileSync(join(late, 'events-000001.jsonl'), '{}\n');
  await expect.poll(() => handles.has(late)).toBe(true);
  expect(cursor.snapshot().position).toBeGreaterThan(before);
  await expect.poll(() => committed.length).toBeGreaterThan(delivered);
  expect(committed.at(-1).position).toBe(observer.snapshot().position);
});

it('ignores sustained lock and claim churn in wakes and discovery and still delivers ordinary commits', async () => {
  const f = fixture(), old = process.env.OURS_FLEET_HOME; process.env.OURS_FLEET_HOME = f.root;
  clean.push(() => { if (old === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = old; });
  const { stateRoot } = await import('../src/paths.js');
  const members = join(stateRoot(), 'locks', 'fleet-members'), tasks = join(stateRoot(), 'tasks');
  fs.mkdirSync(join(members, 'held'), { recursive: true }); fs.mkdirSync(tasks, { recursive: true });
  const watched = new Set<string>();
  const observer = observeFleetResources({ watch: (dir, listener) => { watched.add(dir); return fs.watch(dir, { persistent: false }, (event, name) => listener(event, name === null ? null : String(name))); } }, () => {}, f.controller.signal);
  expect(observer.snapshot().health).toBe('healthy');
  expect([...watched].filter(dir => dir.startsWith(join(stateRoot(), 'locks')))).toEqual([]);
  // Cursor positions advance synchronously for every accepted wake under the state root.
  const cursor = observer.cursor(path => path.startsWith(stateRoot()), f.controller.signal);
  for (let i = 0; i < 40; i++) {
    for (const lock of [join(members, 'member'), join(stateRoot(), '.launch-snapshot.lock')]) {
      const claim = `${lock}.claim.${process.pid}.${randomUUID()}`;
      fs.mkdirSync(claim); fs.writeFileSync(join(claim, 'owner.json'), '{}'); fs.renameSync(claim, lock);
      fs.mkdirSync(lock + '.reclaim'); fs.rmSync(lock + '.reclaim', { recursive: true }); fs.rmSync(lock, { recursive: true });
    }
    await later(2);
  }
  await later(150);
  expect(cursor.snapshot().position).toBe(0);
  expect([...watched].filter(dir => dir.startsWith(join(stateRoot(), 'locks')))).toEqual([]);
  fs.writeFileSync(join(tasks, 'task-A.json'), '{}');
  await expect.poll(() => cursor.snapshot().position).toBeGreaterThan(0);
});

it('keeps resources whose names only resemble lock claims', async () => {
  const f = fixture(), handles = new Map<string, any>(), changed = vi.fn();
  const resource = join(f.roles, `report.claim.${process.pid}.${randomUUID()}`); fs.mkdirSync(resource);
  const observer = observeFleetResources({ roots: [f.roles], watch: fakeWatch(handles) }, changed, f.controller.signal);
  expect(handles.has(resource)).toBe(true);
  const cursor = observer.cursor(path => path.startsWith(resource), f.controller.signal);
  handles.get(resource).listener('change', 'events.jsonl');
  expect(cursor.snapshot().position).toBeGreaterThan(0);
  await Promise.resolve(); expect(changed).toHaveBeenCalled();
});

it('fences a pending discovery pass after abort and while failed', async () => {
  const f = fixture(), handles = new Map<string, any>(), changed = vi.fn();
  observeFleetResources({ roots: [f.roles], watch: fakeWatch(handles) }, changed, f.controller.signal);
  handles.get(f.roles).listener('change', 'a.json'); await Promise.resolve();
  handles.get(f.roles).listener('change', 'b.json'); await Promise.resolve();
  const delivered = changed.mock.calls.length, scanned = passes(f.roles);
  f.controller.abort();
  await later(150);
  expect(changed).toHaveBeenCalledTimes(delivered); expect(passes(f.roles)).toBe(scanned);
  const g = fixture(), failing = new Map<string, any>(), states: any[] = [];
  observeFleetResources({ roots: [g.roles], watch: fakeWatch(failing) }, state => states.push(state), g.controller.signal);
  failing.get(g.roles).listener('change', 'a.json'); await Promise.resolve();
  failing.get(g.roles).listener('change', 'b.json'); await Promise.resolve();
  const failedScans = passes(g.roles);
  failing.get(g.roles).emit('error', Error('watch lost'));
  await later(150);
  expect(passes(g.roles)).toBe(failedScans);
  expect(states.at(-1).health).toBe('failed');
});
