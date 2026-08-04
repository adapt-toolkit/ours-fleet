import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, stateDir] = process.argv.slice(2);
const { acquireOwnerBinderLease } = await import(
  pathToFileURL(join(dist, 'owner-channel', 'binder.js')).href
);

const waitForClaim = () => new Promise(resolve => {
  process.send?.({ kind: 'observed' });
  const receive = message => {
    if (message?.kind !== 'claim') return;
    process.off('message', receive);
    resolve();
  };
  process.on('message', receive);
});

try {
  const lease = await acquireOwnerBinderLease(
    stateDir,
    'Coordinator',
    'Coordinator-Channel',
    {
      alive: pid => pid !== 424242,
      processMarker: () => undefined,
      beforeReclaim: waitForClaim,
    },
    1_000,
  );
  process.send?.({ kind: 'acquired' });
  process.on('message', message => {
    if (message?.kind === 'check') {
      const owner = JSON.parse(readFileSync(
        join(stateDir, '.owner-channel-binder.lock', 'owner.json'), 'utf8'));
      process.send?.({ kind: 'owned', owned: owner.pid === process.pid });
    }
    if (message?.kind === 'release') {
      lease.release();
      process.exit(0);
    }
  });
} catch (error) {
  process.send?.({ kind: 'rejected', error: String(error) }, () => process.exit(0));
}
