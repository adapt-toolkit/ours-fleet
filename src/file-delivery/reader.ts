import { constants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export interface ExportRoot { path: string; dev: number; ino: number }
/** Pin every component; neither trusted root ancestors nor agent components follow symlinks. */
export async function openDirectory(path: string): Promise<FileHandle> {
  if (process.platform !== 'linux' || !isAbsolute(path) || path !== resolve(path)) throw Error('FILE_DELIVERY_REQUIRES_LINUX_ROOT');
  let dir = await open('/', FLAGS | constants.O_DIRECTORY);
  try {
    for (const part of path.split('/').filter(Boolean)) {
      const next = await open(`/proc/self/fd/${dir.fd}/${part}`, FLAGS | constants.O_DIRECTORY);
      await dir.close(); dir = next;
    }
    return dir;
  } catch (error) { await dir.close(); throw error; }
}
export async function pinExportRoot(path: string): Promise<{ root: ExportRoot; handle: FileHandle }> {
  const handle = await openDirectory(path);
  try {
    const stat = await handle.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw Error('EXPORT_ROOT_NOT_PRIVATE_OWNED');
    return { root: { path, dev: stat.dev, ino: stat.ino }, handle };
  } catch (error) { await handle.close(); throw error; }
}
export function exportPath(root: ExportRoot, cwd: string, input: string): string[] {
  if (!input || input.length > 4096 || /[\\\x00-\x1f]/.test(input) || input.split('/').some(p => p === '.' || p === '..' || !p) && !isAbsolute(input)) throw Error('INVALID_EXPORT_PATH');
  if (input.split('/').some(p => p === '..' || p === '.')) throw Error('INVALID_EXPORT_PATH');
  const path = relative(root.path, resolve(cwd, input));
  const parts = path.split('/');
  if (!path || isAbsolute(path) || parts.some(p => !p || p === '..' || p === '.' || p.startsWith('.') || /^(credentials?|secrets?|tokens?)(\.|$)/i.test(p))) throw Error('OUTSIDE_EXPORT_DIRECTORY');
  return parts;
}
/** Runs in the harness bridge, never in the supervisor's OS context. */
export async function openExportFile(root: ExportRoot, cwd: string, input: string): Promise<FileHandle> {
  const parts = exportPath(root, cwd, input);
  let dir = await openDirectory(root.path);
  try {
    const stat = await dir.stat();
    if (stat.dev !== root.dev || stat.ino !== root.ino) throw Error('EXPORT_ROOT_CHANGED');
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${dir.fd}/${part}`, FLAGS | constants.O_DIRECTORY);
      await dir.close(); dir = next;
    }
    const file = await open(`/proc/self/fd/${dir.fd}/${parts.at(-1)}`, FLAGS);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw Error('INVALID_EXPORT_FILE');
      return file;
    } catch (error) { await file.close(); throw error; }
  } finally { await dir.close(); }
}

export async function ensureExportDirectory(cwd: string, directory: string): Promise<void> {
  let dir = await openDirectory(cwd);
  try {
    for (const part of directory.split('/')) {
      if (!part || part.startsWith('.') || /[\\\x00-\x1f]/.test(part)) throw Error('INVALID_EXPORT_DIRECTORY');
      const path = `/proc/self/fd/${dir.fd}/${part}`;
      await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const next = await open(path, FLAGS | constants.O_DIRECTORY);
      await dir.close(); dir = next;
    }
  } finally { await dir.close(); }
}
