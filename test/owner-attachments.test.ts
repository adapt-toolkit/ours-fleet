import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OwnerAttachmentConfig, OwnerChannelConfig } from '../src/config.js';
import {
  AttachmentRecoveryState, admitAttachments, cleanupAttachmentRoot, prepareAttachmentDirectory,
  parseRetrievedAttachments, sanitizeFilename, validateAttachmentSelection,
  validateAttachmentRelaySelection, writeRecoveredAttachment,
  type IncomingAttachment, type RetrievedAttachment,
} from '../src/owner-channel/attachments.js';
import { OwnerChannel } from '../src/owner-channel/channel.js';
import type {
  OursContactsView, OursInboundMessage, OursIncomingFile, OursOps, OursRetrievedFile,
} from '../src/owner-channel/ours-client.js';
import { OwnerConversationState } from '../src/owner-channel/state.js';
import type { QueuedPrompt, SessionHandle, TurnResult } from '../src/session/types.js';
import { historyFile, historyMessage, incomingMessage } from './owner-history-fixtures.js';

const OWNER = 'A'.repeat(64);
const OTHER = 'B'.repeat(64);
const AGENT = 'C'.repeat(64);
const FILE_WIRE = '1'.repeat(64);
const CAPTION_WIRE = '2'.repeat(64);
const dirs: string[] = [];
const attachmentConfig: OwnerAttachmentConfig = {
  enabled: true, max_files_per_request: 4, max_file_bytes: 1_024,
  max_request_bytes: 2_048, retention_ms: 60_000,
};

const EMPTY_CONTACTS: OursContactsView = {
  contacts: [], pending: [], roots: {}, degraded: [], renames: {},
};

class AttachmentClient implements OursOps {
  calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  batches: unknown[][] = [];
  files: unknown[] = [];
  retrieved = new Map<string, Record<string, unknown>>();
  messageHistory = new Map<string, OursInboundMessage>();
  failText?: string;
  failFile = false;
  failTools = new Set<string>();
  async start() {}
  async close() {}
  async bindIdentity(name: string) { this.record('bindIdentity', { name }); }
  async listContacts() { this.record('listContacts'); return EMPTY_CONTACTS; }
  async generateInvite(name?: string) {
    this.record('generateInvite', { name });
    return { blob: 'blob', inviteId: 'invite-1', mode: 'one_time' as const };
  }
  async addContact(a: { invite: string; name?: string }) {
    this.record('addContact', { ...a });
    return { display: a.name ?? 'Peer', cid: OTHER };
  }
  async listIncomingMessages() {
    this.record('listIncomingMessages');
    const batch = this.batches[0] ?? [];
    if (!batch.length) this.batches.shift();
    return batch.map((item, index) => {
      const persistent = historyMessage(item, index + 1);
      this.messageHistory.set(persistent.wire_id, persistent);
      return incomingMessage(item, index + 1);
    });
  }
  async getMessages(limit: number) {
    this.record('getMessages', { limit });
    const batch = this.batches.shift() ?? [];
    const messages = batch.slice(0, limit).map((item, index) => historyMessage(item, index + 1));
    for (const message of messages) this.messageHistory.set(message.wire_id, message);
    if (batch.length > limit) this.batches.unshift(batch.slice(limit));
    return { count: messages.length, messages, remaining: Math.max(0, batch.length - limit) };
  }
  async getHistoryItem(wireId: string) {
    this.record('getHistoryItem', { wireId });
    return this.messageHistory.get(wireId) ?? null;
  }
  async *watchNotifications(
    _identity: string, options?: { since?: number | 'tip'; signal?: AbortSignal },
  ) {
    await new Promise<void>(resolve => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  async listIncomingFiles() {
    this.record('listIncomingFiles');
    return this.files as OursIncomingFile[];
  }
  async getFileInfo(wireId: string) {
    this.record('getFileInfo', { wireId });
    const item = this.retrieved.get(wireId) ?? this.files.find(value =>
      String((value as Record<string, unknown>).wire_id ?? '') === wireId);
    return item ? historyFile(item) : null;
  }
  async getFiles(wireIds: string[]) {
    this.record('getFiles', { wireIds });
    return {
      files: wireIds.map(wire => this.retrieved.get(wire)) as OursRetrievedFile[],
      text: '', mode: 'selected' as const, requested: wireIds,
    };
  }
  async fetchFile(wireId: string) {
    this.record('fetchFile', { wireId });
    return readFileSync(String(this.retrieved.get(wireId)?.path));
  }
  async sendMessage(a: { contact: string; text: string; replyToWireId?: string }) {
    this.record('sendMessage', { ...a });
    if (a.text === this.failText) throw new Error('transport unavailable');
  }
  async sendFile(a: { contact: string; path: string; filename: string; replyToWireId?: string }) {
    this.record('sendFile', { ...a });
    if (this.failFile) throw new Error('file transport unavailable');
  }
  private record(name: string, args?: Record<string, unknown>): void {
    this.calls.push({ name, args });
    if (this.failTools.has(name)) throw new Error(`${name} failed`);
  }
}

function listed(overrides: Record<string, unknown> = {}) {
  return {
    file_id: 7, wire_id: FILE_WIRE, from: { id: OWNER, name: 'Phone' },
    filename: 'notes.txt', mime: 'text/plain', size: 5, status: 'unread',
    date: '2026-08-03T12:00:00Z', sha256: null, reply_to: null, kind: 'file',
    ...overrides,
  };
}

function retrieved(source: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    ...listed(), path: source, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), status: 'read',
    sender: 'Phone', ...overrides,
  };
}

function deferredPrompt() {
  let finish!: (result: TurnResult) => void;
  const queued: QueuedPrompt = {
    promptId: 'attachment-turn', queuedBehind: 0,
    completion: new Promise(resolve => { finish = resolve; }),
  };
  return { queued, finish };
}

