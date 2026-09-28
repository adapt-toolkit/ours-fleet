// Local Fleet gateway. All sensitive configuration is read from a private JSON file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startWebConsole } from '../dist/web/runtime.js';
import { createPrefixGateway } from '../dist/web/prefix-gateway.js';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const app = await startWebConsole({
  configPath: config.fleetConfig, webStateDir: config.webStateDir,
  staticRoot: config.staticRoot, control: false, port: config.fleetPort, open: false,
  publicOrigin: config.publicOrigin, binPath: resolve('dist/cli.js'),
});
const gateway = createPrefixGateway({ auth: app.auth,
  fleetOrigin: `http://127.0.0.1:${config.fleetPort}`, services: config.services ?? [] });
await new Promise((resolve, reject) => {
  gateway.server.once('error', reject);
  gateway.server.listen(config.port, '127.0.0.1', resolve);
});
console.log(`Fleet gateway listening on 127.0.0.1:${config.port}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  await gateway.close(); await app.close(); process.exit(0);
});
