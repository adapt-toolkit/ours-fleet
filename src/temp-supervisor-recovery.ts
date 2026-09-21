import { spawn } from 'node:child_process';
import { runTemp, SupervisorRecycleRequiredError } from './runner.js';

export const TEMP_RECYCLE_EXIT = 75;
/** Keep the service's main process alive while replacing a PID-scoped worker. */
export async function runTempSupervisor(
  name: string,
  entrypoint: string,
  initial: () => Promise<void> = () => runTemp(name),
): Promise<void> {
  try {
    await initial();
    return;
  } catch (error) {
    if (!(error instanceof SupervisorRecycleRequiredError)) throw error;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const child = spawn(process.execPath, [entrypoint, '_run-temp-worker', name], {
      stdio: 'inherit',
      env: process.env,
    });
    let stopping = false;
    const term = () => {
        stopping = true;
        child.kill('SIGTERM');
      },
      interrupt = () => {
        stopping = true;
        child.kill('SIGINT');
      };
    process.on('SIGTERM', term);
    process.on('SIGINT', interrupt);
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
    } finally {
      process.off('SIGTERM', term);
      process.off('SIGINT', interrupt);
    }
    if (code === 0 || stopping) return;
    if (code !== TEMP_RECYCLE_EXIT)
      throw Error(`Temporary supervisor replacement exited with ${code}`);
  }
  throw Error(
    'Temporary supervisor recycle limit reached; identity retained for explicit recovery',
  );
}