async function setup(
  owners = [OWNER], recover = false, attachments = attachmentConfig, agent?: string,
  existingDir?: string, prepare?: (client: AttachmentClient) => void, start = true,
) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'ours-owner-attachments-'));
  if (!existingDir) dirs.push(dir);
  const client = new AttachmentClient();
  prepare?.(client);
  const pending = deferredPrompt();
  const queuePrompt = vi.fn(async () => pending.queued);
  const session = {
    backend: 'acp', pid: 1, isAlive: () => true,
    snapshot: () => ({ backend: 'acp', alive: true, readiness: 'running' }),
    queuePrompt, interrupt: vi.fn(), eventsSince: () => [],
  } as unknown as SessionHandle;
  const config: OwnerChannelConfig = {
    identity: 'Role-owner', owners, interrupt: false, progress_interval_ms: 0,
    attachments, ...(agent ? { agent } : {}),
  };
  if (recover) new AttachmentRecoveryState(join(dir, '.owner-channel-attachment-recovery.json')).add({
    id: createHash('sha256').update(FILE_WIRE).digest('hex'), contact: OWNER,
    originWireId: FILE_WIRE, fileWireIds: [FILE_WIRE], createdAt: Date.now(),
  });
  const logs: string[] = [];
  const channel = new OwnerChannel({
    role: 'Role', harness: 'claude-code', config, session, stateDir: dir, client, log: line => logs.push(line),
  });
  if (start) {
    await channel.start();
    await channel.drain();
  }
  return { dir, client, channel, queuePrompt, logs, ...pending };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('owner-channel attachment ingress', () => {
  it('fails closed when a journaled file is absent from persistent history', async () => {
    const status = await setup(
      [OWNER], true, attachmentConfig, undefined, undefined, undefined, false);
    await expect(status.channel.drain()).rejects.toThrow(/missing from persistent history/);
    expect(status.queuePrompt).not.toHaveBeenCalled();
  });

  it('handles a file-only wake, admits bytes privately, and cleans up after exact-wire delivery', async () => {
    const status = await setup();
    const bytes = Buffer.from('hello');
    const source = join(status.dir, 'daemon-source');
    writeFileSync(source, bytes);
    status.client.files = [listed()];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes));

    await status.channel.drain();
    expect(status.client.calls).toContainEqual({ name: 'getFiles', args: { wireIds: [FILE_WIRE] } });
    const prompt = String(status.queuePrompt.mock.calls[0][0]);
    expect(prompt).toContain('notes.txt');
    expect(prompt).toContain('detected MIME: text/plain');
    const admittedPath = prompt.match(/request-scoped local path: (.+)/)?.[1];
    expect(admittedPath).toBeTruthy();
    expect(lstatSync(admittedPath!).mode & 0o777).toBe(0o600);
    expect(readFileSync(admittedPath!, 'utf8')).toBe('hello');

    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Reviewed.' });
    await vi.waitFor(() => expect(status.client.calls).toContainEqual({ name: 'sendMessage', args: {
      contact: OWNER, text: 'Reviewed.', replyToWireId: FILE_WIRE,
    } }));
    await vi.waitFor(() => expect(() => lstatSync(admittedPath!)).toThrow());
    expect(readFileSync(join(status.dir, '.owner-channel-state.json'), 'utf8')).not.toContain('hello');
    await status.channel.close();
  });

  it.each([
    ['succeeded', 'Transcribed owner instruction.', 'voice transcript: Transcribed owner instruction.'],
    ['unavailable', null, 'voice transcript status: unavailable'],
    ['failed', null, 'voice transcript status: failed'],
  ])('correlates a caption and voice file with transcription status %s', async (voiceStatus, text, expected) => {
    const status = await setup();
    const bytes = Buffer.from('OggSvoice');
    const source = join(status.dir, 'voice.ogg');
    writeFileSync(source, bytes);
    status.client.batches.push([{
      msg_id: 8, wire_id: CAPTION_WIRE, from: { id: OWNER, name: 'Phone' }, text: 'Please summarize',
    }], []);
    status.client.files = [listed({
      filename: 'voice.ogg', mime: 'audio/ogg', size: bytes.length, kind: 'voice_message',
      reply_to: { wire_id: CAPTION_WIRE },
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      filename: 'voice.ogg', mime: 'audio/ogg', kind: 'voice_message',
      transcription: {
        configured: true, attempted: true, status: voiceStatus, provider: 'fixture', text,
        error_category: voiceStatus === 'failed' ? 'provider_error' : null,
        audio_path: source, file_wire_id: FILE_WIRE,
      },
    }));
    await status.channel.drain();
    const prompt = String(status.queuePrompt.mock.calls[0][0]);
    expect(prompt).toContain('Caption: Please summarize');
    expect(prompt).toContain(expected);
    expect(status.queuePrompt).toHaveBeenCalledOnce();
    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Done.' });
    await vi.waitFor(() => expect(status.client.calls.some(call => call.args?.text === 'Done.')).toBe(true));
    await status.channel.close();
  });

  it('rejects unauthorized and oversized metadata before retrieving bytes', async () => {
    const unauthorized = await setup();
    unauthorized.client.files = [listed({ from: { id: OTHER, name: 'Impostor' } })];
    await unauthorized.channel.drain();
    expect(unauthorized.client.calls.some(call => call.name === 'getFiles')).toBe(false);
    expect(unauthorized.client.calls.some(call => call.name === 'sendMessage')).toBe(false);
    await unauthorized.channel.close();

    const oversized = await setup();
    oversized.client.files = [listed({ size: 2_000 })];
    await oversized.channel.drain();
    expect(oversized.client.calls.some(call => call.name === 'getFiles')).toBe(false);
    expect(oversized.client.calls.find(call => call.name === 'sendMessage')?.args)
      .toMatchObject({ contact: OWNER, replyToWireId: FILE_WIRE });
    await oversized.channel.close();

    const overCount = await setup();
    overCount.client.batches.push([{
      msg_id: 9, wire_id: CAPTION_WIRE, from: { id: OWNER }, text: 'Five files',
    }], []);
    overCount.client.files = Array.from({ length: 5 }, (_, index) => listed({
      file_id: index + 1, wire_id: String(index + 4).repeat(64),
      reply_to: { wire_id: CAPTION_WIRE },
    }));
    await overCount.channel.drain();
    expect(overCount.client.calls.some(call => call.name === 'getFiles')).toBe(false);
    expect(overCount.client.calls.find(call => call.name === 'sendMessage')?.args?.text)
      .toContain('4-file limit');
    await overCount.channel.close();
  });

  it('uses one source-wire owner route for a managed-agent caption and its file', async () => {
    const AGENT = 'C'.repeat(64);
    const status = await setup([OWNER, OTHER], false, attachmentConfig, AGENT);
    const ownerWire = '9'.repeat(64);
    const laterWire = '8'.repeat(64);
    status.client.batches.push([{
      msg_id: 12, wire_id: ownerWire, from: { id: OWNER, name: 'Phone' }, text: '/status',
    }], [{
      msg_id: 13, wire_id: laterWire, from: { id: OTHER, name: 'Laptop' }, text: '/status',
    }], []);
    await status.channel.drain();

    const bytes = Buffer.from('correlated report');
    const source = join(status.dir, 'agent-report');
    writeFileSync(source, bytes);
    const caption = {
      msg_id: 14, wire_id: CAPTION_WIRE, from: { id: AGENT, name: 'Role' },
      text: 'Attached report.', reply_to: { wire_id: ownerWire },
    };
    status.client.batches.push([caption], []);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Role' }, filename: 'report.txt', size: bytes.length,
      reply_to: { wire_id: CAPTION_WIRE },
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      from: { id: AGENT, name: 'Role' }, filename: 'report.txt',
      reply_to: { wire_id: CAPTION_WIRE },
    }));

    await status.channel.drain();

    expect(status.queuePrompt).not.toHaveBeenCalled();
    expect(status.client.calls).toContainEqual({ name: 'sendMessage', args: {
      contact: OWNER, text: 'Attached report.', replyToWireId: ownerWire,
    } });
    expect(status.client.calls).toContainEqual({ name: 'sendFile', args: {
      contact: OWNER, path: expect.any(String), filename: 'report.txt',
      replyToWireId: ownerWire,
    } });
    expect(status.client.calls.filter(call =>
      call.args?.text === 'Attached report.' || call.name === 'sendFile')
      .every(call => call.args?.contact === OWNER)).toBe(true);
    await status.channel.close();
  });

  it('records an owner attachment wire as the route for a later managed-agent file reply', async () => {
    const AGENT = 'C'.repeat(64);
    const status = await setup([OWNER, OTHER], false, attachmentConfig, AGENT);
    const ownerBytes = Buffer.from('owner request');
    const ownerSource = join(status.dir, 'owner-request');
    writeFileSync(ownerSource, ownerBytes);
    status.client.files = [listed({ size: ownerBytes.length, filename: 'request.txt' })];
    status.client.retrieved.set(FILE_WIRE, retrieved(ownerSource, ownerBytes, {
      filename: 'request.txt',
    }));
    await status.channel.drain();
    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Working.' });
    await vi.waitFor(() => expect(status.client.calls.some(call => call.args?.text === 'Working.'))
      .toBe(true));

    status.client.files = [];
    status.client.batches.push([{
      msg_id: 21, wire_id: '8'.repeat(64), from: { id: OTHER, name: 'Laptop' }, text: '/status',
    }], []);
    await status.channel.drain();

    const agentWire = '6'.repeat(64);
    const agentBytes = Buffer.from('agent response');
    const agentSource = join(status.dir, 'agent-response');
    writeFileSync(agentSource, agentBytes);
    status.client.files = [listed({
      file_id: 9, wire_id: agentWire, from: { id: AGENT, name: 'Role' },
      size: agentBytes.length, filename: 'response.txt', reply_to: { wire_id: FILE_WIRE },
    })];
    status.client.retrieved.set(agentWire, retrieved(agentSource, agentBytes, {
      file_id: 9, wire_id: agentWire, from: { id: AGENT, name: 'Role' },
      filename: 'response.txt', reply_to: { wire_id: FILE_WIRE },
    }));

    await status.channel.drain();

    expect(status.client.calls.find(call => call.name === 'sendFile')?.args).toMatchObject({
      contact: OWNER, filename: 'response.txt', replyToWireId: FILE_WIRE,
    });
    await status.channel.close();
  });

  it('routes an uncorrelated managed-agent file to the latest authenticated owner', async () => {
    const AGENT = 'C'.repeat(64);
    const status = await setup([OWNER, OTHER], false, attachmentConfig, AGENT);
    status.client.batches.push([{
      msg_id: 18, wire_id: '9'.repeat(64), from: { id: OTHER, name: 'Laptop' }, text: '/status',
    }], []);
    await status.channel.drain();
    const bytes = Buffer.from('proactive report');
    const source = join(status.dir, 'proactive-report');
    writeFileSync(source, bytes);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Role' }, size: bytes.length, filename: 'idea.txt',
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      from: { id: AGENT, name: 'Role' }, filename: 'idea.txt',
    }));

    await status.channel.drain();

    expect(status.client.calls.find(call => call.name === 'sendFile')?.args).toMatchObject({
      contact: OTHER, filename: 'idea.txt',
    });
    expect(status.client.calls.find(call => call.name === 'sendFile')?.args)
      .not.toHaveProperty('replyToWireId');
    await status.channel.close();
  });

  it('keeps an unknown correlated agent file queued and emits only one correlated NACK', async () => {
    const AGENT = 'C'.repeat(64);
    const status = await setup([OWNER, OTHER], false, attachmentConfig, AGENT);
    const unknownWire = '7'.repeat(64);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Role' }, reply_to: { wire_id: unknownWire },
    })];

    await status.channel.drain();
    await status.channel.drain();

    expect(status.client.calls.some(call => call.name === 'getFiles')).toBe(false);
    expect(status.client.calls.some(call => call.name === 'sendFile')).toBe(false);
    expect(status.client.calls.filter(call => call.name === 'sendMessage')).toEqual([{
      name: 'sendMessage', args: {
        contact: AGENT, text: expect.stringContaining('queued'), replyToWireId: FILE_WIRE,
      },
    }]);
    expect(status.logs.join('\n')).toContain('no authenticated owner route matches the source wire');
    await status.channel.close();
  });

  it('admits a managed-agent file before emitting its caption and NACKs the whole rejection', async () => {
    const AGENT = 'C'.repeat(64);
    const status = await setup([OWNER], false, attachmentConfig, AGENT);
    const ownerWire = '9'.repeat(64);
    status.client.batches.push([{
      msg_id: 15, wire_id: ownerWire, from: { id: OWNER, name: 'Phone' }, text: '/status',
    }], []);
    await status.channel.drain();

    const bytes = Buffer.from('not the declared bytes');
    const source = join(status.dir, 'agent-bad-report');
    writeFileSync(source, bytes);
    const caption = {
      msg_id: 16, wire_id: CAPTION_WIRE, from: { id: AGENT, name: 'Role' },
      text: 'Do not emit me alone.', reply_to: { wire_id: ownerWire },
    };
    status.client.batches.push([caption], []);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Role' }, filename: 'report.txt', size: bytes.length,
      reply_to: { wire_id: CAPTION_WIRE },
    })];
    status.client.retrieved.set(FILE_WIRE, {
      ...retrieved(source, bytes, {
        from: { id: AGENT, name: 'Role' }, filename: 'report.txt',
        reply_to: { wire_id: CAPTION_WIRE },
      }),
      sha256: '0'.repeat(64),
    });

    await status.channel.drain();

    expect(status.client.calls.some(call => call.args?.text === 'Do not emit me alone.')).toBe(false);
    expect(status.client.calls.some(call => call.name === 'sendFile')).toBe(false);
    expect(status.client.calls).toContainEqual({ name: 'sendMessage', args: {
      contact: AGENT, text: expect.stringContaining('not relayed'),
      replyToWireId: CAPTION_WIRE,
    } });
    status.client.batches.push([caption], []);
    await status.channel.drain();
    expect(status.client.calls.filter(call => call.args?.contact === AGENT
      && String(call.args?.text).includes('not relayed'))).toHaveLength(1);
    expect(status.client.calls.some(call => call.args?.text === 'Do not emit me alone.')).toBe(false);
    await status.channel.close();
  });

  it('recovers a claimed caption with a journaled read managed-agent file after restart', async () => {
    const AGENT = 'C'.repeat(64);
    const ownerWire = '9'.repeat(64);
    const dir = mkdtempSync(join(tmpdir(), 'ours-owner-agent-recovery-'));
    dirs.push(dir);
    new OwnerConversationState(join(dir, '.owner-channel-conversations.json'))
      .recordInbound(OWNER, ownerWire, 100);
    new AttachmentRecoveryState(join(dir, '.owner-channel-attachment-recovery.json')).add({
      id: '7'.repeat(64), contact: AGENT, originWireId: CAPTION_WIRE,
      fileWireIds: [FILE_WIRE], createdAt: Date.now(),
    });
    const bytes = Buffer.from('recovered report');
    const source = join(dir, 'history-agent-report');
    writeFileSync(source, bytes);

    const status = await setup([OWNER], false, attachmentConfig, AGENT, dir, client => {
      client.files = [listed({
        from: { id: AGENT, name: 'Role' }, filename: 'recovered.txt', size: bytes.length,
        status: 'read', reply_to: { wire_id: CAPTION_WIRE },
      })];
      client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
        from: { id: AGENT, name: 'Role' }, filename: 'recovered.txt',
        status: 'read', reply_to: { wire_id: CAPTION_WIRE },
      }));
    });
    status.client.batches.push([{
      msg_id: 17, wire_id: CAPTION_WIRE, from: { id: AGENT, name: 'Role' },
      text: 'Recovered caption.', reply_to: { wire_id: ownerWire },
    }], []);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Role' }, filename: 'recovered.txt', size: bytes.length,
      status: 'read', reply_to: { wire_id: CAPTION_WIRE },
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      from: { id: AGENT, name: 'Role' }, filename: 'recovered.txt',
      status: 'read', reply_to: { wire_id: CAPTION_WIRE },
    }));

    await status.channel.drain();

    expect(status.client.calls).toContainEqual({
      name: 'fetchFile', args: { wireId: FILE_WIRE },
    });
    expect(status.client.calls).toContainEqual({ name: 'sendMessage', args: {
      contact: OWNER, text: 'Recovered caption.', replyToWireId: ownerWire,
    } });
    expect(status.client.calls.find(call => call.name === 'sendFile')?.args)
      .toMatchObject({ contact: OWNER, filename: 'recovered.txt', replyToWireId: ownerWire });
    expect(JSON.parse(readFileSync(join(dir,
      '.owner-channel-attachment-recovery.json'), 'utf8')).pending).toEqual([]);
    await status.channel.close();
  });

  it('makes a partially emitted caption/file transaction terminal and suppresses replay', async () => {
    const AGENT = 'C'.repeat(64);
    const status = await setup([OWNER], false, attachmentConfig, AGENT);
    const ownerWire = '9'.repeat(64);
    status.client.batches.push([{
      msg_id: 19, wire_id: ownerWire, from: { id: OWNER, name: 'Phone' }, text: '/status',
    }], []);
    await status.channel.drain();
    const bytes = Buffer.from('uncertain report');
    const source = join(status.dir, 'uncertain-report');
    writeFileSync(source, bytes);
    const caption = {
      msg_id: 20, wire_id: CAPTION_WIRE, from: { id: AGENT, name: 'Role' },
      text: 'May have been delivered.', reply_to: { wire_id: ownerWire },
    };
    status.client.batches.push([caption], []);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Role' }, filename: 'uncertain.txt', size: bytes.length,
      reply_to: { wire_id: CAPTION_WIRE },
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      from: { id: AGENT, name: 'Role' }, filename: 'uncertain.txt',
      reply_to: { wire_id: CAPTION_WIRE },
    }));
    status.client.failFile = true;

    await status.channel.drain();
    status.client.batches.push([caption], []);
    await status.channel.drain();

    expect(status.client.calls.filter(call => call.args?.text === 'May have been delivered.'))
      .toHaveLength(1);
    expect(status.client.calls.filter(call => call.name === 'sendFile')).toHaveLength(1);
    expect(status.client.calls).toContainEqual({ name: 'sendMessage', args: {
      contact: AGENT, text: expect.stringContaining('uncertain'), replyToWireId: CAPTION_WIRE,
    } });
    const conversation = JSON.parse(readFileSync(join(status.dir,
      '.owner-channel-conversations.json'), 'utf8'));
    expect(conversation.sends).toMatchObject([expect.objectContaining({ status: 'uncertain' })]);
    expect(JSON.parse(readFileSync(join(status.dir,
      '.owner-channel-attachment-recovery.json'), 'utf8')).pending).toEqual([]);
    await status.channel.close();
  });

  it('routes simultaneous authenticated owners independently and suppresses replayed wires', async () => {
    const status = await setup([OWNER, OTHER]);
    const bytes = Buffer.from('hello');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const source = join(status.dir, 'source');
    const imageSource = join(status.dir, 'image');
    writeFileSync(source, bytes);
    writeFileSync(imageSource, png);
    const otherWire = '3'.repeat(64);
    status.client.files = [listed(), listed({
      file_id: 8, wire_id: otherWire, from: { id: OTHER, name: 'Other' }, filename: 'other.png',
      mime: 'image/png', size: png.length,
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes));
    status.client.retrieved.set(otherWire, retrieved(imageSource, png, {
      file_id: 8, wire_id: otherWire, from: { id: OTHER, name: 'Other' }, filename: 'other.png',
      mime: 'image/png',
    }));
    await status.channel.drain();
    expect(status.queuePrompt).toHaveBeenCalledTimes(2);
    expect(status.client.calls.filter(call => call.name === 'getFiles')).toHaveLength(2);
    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Done.' });
    await vi.waitFor(() => expect(status.client.calls.filter(call => call.args?.text === 'Done.')).toHaveLength(2));
    await status.channel.drain();
    expect(status.queuePrompt).toHaveBeenCalledTimes(2);
    await status.channel.close();
  });

  it('resumes a journaled post-retrieval request with selected save_file recovery', async () => {
    const bytes = Buffer.from('OggSvoice');
    const dir = mkdtempSync(join(tmpdir(), 'ours-owner-attachments-'));
    dirs.push(dir);
    new AttachmentRecoveryState(join(dir, '.owner-channel-attachment-recovery.json')).add({
      id: createHash('sha256').update(FILE_WIRE).digest('hex'), contact: OWNER,
      originWireId: FILE_WIRE, fileWireIds: [FILE_WIRE], createdAt: Date.now(),
    });
    const source = join(dir, 'history-voice');
    writeFileSync(source, bytes);
    const status = await setup([OWNER], false, attachmentConfig, undefined, dir, client => {
      client.files = [listed({
        filename: 'voice.ogg', mime: 'audio/ogg', size: bytes.length,
        status: 'read', kind: 'voice_message',
      })];
      client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
        filename: 'voice.ogg', mime: 'audio/ogg', status: 'read', kind: 'voice_message',
      }));
    });
    await status.channel.drain();
    const save = status.client.calls.find(call => call.name === 'fetchFile');
    expect(save?.args?.wireId).toBe(FILE_WIRE);
    expect(status.client.calls.some(call => call.name === 'getFiles')).toBe(false);
    expect(String(status.queuePrompt.mock.calls[0][0])).toContain('category restart_recovery');
    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Recovered.' });
    await vi.waitFor(() => expect(status.client.calls.some(call => call.args?.text === 'Recovered.')).toBe(true));
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(status.dir,
      '.owner-channel-attachment-recovery.json'), 'utf8')).pending).toEqual([]));
    await status.channel.close();
  });

  it('cleans request bytes but retains its body-free recovery route after final delivery failure', async () => {
    const status = await setup();
    const bytes = Buffer.from('hello');
    const source = join(status.dir, 'source');
    writeFileSync(source, bytes);
    status.client.files = [listed()];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes));
    await status.channel.drain();
    const prompt = String(status.queuePrompt.mock.calls[0][0]);
    const admittedPath = prompt.match(/request-scoped local path: (.+)/)?.[1];
    status.client.failText = 'Cannot deliver';
    status.client.files = [];
    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Cannot deliver' });
    await vi.waitFor(() => expect(status.logs.join('\n')).toContain('completion failed'));
    await vi.waitFor(() => expect(() => lstatSync(admittedPath!)).toThrow());
    const recovery = JSON.parse(readFileSync(join(status.dir,
      '.owner-channel-attachment-recovery.json'), 'utf8'));
    expect(recovery.pending).toMatchObject([{
      contact: OWNER, originWireId: FILE_WIRE, fileWireIds: [FILE_WIRE],
    }]);
    expect(JSON.stringify(recovery)).not.toMatch(/hello|Cannot deliver|notes\.txt/);
    await status.channel.close();
  });
});

