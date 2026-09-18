import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const PROFILE_FIELDS = ['endpoint', 'expectedInstanceId', 'credentialPath'] as const;
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY_CONFIG_FIELDS = ['apiToken', 'stateDir', 'port'] as const;
const LEGACY_ENV_FIELDS = ['OURS_API_TOKEN', 'OURS_STATE_DIR', 'OURS_PORT', 'OURS_DAEMON_ID'] as const;

export interface ExplicitClientProfile {
  readonly endpoint: string;
  readonly expectedInstanceId: string;
  readonly credentialPath: string;
  readonly configPath: string;
}

export class ClientProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientProfileError';
  }
}

export function clientConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.OURS_CONFIG !== undefined) return env.OURS_CONFIG;
  const managedPath = join(env.HOME || homedir(), '.ours-client', 'profile.json');
  try {
    lstatSync(managedPath);
    return managedPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalid(managedPath, 'could not be read');
    return join(homedir(), '.ours', 'config.json');
  }
}

function invalid(path: string, detail: string): ClientProfileError {
  return new ClientProfileError(`ours client profile ${JSON.stringify(path)} ${detail}`);
}

/**
 * Read Fleet's selected host-client profile without opening its credential.
 * A legacy daemon config remains legacy only when none of the profile fields is
 * present. Explicit and managed selections fail closed on invalid input.
 */
export function readClientProfile(env: NodeJS.ProcessEnv): ExplicitClientProfile | undefined {
  const configPath = clientConfigPath(env);
  const managed = configPath === join(env.HOME || homedir(), '.ours-client', 'profile.json');
  const named = env.OURS_CONFIG !== undefined || managed;
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    if (named) throw invalid(configPath, 'could not be read');
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (named) throw invalid(configPath, 'is not valid JSON');
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (named) throw invalid(configPath, 'must contain a JSON object');
    return undefined;
  }
  const row = parsed as Record<string, unknown>;
  if (!PROFILE_FIELDS.some(field => Object.prototype.hasOwnProperty.call(row, field))) {
    if (managed) throw invalid(configPath, 'must contain a complete client profile');
    return undefined;
  }

  let metadata;
  try { metadata = statSync(configPath); }
  catch { throw invalid(configPath, 'could not be inspected'); }
  if (!metadata.isFile()) throw invalid(configPath, 'must be a regular file');
  const getuid = process.getuid;
  if (getuid && metadata.uid !== getuid()) throw invalid(configPath, 'must be owned by this user');
  if ((metadata.mode & 0o077) !== 0) throw invalid(configPath, 'must not be accessible by group or other users');

  for (const field of PROFILE_FIELDS)
    if (typeof row[field] !== 'string' || !(row[field] as string).trim())
      throw invalid(configPath, `has an invalid or missing ${field}`);

  for (const field of LEGACY_CONFIG_FIELDS)
    if (Object.prototype.hasOwnProperty.call(row, field))
      throw invalid(configPath, `cannot combine ${field} with explicit profile selection`);
  for (const field of LEGACY_ENV_FIELDS)
    if (env[field]?.trim())
      throw invalid(configPath, `cannot combine ${field} with explicit profile selection`);

  const endpoint = (row.endpoint as string).trim();
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw invalid(configPath, 'has an invalid endpoint'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash)
    throw invalid(configPath, 'endpoint must be a local HTTP origin');

  const expectedInstanceId = (row.expectedInstanceId as string).trim();
  if (!LOWERCASE_UUID.test(expectedInstanceId))
    throw invalid(configPath, 'expectedInstanceId must be a lowercase UUID');
  const credentialPath = (row.credentialPath as string).trim();
  if (!isAbsolute(credentialPath))
    throw invalid(configPath, 'credentialPath must be absolute');

  return Object.freeze({
    endpoint: url.origin, expectedInstanceId, credentialPath, configPath,
  });
}

export function clientProfileKey(profile: ExplicitClientProfile): string {
  return `${profile.endpoint}#${profile.expectedInstanceId}`;
}
