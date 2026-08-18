import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  OursClient, OursError, errBoundElsewhere, errNoSuchIdentity,
} from '@ours.network/sdk/client';

import {
  OURS_BOUND_ELSEWHERE, OursSdkClient, OursSendRefusedError, oursErrorCode,
} from '../src/owner-channel/ours-client.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A recording stand-in for the SDK client; only the methods under test exist. */
function fakeSdkClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const record = (name: string, result: unknown) => (args?: unknown) => {
    calls.push({ name, args });
    return Promise.resolve(result);
  };
  const client = {
    calls,
    chooseIdentity: record('chooseIdentity', { name: 'Role-owner', cid: 'x', switchedFrom: null }),
    sendMessage: record('sendMessage', { kind: 'sent', wireId: 'w' }),
    sendFile: record('sendFile', { kind: 'sent', wireId: 'w', filename: 'f', bytes: 1, mime: 'text/plain' }),
    fetchFile: record('fetchFile', new Uint8Array([1, 2, 3])),
    releaseLease: record('releaseLease', { released: ['Role-owner'] }),
    ...overrides,
  };
  return client as typeof client & OursClient;
}

async function started(client: ReturnType<typeof fakeSdkClient>): Promise<OursSdkClient> {
  const sdk = new OursSdkClient({}, () => undefined, { createClient: () => client });
  await sdk.start();
  return sdk;
}

describe('OursSdkClient send verdicts', () => {
  // ours-mcp 0.16.0 turned exactly one message verdict into a tool error. The
  // SDK returns every verdict instead, so an adapter that forgot to re-raise
  // would book a refusal as a delivered owner message.
  it('raises a refused message verdict and accepts every queued one', async () => {
    for (const kind of ['migrating', 'e2e', 'deferred', 'sent', 'introduced']) {
      const client = fakeSdkClient({
        sendMessage: async () => ({ kind, wireId: 'w', cid: 'c', queued: 1, text: 'ok' }),
      });
      const sdk = await started(client);
      await expect(sdk.sendMessage({ contact: 'c', text: 'hi' })).resolves.toBeUndefined();
    }
    const refusing = fakeSdkClient({
      sendMessage: async () => ({ kind: 'refused', wireId: 'w', cid: 'c' }),
    });
    const sdk = await started(refusing);
    await expect(sdk.sendMessage({ contact: 'c', text: 'hi' }))
      .rejects.toBeInstanceOf(OursSendRefusedError);
  });

  // Files are NOT auto-queued behind an encryption migration, which is why the
  // MCP surface reported `migrating` as an error for files and as success for
  // messages. Reporting it as sent would be a false delivery claim.
  it('raises refused and migrating file verdicts only', async () => {
    for (const kind of ['refused', 'migrating']) {
      const client = fakeSdkClient({
        sendFile: async () => ({ kind, wireId: 'w', cid: 'c', queued: 1 }),
      });
      const sdk = await started(client);
      await expect(sdk.sendFile({ contact: 'c', path: '/tmp/f', filename: 'f' }))
        .rejects.toBeInstanceOf(OursSendRefusedError);
    }
    for (const kind of ['e2e', 'deferred', 'sent', 'introduced']) {
      const client = fakeSdkClient({
        sendFile: async () => ({ kind, wireId: 'w', cid: 'c', queued: 1, text: 'ok' }),
      });
      const sdk = await started(client);
      await expect(sdk.sendFile({ contact: 'c', path: '/tmp/f', filename: 'f' }))
        .resolves.toBeUndefined();
    }
  });

  it('never asks the daemon to force a binding, and hands the lease back on close', async () => {
    const client = fakeSdkClient();
    const sdk = await started(client);
    await sdk.bindIdentity('Role-owner');
    expect(client.calls).toContainEqual({
      name: 'chooseIdentity', args: { name: 'Role-owner', force: false },
    });
    await sdk.close();
    expect(client.calls.some(call => call.name === 'releaseLease')).toBe(true);
    // A second close is a no-op, and a shutdown must never fail on the release.
    await expect(sdk.close()).resolves.toBeUndefined();
  });

  it('does not throw out of close when the lease release fails', async () => {
    const lines: string[] = [];
    const client = fakeSdkClient({
      releaseLease: async () => { throw new Error('daemon unreachable'); },
    });
    const sdk = new OursSdkClient({}, line => lines.push(line), { createClient: () => client });
    await sdk.start();
    await expect(sdk.close()).resolves.toBeUndefined();
    expect(lines.some(line => line.includes('lease release failed'))).toBe(true);
  });

  // A refusal is relayed to the managed agent as `relayRefused(errorText)`, so
  // its text leaves the host. It must describe the verdict and nothing else.
  it('keeps the contact CID, the body and the filename out of a refusal', async () => {
    const secret = 'OWNER_BODY_MUST_NOT_LEAK';
    const cid = 'A'.repeat(64);
    const message = await started(fakeSdkClient({
      sendMessage: async () => ({ kind: 'refused', wireId: 'w', cid }),
    })).then(sdk => sdk.sendMessage({ contact: cid, text: secret }).catch(error => error as Error));
    const file = await started(fakeSdkClient({
      sendFile: async () => ({ kind: 'refused', wireId: 'w', cid }),
    })).then(sdk => sdk.sendFile({ contact: cid, path: `/tmp/${secret}`, filename: secret })
      .catch(error => error as Error));
    for (const error of [message, file]) {
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(cid);
      expect(error.message).toMatch(/end-to-end session must be re-established/);
    }
  });

  it('refuses to operate before start', async () => {
    const sdk = new OursSdkClient({}, () => undefined, { createClient: () => fakeSdkClient() });
    await expect(sdk.getMessages()).rejects.toThrow(/is not started/);
  });
});