describe('managed-agent attachment egress', () => {
  async function establishRoute(status: Awaited<ReturnType<typeof setup>>, wire = '9'.repeat(64)) {
    status.client.batches.push([{
      msg_id: 90, wire_id: wire, from: { id: OWNER, name: 'Owner' }, text: '/status',
    }], []);
    await status.channel.drain();
    return wire;
  }

  it('relays markdown, HTML, and binary bytes from only the configured agent CID', async () => {
    const status = await setup([OWNER], false, attachmentConfig, AGENT);
    const ownerWire = await establishRoute(status);
    await establishRoute(status, '8'.repeat(64)); // newer mail must not steal an explicit source wire
    const captionWire = '7'.repeat(64);
    status.client.batches.push([{
      msg_id: 91, wire_id: captionWire, from: { id: AGENT, name: 'Role' },
      text: 'Requested artifacts', reply_to: { wire_id: ownerWire },
    }], []);
    const cases = [
      { wire: '3'.repeat(64), filename: 'notes.md', mime: 'text/markdown', bytes: Buffer.from('# Notes') },
      { wire: '4'.repeat(64), filename: 'page.html', mime: 'text/html', bytes: Buffer.from('<h1>Hi</h1>') },
      { wire: '5'.repeat(64), filename: '', mime: 'application/octet-stream', bytes: Buffer.from([0, 1, 2, 3]) },
    ];
    status.client.files = cases.map((item, index) => listed({
      file_id: 20 + index, wire_id: item.wire, from: { id: AGENT, name: 'Role' },
      filename: item.filename, mime: item.mime, size: item.bytes.length,
      reply_to: { wire_id: captionWire },
    }));
    for (const [index, item] of cases.entries()) {
      const source = join(status.dir, `agent-${index}`);
      writeFileSync(source, item.bytes);
      status.client.retrieved.set(item.wire, retrieved(source, item.bytes, {
        file_id: 20 + index, wire_id: item.wire, from: { id: AGENT, name: 'Role' },
        filename: item.filename, mime: item.mime, reply_to: { wire_id: captionWire },
      }));
    }

    await status.channel.drain();
    expect(status.queuePrompt).not.toHaveBeenCalled();
    const sends = status.client.calls.filter(call => call.name === 'sendFile');
    expect(sends).toHaveLength(3);
    expect(sends.map(call => call.args?.filename)).toEqual(['notes.md', 'page.html', 'attachment.bin']);
    expect(sends.every(call => call.args?.contact === OWNER
      && call.args?.replyToWireId === ownerWire)).toBe(true);
    expect(status.client.calls).toContainEqual({ name: 'sendMessage', args: {
      contact: OWNER, text: 'Requested artifacts', replyToWireId: ownerWire,
    } });
    expect(status.logs.join('\n')).not.toMatch(/# Notes|<h1>|notes\.md|page\.html/);
    await status.channel.close();
  });

  it('relays owner Markdown ingress when agent egress is configured', async () => {
    const status = await setup([OWNER], false, attachmentConfig, AGENT);
    const bytes = Buffer.from('# owner markdown');
    const source = join(status.dir, 'owner.md');
    writeFileSync(source, bytes);
    status.client.files = [listed({ filename: 'owner.md', mime: 'text/markdown', size: bytes.length })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      filename: 'owner.md', mime: 'text/markdown',
    }));
    await status.channel.drain();
    expect(status.client.calls.some(call => call.name === 'getFiles')).toBe(true);
    expect(status.client.calls.some(call => call.name === 'sendFile')).toBe(false);
    expect(status.queuePrompt).toHaveBeenCalledOnce();
    expect(String(status.queuePrompt.mock.calls[0][0])).toContain('declared MIME: text/markdown');
    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Read.' });
    await vi.waitFor(() => expect(status.client.calls.some(call => call.args?.text === 'Read.')).toBe(true));
    await status.channel.close();
  });

  it('rejects unauthorized and oversized file senders before retrieving bytes', async () => {
    for (const overrides of [
      { from: { id: OTHER, name: 'Impostor' } },
      { from: { id: AGENT, name: 'Role' }, size: 2_000 },
    ]) {
      const status = await setup([OWNER], false, attachmentConfig, AGENT);
      await establishRoute(status);
      status.client.files = [listed(overrides)];
      await status.channel.drain();
      expect(status.client.calls.some(call => call.name === 'getFiles')).toBe(false);
      expect(status.client.calls.some(call => call.name === 'sendFile')).toBe(false);
      await status.channel.close();
    }
  });

  it('records uncertain delivery before replay and never blindly sends the same file twice', async () => {
    const status = await setup([OWNER], false, attachmentConfig, AGENT);
    await establishRoute(status);
    const bytes = Buffer.from('artifact');
    const source = join(status.dir, 'artifact');
    writeFileSync(source, bytes);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Role' }, size: bytes.length,
      mime: 'application/octet-stream', filename: 'artifact.bin',
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      from: { id: AGENT, name: 'Role' }, mime: 'application/octet-stream', filename: 'artifact.bin',
    }));
    status.client.failTools.add('sendFile');
    await status.channel.drain();
    expect(status.client.calls.filter(call => call.name === 'sendFile')).toHaveLength(1);
    const recoveryPath = join(status.dir, '.owner-channel-attachment-recovery.json');
    expect(readFileSync(recoveryPath, 'utf8')).not.toMatch(/artifact\.bin|artifact/);

    await status.channel.close();
    status.client.failTools.delete('sendFile');
    status.client.files = [listed({
      from: { id: AGENT, name: 'Role' }, size: bytes.length, status: 'read',
      mime: 'application/octet-stream', filename: 'artifact.bin',
    })];
    const restarted = new OwnerChannel({
      role: 'Role', harness: 'claude-code',
      config: {
        identity: 'Role-owner', owners: [OWNER], agent: AGENT,
        interrupt: false, progress_interval_ms: 0, attachments: attachmentConfig,
      },
      session: {
        backend: 'acp', pid: 1, isAlive: () => true,
        snapshot: () => ({ backend: 'acp', alive: true, readiness: 'running' }),
        queuePrompt: status.queuePrompt, interrupt: vi.fn(), eventsSince: () => [],
      } as unknown as SessionHandle,
      stateDir: status.dir, client: status.client, log: line => status.logs.push(line),
    });
    await restarted.start();
    await restarted.drain();
    expect(status.client.calls.filter(call => call.name === 'sendFile')).toHaveLength(1);
    expect(JSON.parse(readFileSync(recoveryPath, 'utf8')).pending).toEqual([]);
    await restarted.close();
  });
});

