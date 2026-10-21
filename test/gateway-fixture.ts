import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Metadata only; tests inject an SDK client. Transport tests use a real gateway separately. */
export function gatewayFixture(root: string, serverUrl = 'http://127.0.0.1:43118') {
  const profile = { serverUrl, endpoint: serverUrl + '/daemon', expectedInstanceId: '11111111-2222-3333-4444-555555555555', credentialPath: join(root, 'credential') };
  const configPath = join(root, 'gateway-profile.json');
  writeFileSync(configPath, JSON.stringify(profile), { mode: 0o600 });
  return { profile, env: { OURS_CONFIG: configPath } };
}
