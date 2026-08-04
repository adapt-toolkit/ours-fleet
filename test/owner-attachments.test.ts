import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OwnerAttachmentConfig, OwnerChannelConfig } from '../src/config.js';
import {
  AttachmentRecoveryState, admitAttachments, cleanupAttachmentRoot, prepareAttachmentDirectory,
  parseRetrievedAttachments, sanitizeFilename, type IncomingAttachment, type RetrievedAttachment,
} from '../src/owner-channel/attachments.js';
import { OwnerChannel } from '../src/owner-channel/channel.js';
import type { OursToolClient } from '../src/owner-channel/mcp.js';
import type { QueuedPrompt, SessionHandle, TurnResult } from '../src/session/types.js';

const OWNER = 'A'.repeat(64);
const OTHER = 'B'.repeat(64);
const AGENT = 'D'.repeat(64);
const FILE_WIRE = '1'.repeat(64);
const CAPTION_WIRE = '2'.repeat(64);
const dirs: string[] = [];
const attachmentConfig: OwnerAttachmentConfig = {
  enabled: true, max_files_per_request: 4, max_file_bytes: 1_024,
  max_request_bytes: 2_048, retention_ms: 60_000,
  allowed_mime: ['text/plain', 'application/pdf', 'image/png', 'audio/ogg'],
};

class AttachmentClient implements OursToolClient {
  calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  batches: unknown[][] = [];
  files: unknown[] = [];
  retrieved = new Map<string, Record<string, unknown>>();
  failText?: string;
  async start() {}
  async close() {}
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'get_messages') return { messages: this.batches.shift() ?? [] };
    if (name === 'list_incoming_files') return { count: this.files.length, files: this.files };
    if (name === 'get_files') {
      const wires = args?.wire_ids as string[];
      return { files: wires.map(wire => this.retrieved.get(wire)) };
    }
    if (name === 'save_file') {
      const item = this.retrieved.get(String(args?.wire_id));
      copyFileSync(String(item?.path), String(args?.dest_path));
      return { saved: true };
    }
    if (name === 'send_message' && args?.text === this.failText) throw new Error('transport unavailable');
    return {};
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
    sha256: createHash('sha256').update(bytes).digest('hex'), status: 'processed',
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