describe('attachment admission and recovery primitives', () => {
  it('migrates v1 conversation state into bounded source-wire routes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-owner-route-migration-'));
    dirs.push(dir);
    const path = join(dir, 'conversations.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      conversations: [{ contact: OWNER, lastInboundAt: 123, lastInboundWireId: FILE_WIRE }],
      sends: [],
    }));

    const state = new OwnerConversationState(path);
    expect(state.routeForWire(FILE_WIRE, new Set([OWNER.toLowerCase()])))
      .toEqual({ contact: OWNER, basis: 'source-wire' });
    const migrated = JSON.parse(readFileSync(path, 'utf8'));
    expect(migrated).toMatchObject({
      version: 2,
      routes: [{ contact: OWNER, wireId: FILE_WIRE, at: 123 }],
    });
    expect(JSON.stringify(migrated)).not.toMatch(/body|filename|path|caption/);
  });

  it('bounds persisted source-wire routing history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-owner-route-bound-'));
    dirs.push(dir);
    const path = join(dir, 'conversations.json');
    writeFileSync(path, JSON.stringify({
      version: 2,
      conversations: [{ contact: OWNER, lastInboundAt: 511, lastInboundWireId: 'wire-511' }],
      routes: Array.from({ length: 512 }, (_, index) => ({
        contact: OWNER, wireId: `wire-${index}`, at: index,
      })),
      sends: [],
    }));
    const state = new OwnerConversationState(path);
    state.recordInbound(OWNER, 'wire-512', 512);

    expect(() => state.routeForWire('wire-0', new Set([OWNER])))
      .toThrow(/no authenticated owner route/);
    expect(state.routeForWire('wire-512', new Set([OWNER])))
      .toEqual({ contact: OWNER, basis: 'source-wire' });
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.routes).toHaveLength(512);
  });

  it('sanitizes traversal names and rejects symlinked or hash-mismatched daemon paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ours-admission-'));
    dirs.push(root);
    const dir = await prepareAttachmentDirectory(join(root, 'inbox'), 'request');
    expect(sanitizeFilename('../../\\..\\secret?.txt')).toBe('secret_.txt');
    expect(sanitizeFilename('../bad\u0000\u0007\u202ename.md')).toBe('bad   name.md');
    expect(sanitizeFilename('../bad\u0000\u0007\u202ename.md')).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    const source = join(root, 'source');
    const link = join(root, 'link');
    writeFileSync(source, 'hello');
    symlinkSync(source, link);
    const base: RetrievedAttachment = {
      ...(listed() as unknown as IncomingAttachment), fileId: 7, wireId: FILE_WIRE,
      senderId: OWNER, senderName: 'Phone', filename: '../../secret.txt', mime: 'text/plain',
      size: 5, status: 'read', date: '', kind: 'file', replyTo: null,
      path: link, sha256: createHash('sha256').update('hello').digest('hex'),
    };
    await expect(admitAttachments([base], dir, attachmentConfig)).rejects.toThrow(/regular file/);
    await expect(admitAttachments([{ ...base, path: source, sha256: '0'.repeat(64) }], dir,
      attachmentConfig)).rejects.toThrow(/hash mismatched/);
    const target = join(root, 'target');
    writeFileSync(target, 'unchanged');
    symlinkSync(target, join(dir, `1-${FILE_WIRE.slice(0, 12)}-secret.txt`));
    await expect(admitAttachments([{ ...base, path: source }], dir, attachmentConfig))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(target, 'utf8')).toBe('unchanged');

    const linkedRoot = join(root, 'linked-inbox');
    symlinkSync(join(root, 'inbox'), linkedRoot);
    await expect(prepareAttachmentDirectory(linkedRoot, 'other')).rejects.toThrow(/root.*safe/);
  });

  it('rejects any selected retrieval whose maintained metadata changes after prefiltering', () => {
    const expected: IncomingAttachment = {
      fileId: 7, wireId: FILE_WIRE, senderId: OWNER, senderName: 'Phone',
      filename: 'notes.txt', mime: 'text/plain', size: 5, status: 'unread', date: '',
      kind: 'file', replyTo: null,
    };
    const raw = { files: [{
      ...retrieved('/private/source', Buffer.from('hello')),
      mime: 'application/pdf',
    }] };
    expect(() => parseRetrievedAttachments(raw, [expected])).toThrow(/provenance or integrity/);
  });

  it('accepts arbitrary declared MIME and reports detection without type rejection', async () => {
    const incoming = {
      ...(listed({ mime: 'text/html' }) as unknown as IncomingAttachment),
      fileId: 7, wireId: FILE_WIRE, senderId: AGENT, senderName: 'Agent',
      filename: 'page.html', mime: 'text/html', size: 13, status: 'unread', date: '',
      kind: 'file' as const, replyTo: null,
    };
    expect(validateAttachmentSelection([incoming], attachmentConfig)).toBeUndefined();
    expect(validateAttachmentRelaySelection([incoming], attachmentConfig)).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), 'ours-egress-mime-'));
    dirs.push(root);
    const bytes = Buffer.from('<h1>Hello</h1>');
    const source = join(root, 'page.html');
    writeFileSync(source, bytes);
    const dir = await prepareAttachmentDirectory(join(root, 'inbox'), 'request');
    const retrievedFile: RetrievedAttachment = {
      ...incoming, size: bytes.length, path: source,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const staged = await admitAttachments([retrievedFile], dir, attachmentConfig);
    expect(staged[0]).toMatchObject({ declaredMime: 'text/html', detectedMime: 'text/plain' });
  });

  it('accepts empty, custom binary, misleading-extension, and extensionless files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ours-opaque-types-'));
    dirs.push(root);
    const dir = await prepareAttachmentDirectory(join(root, 'inbox'), 'request');
    const cases = [
      { filename: 'empty', mime: 'application/x-empty', bytes: Buffer.alloc(0),
        detected: 'application/octet-stream' },
      { filename: 'payload.jpg', mime: 'application/x-custom', bytes: Buffer.from([0, 1, 2, 3]),
        detected: 'application/octet-stream' },
      { filename: 'README', mime: '', bytes: Buffer.from('# Markdown'), detected: 'text/plain' },
    ];
    const files: RetrievedAttachment[] = cases.map((item, index) => {
      const path = join(root, `source-${index}`);
      writeFileSync(path, item.bytes);
      return {
        ...(listed() as unknown as IncomingAttachment), fileId: index + 1,
        wireId: String(index + 4).repeat(64), senderId: OWNER, senderName: 'Phone',
        filename: item.filename, mime: item.mime, size: item.bytes.length, status: 'read',
        date: '', kind: 'file', replyTo: null, path,
        sha256: createHash('sha256').update(item.bytes).digest('hex'),
      };
    });
    expect(validateAttachmentSelection(files, attachmentConfig)).toBeUndefined();
    const admitted = await admitAttachments(files, dir, attachmentConfig);
    expect(admitted.map(file => ({ filename: file.filename, declaredMime: file.declaredMime,
      detectedMime: file.detectedMime, size: file.size }))).toEqual(cases.map(item => ({
      filename: item.filename, declaredMime: item.mime, detectedMime: item.detected,
      size: item.bytes.length,
    })));
  });

  it('persists only bounded routing metadata at mode 0600 and expires recovery directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ours-recovery-'));
    dirs.push(root);
    const statePath = join(root, 'state.json');
    const state = new AttachmentRecoveryState(statePath);
    state.add({
      id: '4'.repeat(64), contact: OWNER, originWireId: FILE_WIRE,
      fileWireIds: [FILE_WIRE], createdAt: 100,
    });
    expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
    const persisted = readFileSync(statePath, 'utf8');
    expect(persisted).not.toMatch(/filename|transcript|body|path/);
    expect(state.cleanup(200, 50)).toBe(1);

    const inbox = join(root, 'inbox');
    const old = await prepareAttachmentDirectory(inbox, 'old');
    writeFileSync(join(old, 'file'), 'x');
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const past = new Date(0);
    // chmod confirms cleanup does not rely on permissive request directories.
    chmodSync(old, 0o700);
    const { utimesSync } = await import('node:fs');
    utimesSync(old, past, past);
    expect(await cleanupAttachmentRoot(inbox, 10_000, 100)).toBe(1);
    expect(() => lstatSync(old)).toThrow();
  });
});

