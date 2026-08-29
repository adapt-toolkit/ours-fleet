import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditSink } from '../../src/web/audit.js';
import { WebAuth } from '../../src/web/auth.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';
import { loadConfig } from '../../src/config.js';
import { FleetConfigService } from '../../src/web/fleet-config-service.js';
import { TopologyDraftStore, emptyDraft } from '../../src/web/topology-draft-store.js';
import { TopologyPromoteService } from '../../src/web/topology-promote.js';
import { mergeTopology } from '../../src/web/topology-model.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };

const roleItem = (id: string, mission?: string) => ({
  role: {
    id, lifetime: 'permanent', configured: true, stateHealth: 'present',
    configuredBackend: 'acp', detectedBackend: 'acp',
    compatibility: { compatible: true }, problems: [],
    config: mission === undefined ? undefined : { mission },
  },
  status: {
    roleId: id, observedAt: '2026-08-05T00:00:00.000Z', overall: 'ready',
    supervisor: { backend: 'none', liveness: 'running', detail: 'running' },
    session: { backend: 'acp', reachability: 'online', readiness: 'idle', evidence: 'authoritative' },
    restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
    monitor: { mode: 'fleet', health: 'armed', stale: false },
    isolation: { degraded: false }, problems: [],
  },
  capabilities: {},
});