async function setup(owners = [OWNER], recover = false, agent?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-owner-attachments-'));
  dirs.push(dir);
  const client = new AttachmentClient();
  const pending = deferredPrompt();
  const queuePrompt = vi.fn(async () => pending.queued);
  const session = {
    backend: 'acp', pid: 1, isAlive: () => true,
    snapshot: () => ({ backend: 'acp', alive: true, readiness: 'running' }),
    queuePrompt, interrupt: vi.fn(), eventsSince: () => [],
  } as unknown as SessionHandle;
  const config: OwnerChannelConfig = {
    identity: 'Role-owner', owners, interrupt: false, progress_interval_ms: 0,
    ...(agent ? { agent } : {}),
    attachments: attachmentConfig,
  };
  if (recover) new AttachmentRecoveryState(join(dir, '.owner-channel-attachment-recovery.json')).add({
    id: createHash('sha256').update(FILE_WIRE).digest('hex'), contact: OWNER,
    originWireId: FILE_WIRE, fileWireIds: [FILE_WIRE], createdAt: Date.now(),
  });
  const logs: string[] = [];
  const channel = new OwnerChannel({
    role: 'Role', config, session, stateDir: dir, client, log: line => logs.push(line),
    watch: () => ({
      pid: 1, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      once: () => undefined, kill: () => true,
    }) as never,
  });
  await channel.start();
  await channel.drain();
  return { dir, client, channel, queuePrompt, logs, ...pending };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('owner-channel attachment ingress', () => {
  it('handles a file-only wake, admits bytes privately, and cleans up after exact-wire delivery', async () => {
    const status = await setup();
    const bytes = Buffer.from('hello');
    const source = join(status.dir, 'daemon-source');
    writeFileSync(source, bytes);
    status.client.files = [listed()];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes));

    await status.channel.drain();
    expect(status.client.calls).toContainEqual({ name: 'get_files', args: { wire_ids: [FILE_WIRE] } });
    const prompt = String(status.queuePrompt.mock.calls[0][0]);
    expect(prompt).toContain('notes.txt');
    expect(prompt).toContain('detected MIME: text/plain');
    const admittedPath = prompt.match(/request-scoped local path: (.+)/)?.[1];
    expect(admittedPath).toBeTruthy();
    expect(lstatSync(admittedPath!).mode & 0o777).toBe(0o600);
    expect(readFileSync(admittedPath!, 'utf8')).toBe('hello');

    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Reviewed.' });
    await vi.waitFor(() => expect(status.client.calls).toContainEqual({ name: 'send_message', args: {
      contact: OWNER, text: 'Reviewed.', reply_to_wire_id: FILE_WIRE,
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

  it('rejects unauthorized, oversized, and disallowed metadata before retrieving bytes', async () => {
    const unauthorized = await setup();
    unauthorized.client.files = [listed({ from: { id: OTHER, name: 'Impostor' } })];
    await unauthorized.channel.drain();
    expect(unauthorized.client.calls.some(call => call.name === 'get_files')).toBe(false);
    expect(unauthorized.client.calls.find(call => call.name === 'send_message')?.args).toEqual({
      contact: OWNER,
      text: `⚠️ Owner-channel security warning: rejected a file from unauthorized sender CID `
        + `${OTHER}. Its bytes were not forwarded.`,
    });
    await unauthorized.channel.close();

    for (const overrides of [{ size: 2_000 }, { mime: 'application/x-executable' }]) {
      const rejected = await setup();
      rejected.client.files = [listed(overrides)];
      await rejected.channel.drain();
      expect(rejected.client.calls.some(call => call.name === 'get_files')).toBe(false);
      expect(rejected.client.calls.find(call => call.name === 'send_message')?.args)
        .toMatchObject({ contact: OWNER, reply_to_wire_id: FILE_WIRE });
      await rejected.channel.close();
    }

    const overCount = await setup();
    overCount.client.batches.push([{
      msg_id: 9, wire_id: CAPTION_WIRE, from: { id: OWNER }, text: 'Five files',
    }], []);
    overCount.client.files = Array.from({ length: 5 }, (_, index) => listed({
      file_id: index + 1, wire_id: String(index + 4).repeat(64),
      reply_to: { wire_id: CAPTION_WIRE },
    }));
    await overCount.channel.drain();
    expect(overCount.client.calls.some(call => call.name === 'get_files')).toBe(false);
    expect(overCount.client.calls.find(call => call.name === 'send_message')?.args?.text)
      .toContain('4-file limit');
    await overCount.channel.close();
  });

  it('relays a managed-agent file to the exact owner request through the channel identity', async () => {
    const status = await setup([OWNER, OTHER], false, AGENT);
    const ownerWire = '9'.repeat(64);
    status.client.batches.push([{
      msg_id: 12, wire_id: ownerWire, from: { id: OWNER, name: 'Phone' }, text: '/status',
    }], [{
      msg_id: 13, wire_id: '8'.repeat(64), from: { id: OTHER, name: 'Laptop' }, text: '/status',
    }], []);
    await status.channel.drain();

    const bytes = Buffer.from('direct report');
    const source = join(status.dir, 'agent-report');
    writeFileSync(source, bytes);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Coordinator' }, size: bytes.length,
      filename: 'report.txt', reply_to: { wire_id: ownerWire },
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      from: { id: AGENT, name: 'Coordinator' }, filename: 'report.txt',
      reply_to: { wire_id: ownerWire },
    }));
    await status.channel.drain();

    expect(status.queuePrompt).not.toHaveBeenCalled();
    expect(status.client.calls).toContainEqual({
      name: 'get_files', args: { wire_ids: [FILE_WIRE] },
    });
    const sent = status.client.calls.find(call => call.name === 'send_file');
    expect(sent?.args).toMatchObject({
      contact: OWNER, filename: 'report.txt', reply_to_wire_id: ownerWire,
    });
    expect(sent?.args?.contact).not.toBe(OTHER);
    expect(existsSync(String(sent?.args?.path))).toBe(false);
    await status.channel.close();
  });

  it('routes an uncorrelated managed-agent file to the latest authenticated owner', async () => {
    const status = await setup([OWNER, OTHER], false, AGENT);
    const ownerWire = '9'.repeat(64);
    status.client.batches.push([{
      msg_id: 14, wire_id: ownerWire, from: { id: OTHER, name: 'Laptop' }, text: '/status',
    }], []);
    await status.channel.drain();
    const bytes = Buffer.from('proactive report');
    const source = join(status.dir, 'proactive-report');
    writeFileSync(source, bytes);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Coordinator' }, size: bytes.length, filename: 'idea.txt',
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      from: { id: AGENT, name: 'Coordinator' }, filename: 'idea.txt',
    }));
    await status.channel.drain();

    expect(status.client.calls.find(call => call.name === 'send_file')?.args).toMatchObject({
      contact: OTHER, filename: 'idea.txt',
    });
    expect(status.client.calls.find(call => call.name === 'send_file')?.args)
      .not.toHaveProperty('reply_to_wire_id');
    await status.channel.close();
  });

  it('refuses an unknown correlated wire instead of guessing an owner route', async () => {
    const status = await setup([OWNER, OTHER], false, AGENT);
    status.client.batches.push([{
      msg_id: 15, wire_id: '9'.repeat(64), from: { id: OTHER }, text: '/status',
    }], []);
    await status.channel.drain();
    status.client.files = [listed({
      from: { id: AGENT, name: 'Coordinator' }, reply_to: { wire_id: '7'.repeat(64) },
    })];
    await status.channel.drain();

    expect(status.client.calls.some(call => call.name === 'get_files')).toBe(false);
    expect(status.client.calls.some(call => call.name === 'send_file')).toBe(false);
    expect(status.logs.join('\n')).toContain('no authenticated owner route matches the source wire');
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
    expect(status.client.calls.filter(call => call.name === 'get_files')).toHaveLength(2);
    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Done.' });
    await vi.waitFor(() => expect(status.client.calls.filter(call => call.args?.text === 'Done.')).toHaveLength(2));
    await status.channel.drain();
    expect(status.queuePrompt).toHaveBeenCalledTimes(2);
    await status.channel.close();
  });

  it('resumes a journaled post-retrieval request with selected save_file recovery', async () => {
    const status = await setup([OWNER], true);
    const bytes = Buffer.from('OggSvoice');
    const source = join(status.dir, 'processed-voice');
    writeFileSync(source, bytes);
    status.client.files = [listed({
      filename: 'voice.ogg', mime: 'audio/ogg', size: bytes.length,
      status: 'processed', kind: 'voice_message',
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      filename: 'voice.ogg', mime: 'audio/ogg', kind: 'voice_message',
    }));
    await status.channel.drain();
    const save = status.client.calls.find(call => call.name === 'save_file');
    expect(save?.args?.wire_id).toBe(FILE_WIRE);
    expect(String(save?.args?.dest_path)).toMatch(
      new RegExp(`/\\.recovered-${FILE_WIRE}-[a-f0-9-]{36}$`));
    expect(status.client.calls.some(call => call.name === 'get_files')).toBe(false);
    expect(String(status.queuePrompt.mock.calls[0][0])).toContain('category restart_recovery');
    status.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Recovered.' });
    await vi.waitFor(() => expect(status.client.calls.some(call => call.args?.text === 'Recovered.')).toBe(true));
    expect(JSON.parse(readFileSync(join(status.dir,
      '.owner-channel-attachment-recovery.json'), 'utf8')).pending).toEqual([]);
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

describe('attachment admission and recovery primitives', () => {
  it('sanitizes traversal names and rejects symlinked or hash-mismatched daemon paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ours-admission-'));
    dirs.push(root);
    const dir = await prepareAttachmentDirectory(join(root, 'inbox'), 'request');
    expect(sanitizeFilename('../../\\..\\secret?.txt')).toBe('secret_.txt');
    const source = join(root, 'source');
    const link = join(root, 'link');
    writeFileSync(source, 'hello');
    symlinkSync(source, link);
    const base: RetrievedAttachment = {
      ...(listed() as unknown as IncomingAttachment), fileId: 7, wireId: FILE_WIRE,
      senderId: OWNER, senderName: 'Phone', filename: '../../secret.txt', mime: 'text/plain',
      size: 5, status: 'processed', date: '', kind: 'file', replyTo: null,
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
