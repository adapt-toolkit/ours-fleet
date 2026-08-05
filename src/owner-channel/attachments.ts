import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync,
} from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { replaceFileAtomically } from '../atomic-file.js';
import type { OwnerAttachmentConfig } from '../config.js';

const WIRE = /^[A-Fa-f0-9]{64}$/;
const CID = /^[A-Fa-f0-9]{64}$/;
const MAX_PENDING_REQUESTS = 32;

export interface AttachmentReplyRef { wire_id: string; sentence?: number }

export interface IncomingAttachment {
  fileId: number;
  wireId: string;
  senderId: string;
  senderName: string;
  filename: string;
  mime: string;
  size: number;
  status: string;
  date: string;
  kind: 'file' | 'voice_message';
  replyTo: AttachmentReplyRef | null;
}

export interface VoiceTranscription {
  configured: boolean;
  attempted: boolean;
  status: 'succeeded' | 'failed' | 'unavailable';
  provider: string | null;
  text: string | null;
  errorCategory: string | null;
  audioPath: string;
  fileWireId: string;
}

export interface RetrievedAttachment extends IncomingAttachment {
  path: string;
  sha256: string;
  transcription?: VoiceTranscription;
}

export interface AdmittedAttachment {
  wireId: string;
  filename: string;
  path: string;
  declaredMime: string;
  detectedMime: string;
  size: number;
  sha256: string;
  kind: 'file' | 'voice_message';
  transcription?: Omit<VoiceTranscription, 'audioPath'>;
}

export function parseIncomingAttachments(raw: unknown): IncomingAttachment[] {
  const values = (raw as { files?: unknown })?.files;
  if (!Array.isArray(values)) return [];
  const out: IncomingAttachment[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const file = value as Record<string, unknown>;
    const from = file.from as Record<string, unknown> | undefined;
    const reply = file.reply_to as Record<string, unknown> | null | undefined;
    const wireId = String(file.wire_id ?? '');
    const senderId = String(from?.id ?? '');
    const size = Number(file.size);
    const fileId = Number(file.file_id);
    if (!WIRE.test(wireId) || !CID.test(senderId) || !Number.isSafeInteger(size) || size < 0
        || !Number.isSafeInteger(fileId) || fileId < 1) continue;
    const replyWire = String(reply?.wire_id ?? '');
    out.push({
      fileId, wireId, senderId, senderName: safeField(from?.name, 160),
      filename: safeField(file.filename, 255), mime: String(file.mime ?? '').toLowerCase(),
      size, status: String(file.status ?? ''), date: safeField(file.date, 80),
      kind: file.kind === 'voice_message' ? 'voice_message' : 'file',
      replyTo: WIRE.test(replyWire) ? { wire_id: replyWire,
        ...(Number.isSafeInteger(reply?.sentence) && Number(reply?.sentence) > 0
          ? { sentence: Number(reply?.sentence) } : {}) } : null,
    });
  }
  return out;
}

export function parseRetrievedAttachments(
  raw: unknown, expected: IncomingAttachment[], recovered = false,
): RetrievedAttachment[] {
  const values = (raw as { files?: unknown })?.files;
  if (!Array.isArray(values) || values.length !== expected.length)
    throw new Error('ours-mcp returned an incomplete selected attachment set');
  const byWire = new Map(expected.map(file => [file.wireId, file]));
  const out: RetrievedAttachment[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') throw new Error('ours-mcp returned invalid attachment metadata');
    const file = value as Record<string, unknown>;
    const wireId = String(file.wire_id ?? '');
    const listed = byWire.get(wireId);
    const from = file.from as Record<string, unknown> | undefined;
    const size = Number(file.size);
    const sha256 = String(file.sha256 ?? '');
    const mime = String(file.mime ?? '').toLowerCase();
    const kind = file.kind === 'voice_message' ? 'voice_message' : 'file';
    if (!listed || String(from?.id ?? '') !== listed.senderId
        || !Number.isSafeInteger(size) || size !== listed.size || mime !== listed.mime
        || kind !== listed.kind || !/^[a-f0-9]{64}$/.test(sha256)
        || typeof file.path !== 'string' || !file.path)
      throw new Error('ours-mcp selected attachment provenance or integrity metadata mismatched');
    out.push({
      ...listed, filename: safeField(file.filename, 255), mime, size, path: file.path, sha256, kind,
      ...(recovered ? {} : parseTranscription(file.transcription, wireId)),
    });
    byWire.delete(wireId);
  }
  if (byWire.size) throw new Error('ours-mcp omitted a selected attachment');
  return out;
}