describe('daemon error classification', () => {
  // The bind handoff used to be gated on /currently bound to another live
  // session/i. Any error carrying that wording — including one relayed from a
  // peer — extended the retry window; only the daemon's own code may now.
  it('reads the typed code and refuses to infer one from prose', () => {
    expect(oursErrorCode(errBoundElsewhere('Role-owner'))).toBe(OURS_BOUND_ELSEWHERE);
    expect(oursErrorCode(errNoSuchIdentity('Role-owner'))).toBe('NO_SUCH_IDENTITY');
    expect(errBoundElsewhere('Role-owner').message)
      .toMatch(/currently bound to another live session/);
    expect(oursErrorCode(
      new Error('choose_identity declined: currently bound to another live session'))).toBeUndefined();
    expect(oursErrorCode('BOUND_ELSEWHERE')).toBeUndefined();
    expect(oursErrorCode(undefined)).toBeUndefined();
  });

  it('accepts a structurally identical OursError from a duplicated SDK copy', () => {
    const duplicate = new Error('bound elsewhere');
    duplicate.name = 'OursError';
    (duplicate as { code?: string }).code = OURS_BOUND_ELSEWHERE;
    expect(oursErrorCode(duplicate)).toBe(OURS_BOUND_ELSEWHERE);
    expect(new OursError('NOT_BOUND', 'x').name).toBe('OursError');
  });
});

describe('owner-channel daemon dependency surface', () => {
  it('is pinned to the reviewed SDK version exactly', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
    expect(pkg.dependencies['@ours.network/sdk']).toBe('1.7.0');
    expect(lock.packages['node_modules/@ours.network/sdk'].version).toBe('1.7.0');
  });

  it('imports only the documented client subpath, never daemon-side SDK code', async () => {
    const sources = await collectSources(join(REPO, 'src'));
    const specifiers = new Set<string>();
    for (const file of sources)
      for (const spec of importSpecifiers(await readFile(file, 'utf8')))
        if (spec.startsWith('@ours.network/sdk')) specifiers.add(spec);
    expect([...specifiers]).toEqual(['@ours.network/sdk/client']);
  });

  // The SDK ships the MUFL engine and its @adapt-toolkit native packages for
  // daemon-side use. Fleet is a client: if any of that reaches the owner
  // channel's runtime graph, the channel has started importing the daemon.
  it('resolves a client runtime graph free of @adapt-toolkit and daemon modules', async () => {
    // Resolve the documented subpath through the package's own export map, so
    // this also asserts that `/client` is a real entry and not a deep import.
    const pkgRoot = join(REPO, 'node_modules', '@ours.network', 'sdk');
    const exports = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8')).exports;
    const entry = join(pkgRoot, exports['./client'].default);
    const seen = new Set<string>([entry]);
    const queue = [entry];
    const bare: string[] = [];
    while (queue.length) {
      const file = queue.pop()!;
      for (const spec of importSpecifiers(await readFile(file, 'utf8'))) {
        if (spec.startsWith('node:')) continue;
        if (!spec.startsWith('.')) { bare.push(spec); continue; }
        const next = resolve(dirname(file), spec);
        const path = extname(next) ? next : `${next}.js`;
        if (seen.has(path)) continue;
        seen.add(path);
        queue.push(path);
      }
    }
    expect(bare.filter(spec => spec.startsWith('@adapt-toolkit'))).toEqual([]);
    expect(bare.filter(spec => spec.startsWith('@ours.network/sdk/'))).toEqual([]);
    expect(seen.size).toBeGreaterThan(1);
    expect(pathToFileURL(entry).href).toContain('@ours.network/sdk');
  });
});

async function collectSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectSources(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Every static `from '<spec>'` and `import('<spec>')` in a module. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns)
    for (const match of source.matchAll(pattern)) out.push(match[1]);
  return out;
}
