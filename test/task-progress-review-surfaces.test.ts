/**
 * Task Progress and To review through the surfaces agents and browsers use:
 * the real managed MCP endpoint and bridge, the real built CLI under a real
 * supervisor audit socket, and the authenticated HTTP API.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { OursClient } from '@ours.network/sdk/client';
import type { ApplicationIdentityStore } from '@ours.network/mcp/application-identities';
import { startMcpEndpoint } from '../src/agent-ours/mcp-endpoint.js';
import { taskToolBinding } from '../src/agent-ours/service.js';
import type { AgentOursRuntime } from '../src/agent-ours/runtime.js';
import { prepareTempSupervisor } from '../src/temp-lifecycle.js';
import { createTask, getTask, tasksDir } from '../src/rooms-tasks/task-state.js';
import { FleetCommandAuditStore } from '../src/fleet-command-audit.js';
import { RoleControlServer } from '../src/session/control.js';
import { buildWebServer } from '../src/web/server.js';
import { WebAuth } from '../src/web/auth.js';
import { TrustedDeviceStore } from '../src/web/device-store.js';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import { writeV2Fixture } from './v2-fixture.js';

const CLI = resolve('dist/cli.js');
const CID = 'D'.repeat(64);
let root: string, oldHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-surfaces-'));
  oldHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
  writeV2Fixture(join(root, 'fleet.yaml'), {});
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

function withMembers(taskId: string, members: Array<{ name: string; identity_cid: string }>) {
  const path = join(tasksDir(), `${taskId}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.member_roles = members.map(member => ({ ...member, slot: member.name, cowork_role: 'member' }));
  writeFileSync(path, JSON.stringify(record));
}

async function bridge(binding: () => ReturnType<typeof taskToolBinding>, fenced = { value: false }) {
  const dir = mkdtempSync(join(root, 'bridge-'));
  const endpoint = await startMcpEndpoint({
    socket: join(dir, 'm.sock'), capability: 'task-capability', generation: 1,
    runtime: { admit: async () => { if (fenced.value) throw Error('RUNTIME_NOT_READY'); return () => {}; } } as unknown as AgentOursRuntime,
    client: {} as OursClient,
    identities: { list: async () => ['Agent'] } as ApplicationIdentityStore,
    remoteDaemonFiles: true,
    task: binding,
  });
  const descriptor = join(dir, 'descriptor.json');
  writeFileSync(descriptor, JSON.stringify({ socket: join(dir, 'm.sock'), capability: 'task-capability', generation: 1 }));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve('dist/agent-ours/bridge.js')], cwd: dir,
    env: { FLEET_OURS_BRIDGE_DESCRIPTOR: descriptor }, stderr: 'pipe',
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  return { client, call, close: async () => { await client.close(); await endpoint.close(); } };
}
const error = (response: any) => JSON.parse(response.content[0].text).error;

async function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH, HOME: root, OURS_FLEET_HOME: root, OURS_FLEET_SOCKET_ROOT: process.env.OURS_FLEET_SOCKET_ROOT, ...env } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done); });
  return { status, stdout, stderr };
}

describe('agent MCP tools', { timeout: 60_000 }, () => {
  it('reads and writes only the task the supervisor bound, attributed to the bound agent', async () => {
    const task = createTask({ title: 'bound', origin: { type: 'cli' } });
    const other = createTask({ title: 'other', origin: { type: 'cli' } });
    withMembers(task.task_id, [{ name: 'dev-1', identity_cid: CID }]);
    const stateDir = mkdtempSync(join(root, 'role-'));
    let role: any = { name: 'dev-1' };
    const fenced = { value: false };
    const mcp = await bridge(() => taskToolBinding(role, stateDir, CID), fenced);
    try {
      const names = (await mcp.client.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['fleet_task_progress_list', 'fleet_task_progress_append',
        'fleet_task_review_show', 'fleet_task_review_set', 'fleet_task_review_clear', 'fleet_task_review_detach']));
      expect(error(await mcp.call('fleet_task_progress_append', { text: 'x' }))).toBe('task_unavailable');

      role = { name: 'dev-1', roomMemberStartup: { task_id: task.task_id } };
      // A task_id argument is not part of the contract and cannot redirect the write.
      const appended = await mcp.call('fleet_task_progress_append', { text: 'PR opened: https://example.test/pr/7', request_key: 'pr-7', task_id: other.task_id });
      expect(appended.isError).toBe(false);
      expect(appended.structuredContent).toMatchObject({ task_id: task.task_id, replayed: false,
        entry: { text: 'PR opened: https://example.test/pr/7', author: { kind: 'agent', role: 'dev-1', identity_cid: CID, surface: 'mcp' } } });
      expect((await mcp.call('fleet_task_progress_append', { text: 'PR opened: https://example.test/pr/7', request_key: 'pr-7' })).structuredContent.replayed).toBe(true);
      expect(error(await mcp.call('fleet_task_progress_append', { text: 'changed', request_key: 'pr-7' }))).toBe('idempotency_conflict');
      expect(error(await mcp.call('fleet_task_progress_append', { text: '   ' }))).toBe('invalid_request');
      const long = await mcp.call('fleet_task_progress_append', { text: 'é'.repeat(401), request_key: 'long' });
      expect(error(long)).toBe('invalid_request');
      expect(long.content[0].text).toMatch(/401 Unicode characters \(code points\); the maximum is 400\. Nothing was saved/);
      expect((await mcp.call('fleet_task_progress_list')).structuredContent.progress).toHaveLength(1);
      expect(getTask(other.task_id).progress).toBeUndefined();

      expect((await mcp.call('fleet_task_review_set', { markdown: '## Outcome', expected_markdown: '' })).structuredContent.review.markdown).toBe('## Outcome');
      expect(error(await mcp.call('fleet_task_review_set', { markdown: 'stale', expected_markdown: '' }))).toBe('conflict');
      expect((await mcp.call('fleet_task_review_show')).structuredContent.review).toMatchObject({ markdown: '## Outcome', artifacts: [] });
      expect(error(await mcp.call('fleet_task_review_detach', { artifact_id: '00000000-0000-0000-0000-000000000000' }))).toBe('not_found');
      const revision = (await mcp.call('fleet_task_review_show')).structuredContent.review.revision;
      expect(error(await mcp.call('fleet_task_review_clear', { expected_revision: revision - 1 }))).toBe('conflict');
      expect((await mcp.call('fleet_task_review_show')).structuredContent.review.markdown).toBe('## Outcome');
      expect((await mcp.call('fleet_task_review_clear', { expected_revision: revision })).structuredContent)
        .toMatchObject({ task_id: task.task_id, removed: [], review: { revision: revision + 1, markdown: '', artifacts: [],
          updated_by: { kind: 'agent', role: 'dev-1', identity_cid: CID, surface: 'mcp' } } });
      expect(getTask(other.task_id).review).toBeUndefined();

      // A listed member with another identity, or an unlisted non-task launch, is refused.
      withMembers(task.task_id, [{ name: 'dev-1', identity_cid: 'E'.repeat(64) }]);
      expect(error(await mcp.call('fleet_task_progress_append', { text: 'impostor' }))).toBe('conflict');
      withMembers(task.task_id, []);
      expect(error(await mcp.call('fleet_task_progress_append', { text: 'not a member' }))).toBe('conflict');
      // A task-owned launch (layout participant) is bound by its supervisor record.
      role = { name: 'dev-1' };
      prepareTempSupervisor(stateDir, 'dev-1', { taskId: task.task_id, layout: { runId: `task-${task.task_id}`, participant: 'dev' }, creationActionId: 'action' } as any);
      expect((await mcp.call('fleet_task_progress_append', { text: 'layout milestone' })).isError).toBe(false);

      fenced.value = true;
      expect(error(await mcp.call('fleet_task_progress_append', { text: 'fenced' }))).toBe('runtime_not_ready');
      fenced.value = false;
      expect(getTask(task.task_id).progress!.map(entry => entry.text)).toEqual(['PR opened: https://example.test/pr/7', 'layout milestone']);
    } finally { await mcp.close(); }
  });
});

describe('agent MCP progress paging', { timeout: 60_000 }, () => {
  it('returns every entry of a maximal log in order through the real bridge, in bounded pages', async () => {
    const task = createTask({ title: 'paging', origin: { type: 'cli' } });
    withMembers(task.task_id, [{ name: 'dev-1', identity_cid: CID }]);
    const { appendTaskProgress, PROGRESS_MAX_ENTRIES, PROGRESS_TEXT_MAX } = await import('../src/rooms-tasks/task-review.js');
    // Worst cases for serialized size: astral characters and control characters that JSON escapes.
    const texts = Array.from({ length: PROGRESS_MAX_ENTRIES }, (_, index) => index % 2
      ? '😀'.repeat(PROGRESS_TEXT_MAX)
      : `${index}\u0001`.padEnd(PROGRESS_TEXT_MAX, '\u0001'));
    for (const text of texts) appendTaskProgress(task.task_id, { text, author: { kind: 'local_control', surface: 'cli' } });
    const mcp = await bridge(() => ({ taskId: task.task_id, role: 'dev-1', identityCid: CID, taskOwned: false }));
    try {
      const read: string[] = [];
      let after: string | undefined, pages = 0;
      do {
        const page = await mcp.call('fleet_task_progress_list', after ? { after } : {});
        expect(page.isError, JSON.stringify(page).slice(0, 200)).toBe(false);
        expect(page.structuredContent.total).toBe(PROGRESS_MAX_ENTRIES);
        expect(page.structuredContent.progress.length).toBeGreaterThan(0);
        read.push(...page.structuredContent.progress.map((entry: any) => entry.text));
        after = page.structuredContent.next_after; pages++;
      } while (after);
      expect(read).toEqual(texts);
      expect(pages).toBeGreaterThanOrEqual(4);
      expect(error(await mcp.call('fleet_task_progress_list', { after: 'missing' }))).toBe('invalid_request');
      expect(error(await mcp.call('fleet_task_progress_list', { limit: 0 }))).toBe('invalid_request');
      const two = await mcp.call('fleet_task_progress_list', { limit: 2 });
      expect(two.structuredContent.progress).toHaveLength(2);
      // The largest review Markdown also fits one response.
      const markdown = '\u0001'.repeat(50_000);
      expect((await mcp.call('fleet_task_review_set', { markdown, expected_markdown: '' })).isError).toBe(false);
      expect((await mcp.call('fleet_task_review_show')).structuredContent.review.markdown).toBe(markdown);
    } finally { await mcp.close(); }
  });
});

describe('task CLI', { timeout: 120_000 }, () => {
  it('attributes a supervisor-verified managed agent and the local operator, and retains attached files', async () => {
    const task = createTask({ title: 'cli', origin: { type: 'cli' } });
    withMembers(task.task_id, [{ name: 'Fixture', identity_cid: CID }]);
    const state = join(root, 'role'); mkdirSync(state);
    const audit = new FleetCommandAuditStore(join(state, 'audit.json'));
    const control = new RoleControlServer(state, {}, () => {});
    control.setFleetAuditor({
      async begin(requestId, argv) { return audit.invocation(audit.begin(requestId, 'Fixture', argv).correlationId, 'Fixture', 'delivered'); },
      async finish({ correlationId, ...outcome }) { audit.finish(correlationId, 'Fixture', outcome); return audit.outcome(correlationId, 'Fixture', 'delivered'); },
      async present() {},
    });
    await control.start();
    try {
      const managed = { OURS_FLEET_PROXY_CALLER: 'Fixture', OURS_FLEET_PROXY_STATE_DIR: state };
      const appended = await runCli(['task', 'progress', task.task_id, '--text', 'Root cause found\n  in cache', '--request-key', 'rc', '--json'], managed);
      expect(appended.stderr).toBe('');
      expect(JSON.parse(appended.stdout).entry).toMatchObject({ text: 'Root cause found\n  in cache', author: { kind: 'agent', role: 'Fixture', identity_cid: CID, surface: 'cli' } });
      // The milestone text is redacted from the supervisor's command ledger like other free text.
      expect(JSON.stringify(audit.list())).not.toContain('Root cause found');
      const operator = await runCli(['task', 'progress', task.task_id, '--text', 'Operator note', '--json']);
      expect(JSON.parse(operator.stdout).entry.author).toEqual({ kind: 'local_control', surface: 'cli' });
      const listed = await runCli(['task', 'progress', task.task_id, '--json']);
      expect(JSON.parse(listed.stdout).progress.map((entry: any) => entry.text)).toEqual(['Root cause found\n  in cache', 'Operator note']);
      writeFileSync(join(root, 'long.txt'), `${'x'.repeat(400)}\n`);
      const long = await runCli(['task', 'progress', task.task_id, '--text-file', join(root, 'long.txt')], managed);
      expect(long.status).not.toBe(0);
      expect(long.stderr).toMatch(/401 Unicode characters \(code points\); the maximum is 400\. Nothing was saved/);
      expect(getTask(task.task_id).progress).toHaveLength(2);

      writeFileSync(join(task.workspace!.path, 'spec.md'), '# Spec');
      writeFileSync(join(root, 'review.md'), '## Outcome\n\n[PR](https://example.test/pr/9)');
      const prepared = await runCli(['task', 'review-package', task.task_id, '--markdown-file', join(root, 'review.md'),
        '--attach', join(task.workspace!.path, 'spec.md'), '--request-key', 'spec', '--json'], managed);
      expect(prepared.stderr).toBe('');
      const review = JSON.parse(prepared.stdout).review;
      expect(review).toMatchObject({ markdown: '## Outcome\n\n[PR](https://example.test/pr/9)', updated_by: { kind: 'agent', role: 'Fixture' },
        artifacts: [{ name: 'spec.md', mime: 'text/markdown', size: 6, added_by: { kind: 'agent', role: 'Fixture', surface: 'cli' } }] });
      const outside = await runCli(['task', 'review-package', task.task_id, '--attach', join(root, 'review.md')], managed);
      expect(outside.status).not.toBe(0);
      expect(outside.stderr).toMatch(/inside the task workspace/);
      expect(getTask(task.task_id).review!.artifacts).toHaveLength(1);

      // Clear the resolved request and write the next one in a single fenced call.
      const shown = await runCli(['task', 'review-package', task.task_id]);
      const revision = Number(/\(revision (\d+)\)/.exec(shown.stdout)![1]);
      expect(revision).toBe(getTask(task.task_id).review!.revision);
      const stale = await runCli(['task', 'review-package', task.task_id, '--clear', '--expected-revision', String(revision - 1)], managed);
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toMatch(/changed elsewhere/);
      expect(getTask(task.task_id).review!.artifacts).toHaveLength(1);
      expect((await runCli(['task', 'review-package', task.task_id, '--clear'], managed)).stderr).toMatch(/go together/);
      writeFileSync(join(root, 'next.md'), 'Owner decision: choose the rollout window.');
      const replaced = await runCli(['task', 'review-package', task.task_id, '--clear', '--expected-revision', String(revision),
        '--markdown-file', join(root, 'next.md'), '--json'], managed);
      expect(replaced.stderr).toBe('');
      expect(JSON.parse(replaced.stdout).review).toMatchObject({ revision: revision + 2, markdown: 'Owner decision: choose the rollout window.', artifacts: [] });
    } finally { await control.close(); }
  });
});

describe('HTTP API', () => {
  it('serves counts in task payloads, bodies on their own routes and retained bytes only to authenticated callers', async () => {
    const task = createTask({ title: 'http', origin: { type: 'cli' } });
    const other = createTask({ title: 'other', origin: { type: 'cli' } });
    const { appendTaskProgress, attachTaskReviewArtifact, openTaskWorkspaceFile, setTaskReviewMarkdown } = await import('../src/rooms-tasks/task-review.js');
    appendTaskProgress(task.task_id, { text: 'milestone', author: { kind: 'agent', role: 'dev-1', surface: 'mcp' } });
    setTaskReviewMarkdown(task.task_id, { markdown: '[Spec](https://example.test/spec)', expectedMarkdown: '', author: { kind: 'local_control', surface: 'cli' } });
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
    writeFileSync(join(task.workspace!.path, 'data.bin'), bytes);
    const source = await openTaskWorkspaceFile(getTask(task.task_id), join(task.workspace!.path, 'data.bin'));
    const { artifact } = await attachTaskReviewArtifact(task.task_id, { name: 'my "data".bin', source, author: { kind: 'local_control', surface: 'cli' } });

    const boundary = { origin: 'http://127.0.0.1:49272', host: '127.0.0.1:49272' };
    const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(join(root, 'auth')));
    const server = await buildWebServer({ taskRooms: new TaskRoomApplicationService(undefined) } as any, boundary, { auth });
    try {
      const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange', headers: { host: boundary.host, origin: boundary.origin, authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
      const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
      const headers = { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': exchange.json().csrfToken };
      const anonymous = { host: boundary.host, origin: boundary.origin };
      const get = (url: string, h: Record<string, string> = headers) => server.app.inject({ method: 'GET', url, headers: h });

      const listed = (await get('/api/v1/tasks')).json().tasks.find((item: any) => item.task_id === task.task_id);
      expect(listed).toMatchObject({ progress_count: 1, review: { has_markdown: true, artifact_count: 1 } });
      expect(listed.progress).toBeUndefined();
      const detail = (await get(`/api/v1/tasks/${task.task_id}`)).json().task;
      expect(detail).toMatchObject({ progress_count: 1, review: { artifact_count: 1 } });
      expect(detail.review.markdown).toBeUndefined();
      expect((await get(`/api/v1/tasks/${other.task_id}`)).json().task).toMatchObject({ progress_count: 0, review: { has_markdown: false, artifact_count: 0 } });

      expect((await get(`/api/v1/tasks/${task.task_id}/progress`, anonymous)).statusCode).toBe(401);
      expect((await get(`/api/v1/tasks/${task.task_id}/progress`)).json().progress).toEqual([expect.objectContaining({ text: 'milestone', unread: true, author: { kind: 'agent', role: 'dev-1', surface: 'mcp' } })]);
      expect((await get(`/api/v1/tasks/${task.task_id}/review`)).json().review).toMatchObject({ markdown: '[Spec](https://example.test/spec)', artifacts: [{ id: artifact.id, name: 'my "data".bin' }] });
      expect((await get(`/api/v1/tasks/${other.task_id}/review`)).json()).toEqual({ review: null });

      const url = `/api/v1/tasks/${task.task_id}/review/artifacts/${artifact.id}`;
      expect((await get(url, anonymous)).statusCode).toBe(401);
      const download = await get(url);
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload).toEqual(bytes);
      expect(download.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': `attachment; filename*=UTF-8''my%20%22data%22.bin` });
      expect((await get(`/api/v1/tasks/${other.task_id}/review/artifacts/${artifact.id}`)).statusCode).toBe(404);
      expect((await get(`/api/v1/tasks/..%2F${task.task_id}/review/artifacts/${artifact.id}`)).statusCode).toBe(404);
      expect((await get(`/api/v1/tasks/${task.task_id}/review/artifacts/..%2Fx`)).statusCode).toBe(404);

      const post = (payload: unknown, h: Record<string, string> = headers) => server.app.inject({ method: 'POST', url: `/api/v1/tasks/${task.task_id}/progress`, headers: h, payload: payload as any });
      expect((await post({ text: 'no csrf' }, { host: boundary.host, origin: boundary.origin, cookie })).statusCode).toBe(403);
      expect((await post({ text: 3 })).statusCode).toBe(400);
      const long = await post({ text: '😀'.repeat(401) });
      expect(long.statusCode).toBe(400);
      expect(long.body).toMatch(/401 Unicode characters/);
      expect((await post({ text: '😀'.repeat(400) })).statusCode).toBe(201);
      const created = await post({ text: 'web milestone', requestKey: 'w1' });
      expect(created.statusCode).toBe(201);
      expect(created.json().entry.author).toEqual({ kind: 'local_control', surface: 'web' });
      const replay = await post({ text: 'web milestone', requestKey: 'w1' });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true, entry: { id: created.json().entry.id } });
      expect((await post({ text: 'changed', requestKey: 'w1' })).statusCode).toBe(409);

      const put = (payload: unknown) => server.app.inject({ method: 'PUT', url: `/api/v1/tasks/${task.task_id}/review`, headers, payload: payload as any });
      expect((await put({ markdown: 'lost', expectedMarkdown: '' })).statusCode).toBe(409);
      expect((await put({ markdown: 'v2', expectedMarkdown: '[Spec](https://example.test/spec)' })).json().review.markdown).toBe('v2');
      expect((await server.app.inject({ method: 'GET', url: '/api/v1/meta', headers })).json().api).toEqual({ major: 1, minor: 1 });
    } finally { await server.app.close(); }
  });
});