function parseTranscription(value: unknown, wireId: string): { transcription?: VoiceTranscription } {
  if (!value || typeof value !== 'object') return {};
  const item = value as Record<string, unknown>;
  if (!['succeeded', 'failed', 'unavailable'].includes(String(item.status ?? ''))
      || String(item.file_wire_id ?? '') !== wireId) return {};
  const status = item.status as VoiceTranscription['status'];
  return { transcription: {
    configured: item.configured === true, attempted: item.attempted === true, status,
    provider: typeof item.provider === 'string' ? safeField(item.provider, 80) : null,
    text: status === 'succeeded' && typeof item.text === 'string'
      ? safeField(item.text, 16_000) : null,
    errorCategory: typeof item.error_category === 'string'
      ? safeField(item.error_category, 80) : null,
    audioPath: typeof item.audio_path === 'string' ? item.audio_path : '',
    fileWireId: wireId,
  } };
}

// Voice notes ride "<base>; x-ours-kind=voice-message" verbatim end to end
// (the recorder's real container varies: audio/webm Chrome/Android, audio/mp4
// iOS Safari, audio/ogg fallback), so policy for voice messages applies to the
// base container type. Ordinary files keep exact allowlist matching.
function baseMime(mime: string): string {
  return mime.split(';')[0].trim();
}

function policyMime(file: Pick<IncomingAttachment, 'mime' | 'kind'>): string {
  return file.kind === 'voice_message' ? baseMime(file.mime) : file.mime;
}

export function validateAttachmentSelection(
  files: IncomingAttachment[], config: OwnerAttachmentConfig,
): string | undefined {
  if (!config.enabled) return 'attachments are disabled for this owner channel';
  if (files.length > config.max_files_per_request)
    return `the request exceeds the ${config.max_files_per_request}-file limit`;
  let total = 0;
  for (const file of files) {
    const mime = policyMime(file);
    if (file.kind === 'voice_message' && !mime.startsWith('audio/'))
      return `voice-message MIME type ${file.mime || '(missing)'} is not an audio container`;
    if (!config.allowed_mime.includes(mime)) return `MIME type ${file.mime || '(missing)'} is not allowed`;
    if (file.size > config.max_file_bytes)
      return `a file exceeds the ${config.max_file_bytes}-byte limit`;
    total += file.size;
    if (!Number.isSafeInteger(total) || total > config.max_request_bytes)
      return `the request exceeds the ${config.max_request_bytes}-byte total limit`;
  }
  return undefined;
}

/**
 * Managed-agent -> owner egress limits. This intentionally does not consult
 * `enabled` or `allowed_mime`: those are owner -> agent admission policy.
 */
export function validateAttachmentRelaySelection(
  files: IncomingAttachment[], config: OwnerAttachmentConfig,
): string | undefined {
  if (files.length > config.max_files_per_request)
    return `the relay exceeds the ${config.max_files_per_request}-file limit`;
  let total = 0;
  for (const file of files) {
    if (file.size > config.max_file_bytes)
      return `a relayed file exceeds the ${config.max_file_bytes}-byte limit`;
    total += file.size;
    if (!Number.isSafeInteger(total) || total > config.max_request_bytes)
      return `the relay exceeds the ${config.max_request_bytes}-byte total limit`;
  }
  return undefined;
}

