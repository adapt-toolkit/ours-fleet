import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FleetError } from '../application/errors.js';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_BODY = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4096;
export interface AgentAttachment { id: string; name: string; mimeType: string; size: number; sha256: string; generation: string }
function fail(message: string): never { throw new FleetError('invalid_request', message); }
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function directory(path: string, create = false): void {
  if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022))
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
  directory(stateDir); const root = join(stateDir, 'web-attachments'); directory(root, true);
  const dir = join(root, id); directory(dir, true);
  immutable(join(dir, 'content-' + filename(name)), bytes);
  immutable(join(dir, 'metadata.json'), Buffer.from(JSON.stringify(record)));
  return record;
}
export function attachmentPrompt(stateDir: string, generation: string, ids: unknown, text: string): string {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || new Set(ids).size !== ids.length) fail('Select between 1 and 5 distinct attachments');
  directory(stateDir); const root = join(stateDir, 'web-attachments'); directory(root);
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
