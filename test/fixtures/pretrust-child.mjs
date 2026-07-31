/**
 * One child process in the concurrent pre-trust test. Runs the REAL built
 * `pretrust`, so the lock and the atomic replace are exercised across processes
 * rather than simulated in one.
 *
 * argv: <distDir> <ourFleetHome> <projectPath>
 * env PRETRUST_ABORT_BEFORE_RENAME=1 — write the temp file, then die before the
 * rename, to prove an interrupted write cannot damage the last good file.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [distDir, fleetHome, projectPath] = process.argv.slice(2);
process.env.OURS_FLEET_HOME = fleetHome;

if (process.env.PRETRUST_ABORT_BEFORE_RENAME === '1') {
  const { withFileLock, replaceFileAtomically } = await import(
    pathToFileURL(join(distDir, 'atomic-file.js')).href);
  const target = join(fleetHome, '.claude.json');
  await withFileLock(`${target}.lock`, () => {
    // Emulate dying between "temp file written" and "rename": do the temp-file
    // half by hand, then exit hard.
    replaceFileAtomically(join(fleetHome, '.abandoned-temp'), 'x'.repeat(1024));
    process.exit(9);
  });
} else {
  const { pretrust } = await import(pathToFileURL(join(distDir, 'harness/claude-code.js')).href);
  await pretrust(projectPath);
}