export async function prepareAttachmentDirectory(root: string, requestId: string): Promise<string> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('attachment root is not a safe directory');
  chmodSync(root, 0o700);
  const dir = join(root, requestId);
  if (existsSync(dir)) await removeRequestDirectory(dir);
  await mkdir(dir, { mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('attachment request path is not a safe directory');
  await chmod(dir, 0o700);
  return dir;
}

export async function admitAttachments(
  files: RetrievedAttachment[], dir: string, config: OwnerAttachmentConfig,
  options: { mimePolicy?: 'strict' | 'report-only' } = {},
): Promise<AdmittedAttachment[]> {
  const admitted: AdmittedAttachment[] = [];
  let total = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const sourceStat = await lstat(file.path);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
      throw new Error('retrieved attachment path is not a regular file');
    if (sourceStat.size > config.max_file_bytes) throw new Error('retrieved attachment exceeds its size limit');
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== sourceStat.dev || opened.ino !== sourceStat.ino)
        throw new Error('retrieved attachment changed during admission');
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== file.size || digest !== file.sha256)
      throw new Error('retrieved attachment size or hash mismatched structured metadata');
    total += bytes.length;
    if (total > config.max_request_bytes) throw new Error('retrieved attachments exceed the request size limit');
    const declaredMime = policyMime(file);
    const detectedMime = detectMime(bytes, declaredMime);
    if ((options.mimePolicy ?? 'strict') === 'strict'
        && !mimeCompatible(declaredMime, detectedMime))
      throw new Error(`retrieved attachment content does not match declared MIME ${declaredMime}`);
    const filename = sanitizeFilename(file.filename);
    const finalPath = join(dir, `${index + 1}-${file.wireId.slice(0, 12)}-${filename}`);
    const tmp = join(dir, `.${basename(finalPath)}.${randomUUID()}.tmp`);
    const output = await open(tmp, 'wx', 0o600);
    try { await output.writeFile(bytes); await output.sync(); }
    catch (error) { await output.close().catch(() => {}); await rm(tmp, { force: true }); throw error; }
    await output.close();
    try { await link(tmp, finalPath); }
    catch (error) { await rm(tmp, { force: true }); throw error; }
    await rm(tmp, { force: true });
    await chmod(finalPath, 0o600);
    admitted.push({
      wireId: file.wireId, filename, path: finalPath, declaredMime,
      detectedMime, size: bytes.length, sha256: digest, kind: file.kind,
      ...(file.transcription ? { transcription: {
        configured: file.transcription.configured, attempted: file.transcription.attempted,
        status: file.transcription.status, provider: file.transcription.provider,
        text: file.transcription.text, errorCategory: file.transcription.errorCategory,
        fileWireId: file.transcription.fileWireId,
      } } : {}),
    });
  }
  return admitted;
}

export async function recoveredAttachment(
  file: IncomingAttachment, path: string,
): Promise<RetrievedAttachment> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size)
    throw new Error('recovered attachment is not the expected regular file');
  await chmod(path, 0o600);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  return {
    ...file, path, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(file.kind === 'voice_message' ? { transcription: {
      configured: false, attempted: false, status: 'unavailable' as const,
      provider: null, text: null, errorCategory: 'restart_recovery',
      audioPath: path, fileWireId: file.wireId,
    } } : {}),
  };
}

export async function removeRequestDirectory(path: string): Promise<void> {
  let stat;
  try { stat = await lstat(path); } catch { return; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) { await rm(path, { force: true }); return; }
  await rm(path, { recursive: true, force: true });
}

export async function cleanupAttachmentRoot(
  root: string, now: number, retentionMs: number, limit = 256,
): Promise<number> {
  if (!existsSync(root)) return 0;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('attachment root is unsafe');
  let removed = 0;
  for (const name of (await readdir(root)).slice(0, limit)) {
    const path = join(root, name);
    const stat = await lstat(path).catch(() => undefined);
    if (!stat || now - stat.mtimeMs < retentionMs) continue;
    await removeRequestDirectory(path);
    removed++;
  }
  return removed;
}

export interface PendingAttachmentRequest {
  id: string;
  contact: string;
  originWireId: string;
  fileWireIds: string[];
  createdAt: number;
  /** Present only for exact-managed-agent -> owner relay recovery. */
  relayContact?: string;
  relayReplyTo?: string;
}

interface RecoveryFile { version: 1; pending: PendingAttachmentRequest[] }

