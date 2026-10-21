import { constants } from 'node:fs';
import { open, readlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
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
/** The agent's provided path, resolved from its working directory; no export subtree. */
export function chatFilePath(cwd: string, input: string): string {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f]/.test(input)) throw Error('INVALID_CHAT_FILE_PATH');
  return resolve(cwd, input);
}
/**
 * Runs in the harness bridge, never in the supervisor's OS context. Ancestor
 * symlinks resolve normally; the named file itself must be one regular,
 * singly-linked file within the size limit. `path` is the opened file's real path.
 */
export async function openChatFile(cwd: string, input: string): Promise<{ file: FileHandle; path: string }> {
  if (process.platform !== 'linux') throw Error('CHAT_FILE_REQUIRES_LINUX');
  let file: FileHandle;
  try { file = await open(chatFilePath(cwd, input), FLAGS); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof Error && error.message === 'INVALID_CHAT_FILE_PATH') throw error;
    throw Error(code === 'ELOOP' ? 'CHAT_FILE_IS_SYMLINK' : code === 'ENOENT' || code === 'ENOTDIR' ? 'CHAT_FILE_NOT_FOUND'
      : code === 'EACCES' || code === 'EPERM' ? 'CHAT_FILE_NOT_READABLE' : 'CHAT_FILE_OPEN_FAILED');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Error('CHAT_FILE_NOT_REGULAR');
    if (stat.nlink !== 1) throw Error('CHAT_FILE_HARDLINKED');
    if (stat.size > MAX_FILE_BYTES) throw Error('FILE_EXCEEDS_20_MIB');
    return { file, path: await readlink(`/proc/self/fd/${file.fd}`) };
  } catch (error) { await file.close(); throw error; }
}
