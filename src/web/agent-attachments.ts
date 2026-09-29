import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FleetError } from '../application/errors.js';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_BODY = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4096;
export interface AgentAttachment { id: string; name: string; mimeType: string; size: number; sha256: string; generation: string }
function fail(message: string): never { throw new FleetError('invalid_request', message); }
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function directory(path: string, create = false, privateStorage = true): void {
  if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & (privateStorage ? 0o022 : 0o002)))
    fail('Attachment directory is not a private owned directory');
}
function read(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > max)
      fail('Attachment is not a bounded owned regular file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function immutable(path: string, bytes: Buffer): void {
  try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o400 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!read(path, bytes.length).equals(bytes)) fail('Attachment content changed');
  }
}
function filename(name: string): string {
  const chars = Array.from(name.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '_'));
  while (Buffer.byteLength(chars.join('')) > 120) chars.pop();
  return chars.join('') || 'file';
}
export function storeAgentAttachment(stateDir: string, generation: string, input: unknown): AgentAttachment {
  if (!input || typeof input !== 'object') fail('File data is required');
  const body = input as Record<string, unknown>;
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 240 || /[\x00-\x1f]/u.test(body.name)) fail('A file name of 1–240 characters is required');
  if (typeof body.mimeType !== 'string' || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(body.mimeType)) fail('A valid media type is required');
  if (typeof body.data !== 'string' || body.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || /[^A-Za-z0-9+/=]/.test(body.data)) fail('Invalid base64 file data or file exceeds 20 MiB');
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== body.data) fail('Invalid file data or file exceeds 20 MiB');
  const sha256 = digest(bytes), name = body.name, mimeType = body.mimeType;
  const id = digest(JSON.stringify({ generation, name, mimeType, sha256 }));
  const record: AgentAttachment = { id, name, mimeType, size: bytes.length, sha256, generation };
  // Fleet runtime state directories may use the account group (0775). Upload storage remains private.
  directory(stateDir, false, false); const root = join(stateDir, 'web-attachments'); directory(root, true);
  const dir = join(root, id); directory(dir, true);
  immutable(join(dir, 'content-' + filename(name)), bytes);
  immutable(join(dir, 'metadata.json'), Buffer.from(JSON.stringify(record)));
  return record;
}
export function attachmentPrompt(stateDir: string, generation: string, ids: unknown, text: string): string {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || new Set(ids).size !== ids.length) fail('Select between 1 and 5 distinct attachments');
  // Fleet runtime state directories may use the account group (0775). Upload storage remains private.
  directory(stateDir, false, false); const root = join(stateDir, 'web-attachments'); directory(root);
  const files = ids.map(id => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('Invalid attachment ID');
    const dir = join(root, id); directory(dir);
    const record = JSON.parse(read(join(dir, 'metadata.json'), 4096).toString()) as AgentAttachment;
    if (record.id !== id || record.generation !== generation) throw new FleetError('stale_state', 'Attachment belongs to a different agent session');
    const file = join(dir, 'content-' + filename(record.name)), bytes = read(file, MAX_ATTACHMENT_BYTES);
    if (bytes.length !== record.size || digest(bytes) !== record.sha256 || digest(JSON.stringify({generation, name:record.name, mimeType:record.mimeType, sha256:record.sha256})) !== id) fail('Attachment content changed');
    return { name: record.name, mimeType: record.mimeType, size: record.size, sha256: record.sha256, path: file };
  });
  return `${text}${text ? '\n\n' : ''}Attached files (available on this host; open the files to inspect their contents, and use the image viewer for images):\n${JSON.stringify(files, null, 2)}`;
}

/** Authenticated content access reuses the same ownership and integrity checks as admission. */
function attachmentMetadata(stateDir: string, id: string): AgentAttachment {
  if (!/^[a-f0-9]{64}$/.test(id)) fail('Invalid attachment ID');
  directory(stateDir, false, false);
  const root = join(stateDir, 'web-attachments'); directory(root);
  const dir = join(root, id); directory(dir);
  const record = JSON.parse(read(join(dir, 'metadata.json'), 4096).toString()) as AgentAttachment;
  if (record.id !== id || typeof record.name !== 'string' || typeof record.mimeType !== 'string') fail('Invalid attachment metadata');
  if (digest(JSON.stringify({ generation: record.generation, name: record.name, mimeType: record.mimeType, sha256: record.sha256 })) !== id) fail('Attachment metadata changed');
  return record;
}
export function readAgentAttachment(stateDir: string, id: string): { record: AgentAttachment; bytes: Buffer } {
  let record: AgentAttachment;
  try { record = attachmentMetadata(stateDir, id); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FleetError('resource_not_found', 'Attachment not found');
    throw error;
  }
  const bytes = read(join(stateDir, 'web-attachments', id, 'content-' + filename(record.name)), MAX_ATTACHMENT_BYTES);
  if (bytes.length !== record.size || digest(bytes) !== record.sha256) fail('Attachment content changed');
  return { record, bytes };
}

interface AttachmentPresentation { generation: string; commandId: string; text: string; transportDigest: string; ids: string[] }
/** Written before admission so a lost HTTP response cannot lose the visible message. */
export function storeAttachmentPresentation(stateDir: string, value: AttachmentPresentation): void {
  directory(stateDir, false, false);
  const root = join(stateDir, 'web-attachment-messages'); directory(root, true);
  immutable(join(root, digest(JSON.stringify([value.generation, value.commandId])) + '.json'), Buffer.from(JSON.stringify(value)));
}
export function prepareAttachmentPresentation(stateDir: string, generation: string, commandId: string, ids: string[], text: string, transport: string): void {
  storeAttachmentPresentation(stateDir, { generation, commandId, ids, text, transportDigest: digest(transport) });
}
/** Never infer attachments by stripping user text or interpreting a marker. */
export function presentAttachmentEvent<T>(stateDir: string | undefined, roleId: string, event: T): T {
  const e = event as any;
  if (!stateDir || e.kind !== 'prompt.admitted' || e.source !== 'owner_admin_console' || !e.commandId || e.payload?.text?.redacted) return event;
  const root = join(stateDir, 'web-attachment-messages');
  if (!existsSync(root)) return event;
  const path = join(root, digest(JSON.stringify([e.sessionGeneration, e.commandId])) + '.json');
  if (!existsSync(path)) return event;
  try {
    directory(stateDir, false, false); directory(root);
    const value = JSON.parse(read(path, 1024 * 1024).toString()) as AttachmentPresentation;
    if (value.generation !== e.sessionGeneration || value.commandId !== e.commandId || value.transportDigest !== digest(e.payload.text.text)) return event;
    const attachments = value.ids.map(id => {
      const record = attachmentMetadata(stateDir, id);
      if (record.generation !== value.generation) fail('Attachment session changed');
      return { id, name: record.name, mimeType: record.mimeType, size: record.size, url: `/api/v1/roles/${encodeURIComponent(roleId)}/attachments/${id}` };
    });
    return { ...e, payload: { ...e.payload, text: { type: 'text', text: value.text, bytes: Buffer.byteLength(value.text) }, displayText: { type: 'text', text: value.text, bytes: Buffer.byteLength(value.text) }, attachments } };
  } catch { return event; }
}