export class AttachmentRecoveryState {
  private pending: PendingAttachmentRequest[] = [];
  private corrupt = false;
  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RecoveryFile>;
      if (raw.version !== 1 || !Array.isArray(raw.pending) || raw.pending.length > MAX_PENDING_REQUESTS
          || !raw.pending.every(item => validPending(item))) throw new Error('invalid recovery state');
      this.pending = raw.pending.map(item => ({ ...item, fileWireIds: [...item.fileWireIds] }));
      chmodSync(path, 0o600);
    } catch { this.corrupt = true; this.pending = []; try { chmodSync(path, 0o600); } catch {} }
  }
  integrity(): boolean { return !this.corrupt; }
  list(): PendingAttachmentRequest[] {
    this.assertHealthy();
    return this.pending.map(item => ({ ...item, fileWireIds: [...item.fileWireIds] }));
  }
  add(item: PendingAttachmentRequest): void {
    this.assertHealthy();
    if (!validPending(item)) throw new Error('invalid attachment recovery route');
    if (this.pending.some(value => value.id === item.id)) return;
    if (this.pending.length >= MAX_PENDING_REQUESTS) throw new Error('too many pending attachment recoveries');
    this.pending.push({ ...item, fileWireIds: [...item.fileWireIds] }); this.persist();
  }
  remove(id: string): void {
    this.assertHealthy();
    const next = this.pending.filter(item => item.id !== id);
    if (next.length === this.pending.length) return;
    this.pending = next; this.persist();
  }
  cleanup(now: number, retentionMs: number): number {
    this.assertHealthy();
    const old = this.pending.length;
    this.pending = this.pending.filter(item => now - item.createdAt <= retentionMs);
    if (this.pending.length !== old) this.persist();
    return old - this.pending.length;
  }
  private assertHealthy(): void { if (this.corrupt) throw new Error('attachment recovery state is corrupt'); }
  private persist(): void {
    replaceFileAtomically(this.path, JSON.stringify({ version: 1, pending: this.pending }) + '\n', 0o600);
    chmodSync(this.path, 0o600);
  }
}

function validPending(value: unknown): value is PendingAttachmentRequest {
  if (!value || typeof value !== 'object') return false;
  const item = value as PendingAttachmentRequest;
  return /^[a-f0-9]{64}$/.test(item.id) && CID.test(item.contact) && WIRE.test(item.originWireId)
    && Array.isArray(item.fileWireIds) && item.fileWireIds.length >= 1 && item.fileWireIds.length <= 32
    && item.fileWireIds.every(wire => WIRE.test(wire))
    && new Set(item.fileWireIds).size === item.fileWireIds.length
    && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0
    && (item.relayContact === undefined || CID.test(item.relayContact))
    && (item.relayReplyTo === undefined || WIRE.test(item.relayReplyTo))
    && (item.relayReplyTo === undefined || item.relayContact !== undefined);
}

export function safeField(value: unknown, max: number): string {
  return Array.from(String(value ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' '))
    .slice(0, max).join('').trim();
}

export function sanitizeFilename(value: string): string {
  const clean = safeField(basename(value.replace(/\\/g, '/')), 180)
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/, '').trim();
  return clean || 'attachment.bin';
}

function detectMime(bytes: Buffer, declared: string): string {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return declared === 'audio/mp4' ? 'audio/mp4' : 'application/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return declared === 'audio/webm' ? 'audio/webm' : 'video/webm';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'application/zip';
  if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'application/x-cfb';
  const text = bytes.toString('utf8');
  if (!text.includes('\ufffd') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    if (declared === 'application/json') { try { JSON.parse(text); return 'application/json'; } catch {} }
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function mimeCompatible(declared: string, detected: string): boolean {
  if (declared === detected) return true;
  if (['audio/wav', 'audio/x-wav'].includes(declared) && detected === 'audio/wav') return true;
  if (detected === 'application/zip' && declared.startsWith('application/vnd.openxmlformats-officedocument.')) return true;
  if (detected === 'application/x-cfb' && [
    'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  ].includes(declared)) return true;
  return false;
}
