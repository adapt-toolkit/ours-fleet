import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OwnerAttachmentConfig, OwnerChannelConfig } from '../src/config.js';
import {
  AttachmentRecoveryState, admitAttachments, cleanupAttachmentRoot, prepareAttachmentDirectory,
  parseRetrievedAttachments, sanitizeFilename, validateAttachmentSelection,
  type IncomingAttachment, type RetrievedAttachment,
} from '../src/owner-channel/attachments.js';
import { OwnerChannel } from '../src/owner-channel/channel.js';
import type { OursToolClient } from '../src/owner-channel/mcp.js';
import { OwnerConversationState } from '../src/owner-channel/state.js';
import type { QueuedPrompt, SessionHandle, TurnResult } from '../src/session/types.js';

const OWNER = 'A'.repeat(64);
const OTHER = 'B'.repeat(64);
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
  failFile = false;
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
    if (name === 'send_file' && this.failFile) throw new Error('file transport unavailable');
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

async function setup(
  owners = [OWNER], recover = false, attachments = attachmentConfig, agent?: string,
  existingDir?: string,
) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'ours-owner-attachments-'));
  if (!existingDir) dirs.push(dir);
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
    attachments, ...(agent ? { agent } : {}),
  };
  if (recover) new AttachmentRecoveryState(join(dir, '.owner-channel-attachment-recovery.json')).add({
    id: createHash('sha256').update(FILE_WIRE).digest('hex'), contact: OWNER,
    originWireId: FILE_WIRE, fileWireIds: [FILE_WIRE], createdAt: Date.now(),
  });
  const logs: string[] = [];
  const channel = new OwnerChannel({
    role: 'Role', harness: 'claude-code', config, session, stateDir: dir, client, log: line => logs.push(line),
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
    expect(unauthorized.client.calls.some(call => call.name === 'send_message')).toBe(false);
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
    expect(status.client.calls).toContainEqual({ name: 'send_message', args: {
      contact: OWNER, text: 'Attached report.', reply_to_wire_id: ownerWire,
    } });
    expect(status.client.calls).toContainEqual({ name: 'send_file', args: {
      contact: OWNER, path: expect.any(String), filename: 'report.txt',
      reply_to_wire_id: ownerWire,
    } });
    expect(status.client.calls.filter(call =>
      call.args?.text === 'Attached report.' || call.name === 'send_file')
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

    expect(status.client.calls.find(call => call.name === 'send_file')?.args).toMatchObject({
      contact: OWNER, filename: 'response.txt', reply_to_wire_id: FILE_WIRE,
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

    expect(status.client.calls.find(call => call.name === 'send_file')?.args).toMatchObject({
      contact: OTHER, filename: 'idea.txt',
    });
    expect(status.client.calls.find(call => call.name === 'send_file')?.args)
      .not.toHaveProperty('reply_to_wire_id');
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

    expect(status.client.calls.some(call => call.name === 'get_files')).toBe(false);
    expect(status.client.calls.some(call => call.name === 'send_file')).toBe(false);
    expect(status.client.calls.filter(call => call.name === 'send_message')).toEqual([{
      name: 'send_message', args: {
        contact: AGENT, text: expect.stringContaining('queued'), reply_to_wire_id: FILE_WIRE,
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
    expect(status.client.calls.some(call => call.name === 'send_file')).toBe(false);
    expect(status.client.calls).toContainEqual({ name: 'send_message', args: {
      contact: AGENT, text: expect.stringContaining('not relayed'),
      reply_to_wire_id: CAPTION_WIRE,
    } });
    status.client.batches.push([caption], []);
    await status.channel.drain();
    expect(status.client.calls.filter(call => call.args?.contact === AGENT
      && String(call.args?.text).includes('not relayed'))).toHaveLength(1);
    expect(status.client.calls.some(call => call.args?.text === 'Do not emit me alone.')).toBe(false);
    await status.channel.close();
  });

  it('replays a deferred caption with a journaled processed managed-agent file after restart', async () => {
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
    const source = join(dir, 'processed-agent-report');
    writeFileSync(source, bytes);

    const status = await setup([OWNER], false, attachmentConfig, AGENT, dir);
    status.client.batches.push([{
      msg_id: 17, wire_id: CAPTION_WIRE, from: { id: AGENT, name: 'Role' },
      text: 'Recovered caption.', reply_to: { wire_id: ownerWire },
    }], []);
    status.client.files = [listed({
      from: { id: AGENT, name: 'Role' }, filename: 'recovered.txt', size: bytes.length,
      status: 'processed', reply_to: { wire_id: CAPTION_WIRE },
    })];
    status.client.retrieved.set(FILE_WIRE, retrieved(source, bytes, {
      from: { id: AGENT, name: 'Role' }, filename: 'recovered.txt',
      status: 'processed', reply_to: { wire_id: CAPTION_WIRE },
    }));

    await status.channel.drain();

    expect(status.client.calls).toContainEqual({
      name: 'save_file', args: { wire_id: FILE_WIRE, dest_path: expect.any(String) },
    });
    expect(status.client.calls).toContainEqual({ name: 'send_message', args: {
      contact: OWNER, text: 'Recovered caption.', reply_to_wire_id: ownerWire,
    } });
    expect(status.client.calls.find(call => call.name === 'send_file')?.args)
      .toMatchObject({ contact: OWNER, filename: 'recovered.txt', reply_to_wire_id: ownerWire });
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
    expect(status.client.calls.filter(call => call.name === 'send_file')).toHaveLength(1);
    expect(status.client.calls).toContainEqual({ name: 'send_message', args: {
      contact: AGENT, text: expect.stringContaining('uncertain'), reply_to_wire_id: CAPTION_WIRE,
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

describe('voice-message MIME admission', () => {
  // Voice notes ride "<base>; x-ours-kind=voice-message" verbatim end to end
  // (base varies by recorder: audio/webm Chrome/Android, audio/mp4 iOS Safari,
  // audio/ogg fallback). Policy applies to the base container type for voice
  // messages only; ordinary files keep exact allowlist matching.
  const VOICE_PARAM = 'x-ours-kind=voice-message';
  const voiceConfig: OwnerAttachmentConfig = {
    ...attachmentConfig,
    allowed_mime: [...attachmentConfig.allowed_mime, 'audio/webm', 'audio/mp4'],
  };
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

  it('keeps voice admission fail-closed outside the allowlisted audio bases', () => {
    // Base container absent from the allowlist: still rejected.
    expect(validateAttachmentSelection(
      [incoming(`audio/webm; ${VOICE_PARAM}`)], attachmentConfig)).toMatch(/not allowed/);
    // Forged voice marker on a non-audio type: rejected even though the base is allowlisted.
    expect(validateAttachmentSelection(
      [incoming(`application/pdf; ${VOICE_PARAM}`)], voiceConfig)).toBeTruthy();
    // Voice-kind limits unchanged: oversize voice files still fail.
    expect(validateAttachmentSelection(
      [incoming(`audio/webm; ${VOICE_PARAM}`, 'voice_message', { size: 2_000 })],
      voiceConfig)).toMatch(/byte limit/);
  });

  it('leaves ordinary-file policy byte-identical: parameters never match the allowlist', () => {
    expect(validateAttachmentSelection(
      [incoming('audio/webm; codecs=opus', 'file')], voiceConfig)).toMatch(/not allowed/);
    expect(validateAttachmentSelection(
      [incoming(`audio/webm; ${VOICE_PARAM}`, 'file')], voiceConfig)).toMatch(/not allowed/);
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
    expect(admitted.map(file => file.declaredMime)).toEqual(['audio/webm', 'audio/mp4']);
    expect(admitted.map(file => file.kind)).toEqual(['voice_message', 'voice_message']);
  });

  it('still rejects voice bytes whose content contradicts the declared base container', async () => {
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
    await expect(admitAttachments([file], dir, voiceConfig))
      .rejects.toThrow(/does not match declared MIME/);
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