describe('topology draft and promote routes', () => {
  let dir: string;
  let file: string;
  let drafts: TopologyDraftStore;
  let configuration: FleetConfigService;
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-topology-routes-'));
    file = join(dir, 'fleet.yaml');
    previousHome = process.env.OURS_FLEET_HOME;
    process.env.OURS_FLEET_HOME = dir;
    writeFileSync(file, '# operator header\nroles:\n  Alice:\n    session: acp\n    mission: Ship\n', { mode: 0o600 });
    drafts = new TopologyDraftStore({ dir });
    configuration = new FleetConfigService({ configPath: file });
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
    else process.env.OURS_FLEET_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  async function authenticated() {
    const topology = async () => mergeTopology(
      loadConfig(file), loadConfig(file).roles.map(role => roleItem(role.name, role.mission)) as never, drafts.read());
    const audit = new AuditSink(join(dir, 'audit'));
    const events = { publish: vi.fn(), close: vi.fn() };
    const server = await buildWebServer({
      query: { async list() { return loadConfig(file).roles.map(role => roleItem(role.name, role.mission)); } },
      repository: {}, logs: {}, commands: {}, creation: {},
      async session() { return {}; },
      audit, events,
      configuration,
      topology,
      topologyDrafts: drafts,
      topologyPromote: new TopologyPromoteService({ drafts, configuration, topology }),
    } as never, boundary, {
      auth: new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir)),
    });
    const exchange = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/exchange',
      headers: { host: boundary.host, origin: boundary.origin, authorization: `Bootstrap ${server.auth.bootstrapSecret}` },
    });
    const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? [])
      .map(value => value.split(';')[0]).join('; ');
    return { server, cookie, csrf: exchange.json().csrfToken as string, audit, events };
  }

  const sketch = (nodes: unknown[], edges: unknown[] = []) => ({
    ...emptyDraft(), drafts: { nodes, edges },
  });

  it('requires authentication, CSRF and a same-origin request on every mutation', async () => {
    const { server, cookie, csrf } = await authenticated();

    for (const [method, url] of [
      ['GET', '/api/v1/topology/draft'],
      ['PUT', '/api/v1/topology/draft'],
      ['POST', '/api/v1/topology/promote'],
      ['POST', '/api/v1/topology/promote/preview'],
    ] as const) {
      // Same-origin is proven separately below; send it here so this asserts the
      // session guard rather than the boundary check.
      const anonymous = await server.app.inject({
        method, url, headers: { host: boundary.host, origin: boundary.origin }, payload: {},
      });
      expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
    }

    const noCsrf = await server.app.inject({
      method: 'PUT', url: '/api/v1/topology/draft',
      headers: { host: boundary.host, origin: boundary.origin, cookie },
      payload: { revision: drafts.read().revision, draft: emptyDraft() },
    });
    expect(noCsrf.statusCode).toBe(403);

    const crossOrigin = await server.app.inject({
      method: 'POST', url: '/api/v1/topology/promote',
      headers: { host: boundary.host, origin: 'http://evil.example', cookie, 'x-csrf-token': csrf },
      payload: { ids: ['agent:X'], configRevision: 'x' },
    });
    expect(crossOrigin.statusCode).toBe(403);
  });

  it('round-trips a sketch through the draft routes with a revision guard', async () => {
    const { server, cookie, csrf } = await authenticated();
    const headers = { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf };

    const opened = await server.app.inject({ method: 'GET', url: '/api/v1/topology/draft', headers: { host: boundary.host, cookie } });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().draft.drafts.nodes).toEqual([]);
    expect(opened.json().writable).toBe(true);

    const saved = await server.app.inject({
      method: 'PUT', url: '/api/v1/topology/draft', headers,
      payload: {
        revision: opened.json().revision,
        draft: sketch([{ id: 'agent:Reviewer', kind: 'agent', fields: { mission: 'Review' } }]),
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(drafts.read().draft.drafts.nodes).toHaveLength(1);

    const stale = await server.app.inject({
      method: 'PUT', url: '/api/v1/topology/draft', headers,
      payload: { revision: opened.json().revision, draft: emptyDraft() },
    });
    expect(stale.statusCode).toBe(409);

    const invalid = await server.app.inject({
      method: 'PUT', url: '/api/v1/topology/draft', headers,
      payload: {
        revision: drafts.read().revision,
        draft: sketch([{ id: 'agent:A', kind: 'agent', fields: { env: 'SECRET=1' } }]),
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toMatch(/may not store field "env"/);
  });

  it('rejects preview and apply of a retired sketch without changing configuration or drafts', async () => {
    const { server, cookie, csrf, audit, events } = await authenticated();
    const headers = { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf };
    await drafts.write(drafts.read().revision,
      sketch([{ id: 'agent:Reviewer', kind: 'agent', fields: { mission: 'Review pull requests' } }]));

    const body = {
      ids: ['agent:Reviewer'],
      configRevision: configuration.read().revision,
      draftRevision: drafts.read().revision,
    };

    const preview = await server.app.inject({
      method: 'POST', url: '/api/v1/topology/promote/preview', headers, payload: body,
    });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().error).toMatchObject({
      code: 'incompatible_version', retryable: false,
      details: { migration: 'explicit_role_brain_agent_resources' },
    });
    expect(readFileSync(file, 'utf8')).not.toContain('Reviewer');

    const promoted = await server.app.inject({
      method: 'POST', url: '/api/v1/topology/promote', headers, payload: body,
    });
    expect(promoted.statusCode).toBe(409);
    expect(promoted.json().error.code).toBe('incompatible_version');
    expect(readFileSync(file, 'utf8')).not.toContain('Reviewer');
    expect(loadConfig(file).roles.map(role => role.name)).toEqual(['Alice']);
    expect(drafts.read().draft.drafts.nodes).toHaveLength(1);
    expect(events.publish).not.toHaveBeenCalled();
    expect(audit.list().filter(event => event.errorCode === 'incompatible_version')).toHaveLength(2);
  });

  it('does not interpret even an incomplete retired sketch', async () => {
    const { server, cookie, csrf, audit, events } = await authenticated();
    const headers = { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf };
    await drafts.write(drafts.read().revision, sketch([{ id: 'agent:Blank', kind: 'agent', fields: {} }]));

    const response = await server.app.inject({
      method: 'POST', url: '/api/v1/topology/promote', headers,
      payload: { ids: ['agent:Blank'], configRevision: configuration.read().revision },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('incompatible_version');
    expect(readFileSync(file, 'utf8')).not.toContain('Blank');
    expect(events.publish).not.toHaveBeenCalled();
    expect(audit.list().some(event => event.action === 'topology.promote')).toBe(false);
  });

  it('rejects a malformed body before the retired-format boundary and otherwise ignores stale legacy revisions', async () => {
    const { server, cookie, csrf } = await authenticated();
    const headers = { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf };

    const malformed = await server.app.inject({
      method: 'POST', url: '/api/v1/topology/promote', headers, payload: { ids: 'agent:Reviewer' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.message).toMatch(/ids must be a list/);

    await drafts.write(drafts.read().revision,
      sketch([{ id: 'agent:Reviewer', kind: 'agent', fields: { mission: 'Review' } }]));
    const stale = await server.app.inject({
      method: 'POST', url: '/api/v1/topology/promote', headers,
      payload: { ids: ['agent:Reviewer'], configRevision: 'stale' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('incompatible_version');
  });

  it('serves the merged graph with completeness on the read route', async () => {
    const { server, cookie } = await authenticated();
    await drafts.write(drafts.read().revision,
      sketch([{ id: 'agent:Blank', kind: 'agent', fields: {} }]));

    const response = await server.app.inject({
      method: 'GET', url: '/api/v1/topology', headers: { host: boundary.host, cookie },
    });

    const graph = response.json();
    const blank = graph.nodes.find((node: { id: string }) => node.id === 'agent:Blank');
    expect(blank).toMatchObject({ origin: 'draft', complete: false, launchable: false });
    expect(blank.missing[0].field).toBe('mission');
    expect(graph.nodes.find((node: { id: string }) => node.id === 'agent:Alice'))
      .toMatchObject({ origin: 'config', launchable: true });
    expect(typeof graph.draftRevision).toBe('string');
  });
});
