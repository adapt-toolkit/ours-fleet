import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { ReportArtifact } from './types.js';

export interface WriteArtifactOptions {
  output: string;
  overwrite?: boolean;
}

/** Atomic file delivery. Existing files are preserved unless overwrite is explicit. */
export async function writeReportArtifact(
  artifact: ReportArtifact, options: WriteArtifactOptions,
): Promise<{ path: string; overwritten: boolean }> {
  const target = resolve(options.output);
  if (!target.toLowerCase().endsWith('.html')) throw new Error('report output must use the .html extension');
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  let existed = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(artifact.html, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    if (!options.overwrite) {
      await link(temporary, target);
      await unlink(temporary);
      return { path: target, overwritten: false };
    }
    existed = await lstat(target).then(() => true, () => false);
    await rename(temporary, target);
    return { path: target, overwritten: existed };
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
