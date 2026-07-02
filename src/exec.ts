import { execFile } from 'node:child_process';

export interface ExecResult { stdout: string; stderr: string; code: number }
export type Exec = (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

/** execFile wrapper that never rejects; missing binary → code 127. */
export const realExec: Exec = (cmd, args, opts) =>
  new Promise(resolve => {
    execFile(cmd, args, { env: opts?.env ?? process.env, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const c = (err as NodeJS.ErrnoException).code;
          code = typeof c === 'number' ? c : c === 'ENOENT' ? 127 : 1;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      });
  });

/** POSIX single-quote shell escaping. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
