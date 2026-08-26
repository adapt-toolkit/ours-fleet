import { parseAllDocuments } from 'yaml';

/** Resource kinds implemented by this first, intentionally unwired schema slice. */
export type ResourceKind = 'Role' | 'Brain';

export interface ResourceMeta {
  kind: ResourceKind;
  version: 1;
  id: string;
  display_name?: string;
}

export interface RoleSpec {
  bio?: string;
  persona?: string;
  mission?: string;
  capabilities?: string[];
}

export interface BrainSpec {
  harness: string;
  model: string;
  effort: string;
  session: string;
}

export type BrainRef = { template: string } | BrainSpec;

export interface RoleResource extends ResourceMeta { kind: 'Role'; spec: RoleSpec }
export interface BrainResource extends ResourceMeta { kind: 'Brain'; spec: BrainSpec }

export type TypedResource = RoleResource | BrainResource;

export class ResourceValidationError extends Error {
  constructor(readonly sourceFile: string, readonly fieldPath: string, message: string) {
    super(`${sourceFile}:${fieldPath}: ${message}`);
  }
}

const RESOURCE_ID = /^[A-Za-z0-9_-]+$/u;
const STABLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
export const MAX_ROLE_TEXT_BYTES = 64 * 1024;
export const MAX_CAPABILITIES = 64;
export const MAX_CAPABILITY_BYTES = 128;
export const MAX_BRAIN_FIELD_BYTES = 256;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function objectAt(value: unknown, source: string, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new ResourceValidationError(source, path, 'must be a mapping');
  return value;
}

function exactKeys(
  value: Record<string, unknown>, allowed: readonly string[], source: string, path: string,
): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (extras.length)
    throw new ResourceValidationError(source, path, `unknown key(s): ${extras.join(', ')}`);
}

function stringAt(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || !value.length)
    throw new ResourceValidationError(source, path, 'must be a non-empty string');
  if (value !== value.trim())
    throw new ResourceValidationError(source, path, 'must not have leading or trailing whitespace');
  return value;
}

function boundedStringAt(
  value: unknown, maxBytes: number, source: string, path: string,
): string {
  const result = stringAt(value, source, path);
  if (Buffer.byteLength(result, 'utf8') > maxBytes)
    throw new ResourceValidationError(source, path, `must be at most ${maxBytes} UTF-8 bytes`);
  return result;
}

function stableTokenAt(
  value: unknown, maxBytes: number, source: string, path: string,
): string {
  const result = boundedStringAt(value, maxBytes, source, path);
  if (!STABLE_TOKEN.test(result))
    throw new ResourceValidationError(source, path, 'must be a stable ASCII token');
  return result;
}

function resourceIdAt(value: unknown, source: string, path: string): string {
  const result = stringAt(value, source, path);
  if (!RESOURCE_ID.test(result))
    throw new ResourceValidationError(source, path, 'must match [A-Za-z0-9_-]+');
  return result;
}

function resourceMeta(raw: Record<string, unknown>, source: string): ResourceMeta {
  exactKeys(raw, ['kind', 'version', 'id', 'display_name', 'spec'], source, '$');
  const kind = stringAt(raw.kind, source, '$.kind');
  if (!['Role', 'Brain'].includes(kind))
    throw new ResourceValidationError(source, '$.kind', `unsupported resource kind '${kind}'`);
  if (raw.version !== 1)
    throw new ResourceValidationError(source, '$.version', 'must be 1');
  const id = resourceIdAt(raw.id, source, '$.id');
  const displayName = raw.display_name === undefined
    ? undefined : stringAt(raw.display_name, source, '$.display_name');
  return { kind: kind as ResourceKind, version: 1, id, ...(displayName ? { display_name: displayName } : {}) };
}

export function parseBrainRef(value: unknown, source = 'config', path = '$.brain'): BrainRef {
  const raw = objectAt(value, source, path);
  const keys = Object.keys(raw).sort();
  if (keys.length === 1 && keys[0] === 'template')
    return { template: resourceIdAt(raw.template, source, `${path}.template`) };
  const inline = ['effort', 'harness', 'model', 'session'];
  if (keys.length !== inline.length || keys.some((key, index) => key !== inline[index]))
    throw new ResourceValidationError(
      source, path,
      'must contain exactly {template} or all and only {harness, model, effort, session}',
    );
  return {
    harness: boundedStringAt(raw.harness, MAX_BRAIN_FIELD_BYTES, source, `${path}.harness`),
    model: boundedStringAt(raw.model, MAX_BRAIN_FIELD_BYTES, source, `${path}.model`),
    effort: boundedStringAt(raw.effort, MAX_BRAIN_FIELD_BYTES, source, `${path}.effort`),
    session: boundedStringAt(raw.session, MAX_BRAIN_FIELD_BYTES, source, `${path}.session`),
  };
}

function roleSpec(value: unknown, source: string): RoleSpec {
  const raw = objectAt(value, source, '$.spec');
  exactKeys(raw, ['bio', 'persona', 'mission', 'capabilities'], source, '$.spec');
  const capabilities = raw.capabilities;
  if (capabilities !== undefined && !Array.isArray(capabilities))
    throw new ResourceValidationError(source, '$.spec.capabilities', 'must be a list of non-empty strings');
  if (capabilities && capabilities.length > MAX_CAPABILITIES)
    throw new ResourceValidationError(
      source, '$.spec.capabilities', `must contain at most ${MAX_CAPABILITIES} entries`);
  const normalized = capabilities?.map((item, index) => stableTokenAt(
    item, MAX_CAPABILITY_BYTES, source, `$.spec.capabilities[${index}]`));
  if (normalized && new Set(normalized).size !== normalized.length)
    throw new ResourceValidationError(source, '$.spec.capabilities', 'must not contain duplicates');
  return {
    ...(raw.bio === undefined ? {} : { bio: boundedStringAt(raw.bio, MAX_ROLE_TEXT_BYTES, source, '$.spec.bio') }),
    ...(raw.persona === undefined ? {} : { persona: boundedStringAt(raw.persona, MAX_ROLE_TEXT_BYTES, source, '$.spec.persona') }),
    ...(raw.mission === undefined ? {} : { mission: boundedStringAt(raw.mission, MAX_ROLE_TEXT_BYTES, source, '$.spec.mission') }),
    ...(normalized ? { capabilities: normalized } : {}),
  };
}

function brainSpec(value: unknown, source: string, path = '$.spec'): BrainSpec {
  const parsed = parseBrainRef(value, source, path);
  if ('template' in parsed)
    throw new ResourceValidationError(source, path, 'Brain resources require a complete inline definition');
  return parsed;
}

export function parseTypedResource(sourceFile: string, sourceText: string): TypedResource {
  const documents = parseAllDocuments(sourceText);
  if (documents.length !== 1)
    throw new ResourceValidationError(sourceFile, '$', 'must contain exactly one YAML document');
  const document = documents[0];
  if (document.errors.length)
    throw new ResourceValidationError(sourceFile, '$', document.errors[0].message);
  const raw = objectAt(document.toJS(), sourceFile, '$');
  const meta = resourceMeta(raw, sourceFile);
  if (meta.kind === 'Role') return { ...meta, kind: 'Role', spec: roleSpec(raw.spec, sourceFile) };
  return { ...meta, kind: 'Brain', spec: brainSpec(raw.spec, sourceFile) };
}
