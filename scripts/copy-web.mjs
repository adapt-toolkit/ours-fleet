import { cpSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.env.OURS_FLEET_WEB_SOURCE;
if (root) {
  const source = resolve(root);
  const pin = JSON.parse(readFileSync(new URL('../web-source.json', import.meta.url)));
  const version = JSON.parse(readFileSync(resolve(source, 'version.json')));
  if (version.sha !== pin.commit || !existsSync(resolve(source, 'fleet-index.html')) || !existsSync(resolve(source, 'sw.js'))) throw Error('Fleet web artifact does not match its pinned app source');
  cpSync(source, new URL('../dist/web-app', import.meta.url), { recursive: true });
} else if (process.env.GITHUB_ACTIONS === 'true') {
  throw Error('Release/CI build requires the pinned Fleet web artifact');
}
