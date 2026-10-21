import { gatewayFixture } from './gateway-fixture.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import { OursClient, OursError, errBoundElsewhere, errNoSuchIdentity, type AttachOursClientOptions,  } from '@ours.network/sdk/client';

import { OURS_BOUND_ELSEWHERE, OursSdkClient, OursSendRefusedError, OursWatchDeadlineError, oursErrorCode,  } from '../src/owner-channel/ours-client.js';


/** A recording stand-in for the SDK client; only the methods under test exist. */
function fakeSdkClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const record = (name: string, result: unknown) => (...args: unknown[]) => {
    calls.push({ name, args: args.length <= 1 ? args[0] : args });
    return Promise.resolve(result);
  };
  const client = {
    calls,
    chooseIdentity: record('chooseIdentity', { name: 'Role-owner', cid: 'x', switchedFrom: null }),
    registerCommands: record('registerCommands', undefined),
    listIncomingMessages: record('listIncomingMessages', []),
    getMessages: record('getMessages', { count: 0, messages: [], remaining: 0 }),
    getHistoryItem: record('getHistoryItem', null),
    getFileInfo: record('getFileInfo', null),
    sendMessage: record('sendMessage', { kind: 'sent', wireId: 'w' }),
    uploadFile: record('uploadFile', {
      upload_id: 'upload-1', filename: 'f', mime: 'application/octet-stream', size: 3,
      sha256: 'hash', at: '2026-08-21T00:00:00Z',
    }),
    sendFile: record('sendFile', { kind: 'sent', wireId: 'w', filename: 'f', bytes: 1, mime: 'text/plain' }),
    fetchFile: record('fetchFile', new Uint8Array([1, 2, 3])),
    releaseLease: record('releaseLease', { released: ['Role-owner'] }),
    close: record('close', undefined),
    ...overrides,
  };
  return client as typeof client & OursClient;
}

async function started(client: ReturnType<typeof fakeSdkClient>): Promise<OursSdkClient> {
  const dir = mkdtempSync(join(tmpdir(), 'owner-sdk-gateway-'));
  const sdk = new OursSdkClient(gatewayFixture(dir).env, () => undefined, {
    attachClient: () => client, readFile: async () => new Uint8Array([1, 2, 3]),
  });
  try { await sdk.start(); } finally { rmSync(dir, { recursive: true, force: true }); }
  return sdk;
}

describe('OursSdkClient send verdicts', () => {
  it('attaches the owner through the complete explicit client profile only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-owner-profile-'));
    try {
      const profilePath = join(dir, 'client.json');
      const credentialPath = join(dir, 'daemon-token');
      const expectedInstanceId = '329f491c-2a4d-41c4-9ecb-22c590d9a466';
      writeFileSync(profilePath, JSON.stringify({ serverUrl: 'http://127.0.0.1:43120',
        endpoint: 'http://127.0.0.1:43120/daemon', expectedInstanceId, credentialPath,
      }), { mode: 0o600 });
      const attached: AttachOursClientOptions[] = [];
      const sdk = new OursSdkClient({ OURS_CONFIG: profilePath }, () => undefined, {
        attachClient: options => { attached.push(options); return fakeSdkClient(); },
      });

      await sdk.start();
      await sdk.close({ releaseLease: false });

      expect(attached).toEqual([{
        endpoint: 'http://127.0.0.1:43120/daemon', expectedInstanceId, credentialPath,
        sessionMode: 'external', leaseToken: expect.stringMatching(/^ours-fleet-owner-/), env: {},
      }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // The legacy connector turned exactly one message verdict into a tool error. The
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

  it('stages outbound bytes through SDK 2 instead of exposing a fleet-private path to the daemon', async () => {
    const client = fakeSdkClient();
    const sdk = await started(client);
    await sdk.sendFile({
      contact: 'owner', path: '/fleet/private/outbox/report.txt', filename: 'report.txt',
      replyToWireId: 'request-wire',
    });
    expect(client.calls.find(call => call.name === 'uploadFile')?.args)
      .toEqual([expect.any(Uint8Array), { filename: 'report.txt', mime: 'text/plain' }]);
    expect(client.calls).toContainEqual({ name: 'sendFile', args: {
      contact: 'owner', upload_id: 'upload-1', filename: 'report.txt',
      reply_to_wire_id: 'request-wire',
    } });
    expect(JSON.stringify(client.calls)).not.toContain('/fleet/private/outbox');
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
    // A second close after successful terminal release is a no-op.
    await expect(sdk.close()).resolves.toBeUndefined();
  });

  it('reports failed terminal release so channel shutdown cannot claim closed', async () => {
    const lines: string[] = [];
    const client = fakeSdkClient({
      releaseLease: async () => { throw new Error('daemon unreachable'); },
    });
    const dir = mkdtempSync(join(tmpdir(), 'owner-sdk-gateway-'));
    const sdk = new OursSdkClient(gatewayFixture(dir).env, line => lines.push(line), { attachClient: () => client });
    await sdk.start();
    await expect(sdk.close()).rejects.toThrow('daemon unreachable');
    expect(lines.some(line => line.includes('lease release failed'))).toBe(true);
  });

  it('retains terminal cleanup after a partial release and retries only on explicit close', async () => {
    let attempts = 0;
    const ownerIds: Array<string | undefined> = [];
    const client = fakeSdkClient({
      releaseLease: async () => ({ released: [], closed: [], attempted: 1,
        notified: 0, failed: ++attempts === 1 ? 1 : 0 }),
    });
    const dir = mkdtempSync(join(tmpdir(), 'owner-sdk-gateway-'));
  const sdk = new OursSdkClient(gatewayFixture(dir).env, () => undefined, {
      attachClient: options => { ownerIds.push(options.leaseToken); return client; },
    });
    await sdk.start();
    await expect(sdk.close()).rejects.toThrow(/incomplete/);
    expect(attempts).toBe(1);
    await sdk.close();
    expect(attempts).toBe(2);
    expect(ownerIds).toHaveLength(2);
    expect(ownerIds[1]).toBe(ownerIds[0]);
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
    const dir = mkdtempSync(join(tmpdir(), 'owner-sdk-gateway-'));
  const sdk = new OursSdkClient(gatewayFixture(dir).env, () => undefined, { attachClient: () => fakeSdkClient() });
    await expect(sdk.getMessages(1)).rejects.toThrow(/is not started/);
  });

  it('maps external-history operations directly to structured SDK calls', async () => {
    const client = fakeSdkClient();
    const sdk = await started(client);
    await sdk.listIncomingMessages();
    await sdk.getMessages(17);
    await sdk.getHistoryItem('message-wire');
    await sdk.getFileInfo('file-wire');
    expect(client.calls).toEqual(expect.arrayContaining([
      { name: 'listIncomingMessages', args: undefined },
      { name: 'getMessages', args: { limit: 17 } },
      { name: 'getHistoryItem', args: { wire_id: 'message-wire' } },
      { name: 'getFileInfo', args: { wire_id: 'file-wire' } },
    ]));
  });

  it('registers typed command metadata and handlers through the SDK client', async () => {
    const client = fakeSdkClient();
    const sdk = await started(client);
    const handler = vi.fn(async () => null);
    const commands = [{ name: 'status', description: 'Session status',
      input_schema: { type: 'object', properties: {} }, handler }];
    await sdk.registerCommands(commands);
    expect(client.calls).toContainEqual({ name: 'registerCommands', args: commands });
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