describe('voice-message opaque admission', () => {
  // Voice notes ride "<base>; x-ours-kind=voice-message" verbatim end to end
  // (base varies by recorder: audio/webm Chrome/Android, audio/mp4 iOS Safari,
  // audio/ogg fallback). The base is metadata only and never an admission gate.
  const VOICE_PARAM = 'x-ours-kind=voice-message';
  const voiceConfig: OwnerAttachmentConfig = attachmentConfig;
  const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm-voice')]);
  const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A voice')]);

  function incoming(mime: string, kind: 'file' | 'voice_message' = 'voice_message',
    overrides: Partial<IncomingAttachment> = {}): IncomingAttachment {
    return {
      fileId: 7, wireId: FILE_WIRE, senderId: OWNER, senderName: 'Phone',
      filename: 'voice-message-20260804.webm', mime, size: 20, status: 'unread',
      date: '2026-08-04T12:00:00Z', kind, replyTo: null, ...overrides,
    };
  }

  it('accepts every recorder base container carrying the voice marker', () => {
    for (const base of ['audio/webm', 'audio/mp4', 'audio/ogg']) {
      expect(validateAttachmentSelection(
        [incoming(`${base}; ${VOICE_PARAM}`)], voiceConfig)).toBeUndefined();
    }
  });

  it('accepts voice metadata regardless of base type while preserving byte limits', () => {
    expect(validateAttachmentSelection(
      [incoming(`audio/webm; ${VOICE_PARAM}`)], attachmentConfig)).toBeUndefined();
    expect(validateAttachmentSelection(
      [incoming(`application/pdf; ${VOICE_PARAM}`)], voiceConfig)).toBeUndefined();
    expect(validateAttachmentSelection(
      [incoming(`audio/webm; ${VOICE_PARAM}`, 'voice_message', { size: 2_000 })],
      voiceConfig)).toMatch(/byte limit/);
  });

  it('accepts parameterized and bare MIME metadata for ordinary files', () => {
    expect(validateAttachmentSelection(
      [incoming('audio/webm; codecs=opus', 'file')], voiceConfig)).toBeUndefined();
    expect(validateAttachmentSelection(
      [incoming(`audio/webm; ${VOICE_PARAM}`, 'file')], voiceConfig)).toBeUndefined();
    expect(validateAttachmentSelection(
      [incoming('audio/webm', 'file')], voiceConfig)).toBeUndefined();
  });

  it('admits WebM/Opus and iOS mp4 voice bytes under the parameterized declared MIME', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ours-voice-admission-'));
    dirs.push(root);
    const dir = await prepareAttachmentDirectory(join(root, 'inbox'), 'request');
    const cases: Array<[string, Buffer, string, string]> = [
      [`audio/webm; ${VOICE_PARAM}`, WEBM, 'audio/webm', 'voice-message-20260804.webm'],
      [`audio/mp4; ${VOICE_PARAM}`, M4A, 'audio/mp4', 'voice-message-20260804.m4a'],
    ];
    const files: RetrievedAttachment[] = cases.map(([mime, bytes, , filename], index) => {
      const source = join(root, `source-${index}`);
      writeFileSync(source, bytes);
      return {
        ...incoming(mime, 'voice_message', {
          wireId: String(index + 5).repeat(64), filename, size: bytes.length,
        }),
        path: source, sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    const admitted = await admitAttachments(files, dir, voiceConfig);
    expect(admitted.map(file => file.detectedMime)).toEqual(['audio/webm', 'audio/mp4']);
    expect(admitted.map(file => file.declaredMime)).toEqual([
      `audio/webm; ${VOICE_PARAM}`, `audio/mp4; ${VOICE_PARAM}`,
    ]);
    expect(admitted.map(file => file.kind)).toEqual(['voice_message', 'voice_message']);
  });

  it('accepts voice bytes whose detection contradicts the declared base container', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ours-voice-forged-'));
    dirs.push(root);
    const dir = await prepareAttachmentDirectory(join(root, 'inbox'), 'request');
    const bytes = Buffer.from('%PDF-1.7 not audio');
    const source = join(root, 'forged');
    writeFileSync(source, bytes);
    const file: RetrievedAttachment = {
      ...incoming(`audio/webm; ${VOICE_PARAM}`, 'voice_message', { size: bytes.length }),
      path: source, sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const [admitted] = await admitAttachments([file], dir, voiceConfig);
    expect(admitted).toMatchObject({
      declaredMime: `audio/webm; ${VOICE_PARAM}`, detectedMime: 'application/pdf',
    });
  });

  it('routes an authenticated WebM voice message end to end with its transcript', async () => {
    const status = await setup([OWNER], false, voiceConfig);
    const mime = `audio/webm; ${VOICE_PARAM}`;
    const source = join(status.dir, 'voice.webm');
    writeFileSync(source, WEBM);
    status.client.files = [listed({
      filename: 'voice-message-20260804.webm', mime, size: WEBM.length, kind: 'voice_message',
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, WEBM, {
      filename: 'voice-message-20260804.webm', mime, kind: 'voice_message',
      transcription: {
        configured: true, attempted: true, status: 'succeeded', provider: 'fixture',
        text: 'Deploy the fix.', error_category: null, audio_path: source, file_wire_id: FILE_WIRE,
      },
    }));
    await status.channel.drain();
    expect(status.queuePrompt).toHaveBeenCalledOnce();
    const prompt = String(status.queuePrompt.mock.calls[0][0]);
    expect(prompt).toContain('detected MIME: audio/webm');
    expect(prompt).toContain('voice transcript: Deploy the fix.');
    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Heard.' });
    await vi.waitFor(() => expect(status.client.calls.some(call => call.args?.text === 'Heard.')).toBe(true));
    await status.channel.close();
  });
});

describe('recovered attachment writes', () => {
  const dir = () => {
    const path = mkdtempSync(join(tmpdir(), 'ours-owner-recovered-'));
    dirs.push(path);
    return path;
  };

  it('derives the destination from a validated wire id inside the request directory', async () => {
    const root = dir();
    const path = await writeRecoveredAttachment(root, FILE_WIRE, Buffer.from('bytes'));
    expect(path).toBe(join(root, path.slice(root.length + 1)));
    expect(path.slice(root.length + 1))
      .toMatch(new RegExp(`^\\.recovered-${FILE_WIRE}-[0-9a-f-]{36}$`));
    expect(readFileSync(path, 'utf8')).toBe('bytes');
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    // No temp file survives a successful publish.
    expect(readdirSync(root)).toEqual([path.slice(root.length + 1)]);
  });

  // The daemon used to be handed a dest_path. Nothing may reach outside the
  // prepared request directory now, and a wire id is the only input.
  it('refuses a wire id that is not exactly 64 hex characters', async () => {
    const root = dir();
    for (const wire of ['../../etc/passwd', `${FILE_WIRE}/../escape`, '', 'zz'.repeat(32)])
      await expect(writeRecoveredAttachment(root, wire, Buffer.from('x')))
        .rejects.toThrow(/wire id is not a 64-hex value/);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a symlinked request directory', async () => {
    const root = dir();
    const real = join(root, 'real');
    const link = join(root, 'link');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, link);
    await expect(writeRecoveredAttachment(link, FILE_WIRE, Buffer.from('x')))
      .rejects.toThrow(/not a safe directory/);
    expect(readdirSync(real)).toEqual([]);
  });

  it('completes a short write rather than publishing a truncated file', async () => {
    const root = dir();
    const bytes = Buffer.from('partial-write-bytes');
    const chunks: number[] = [];
    const path = await writeRecoveredAttachment(root, FILE_WIRE, bytes, {
      // One byte per call: a single writeFile hides this, a loop must not.
      write: async (handle, buffer, offset) => {
        chunks.push(offset);
        const { bytesWritten } = await handle.write(buffer, offset, 1);
        return bytesWritten;
      },
    });
    expect(readFileSync(path)).toEqual(bytes);
    expect(chunks).toHaveLength(bytes.length);
  });

  it('leaves nothing behind when the write cannot progress', async () => {
    const root = dir();
    await expect(writeRecoveredAttachment(root, FILE_WIRE, Buffer.from('abc'), {
      write: async () => 0,
    })).rejects.toThrow(/write made no progress at byte 0/);
    expect(readdirSync(root)).toEqual([]);
  });

  it('leaves nothing behind when the write itself fails mid-file', async () => {
    const root = dir();
    let calls = 0;
    await expect(writeRecoveredAttachment(root, FILE_WIRE, Buffer.from('abcdef'), {
      write: async (handle, buffer, offset) => {
        if (calls++ > 0) throw new Error('disk full');
        const { bytesWritten } = await handle.write(buffer, offset, 2);
        return bytesWritten;
      },
    })).rejects.toThrow(/disk full/);
    expect(readdirSync(root)).toEqual([]);
  });
});
