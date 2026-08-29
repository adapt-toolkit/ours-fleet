import { stringify } from 'yaml';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyConfigGraphTransaction, type ConfigGraphMutation } from '../config-graph-transaction.js';
import { loadConfigResourceSnapshot } from '../config-resource-loader.js';
import { parseTypedResource, type ResourceKind, type TypedResource } from '../config-resources.js';
import type { ManagementResourceMutation } from './management-contract.js';
import { managementDigest } from './management-operation-store.js';
import { FleetError } from './errors.js';

const DIRECTORIES: Record<ResourceKind, 'roles.d'|'brains.d'|'agents.d'|'room-templates.d'|'rooms.d'|'tasks.d'> = {
  Role: 'roles.d', Brain: 'brains.d', Agent: 'agents.d', RoomTemplate: 'room-templates.d',
  RoomsPolicy: 'rooms.d', TasksPolicy: 'tasks.d',
};
const ID = /^[A-Za-z0-9_-]+$/u;
const own = <T>(value: T): T => structuredClone(value);

export class ResourceManagementService {
  constructor(private readonly bootstrapFile: string) {}
  list(kind?: ResourceKind): { digest: string; resources: TypedResource[] } {
    const snapshot = loadConfigResourceSnapshot({ bootstrapFile: this.bootstrapFile });
    const resources = snapshot.sources.filter(source => !kind || source.kind === kind)
      .map(source => own(source.resource)).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    return { digest: snapshot.digest, resources };
  }
  get(kind: ResourceKind, id: string): { digest: string; resource: TypedResource } {
    const all = this.list(kind); const resource = all.resources.find(item => item.id === id);
    if (!resource) throw new FleetError('resource_not_found', `${kind} '${id}' does not exist`);
    return { digest: all.digest, resource };
  }
  create(resource: TypedResource, expectedDigest: string) { return this.put(resource, expectedDigest, false); }
  update(resource: TypedResource, expectedDigest: string) { return this.put(resource, expectedDigest, true); }
  private async put(resource: TypedResource, expectedDigest: string, mustExist: boolean) {
    const checked = parseTypedResource('management-request', stringify(resource));
    const present = this.list(checked.kind).resources.some(item => item.id === checked.id);
    if (present !== mustExist) throw new FleetError(present ? 'conflict' : 'resource_not_found',
      present ? `${checked.kind} '${checked.id}' already exists` : `${checked.kind} '${checked.id}' does not exist`);
    const snapshot = await applyConfigGraphTransaction({ bootstrapFile: this.bootstrapFile, expectedDigest,
      mutations: [{ target: { scope: 'resource', directory: DIRECTORIES[checked.kind], basename: `${checked.id}.yaml` },
        contents: Buffer.from(stringify(checked)) }] });
    return { digest: snapshot.digest, resource: own(checked) };
  }
  async delete(kind: ResourceKind, id: string, expectedDigest: string) {
    if (!ID.test(id)) throw new FleetError('invalid_request', 'invalid resource id');
    this.get(kind, id);
    const snapshot = await applyConfigGraphTransaction({ bootstrapFile: this.bootstrapFile, expectedDigest,
      mutations: [{ target: { scope: 'resource', directory: DIRECTORIES[kind], basename: `${id}.yaml` }, contents: null }] });
    return { digest: snapshot.digest, kind, id };
  }

  async apply(mutations: readonly ManagementResourceMutation[], expectedDigest: string,
    bootstrap?: { expectedRevision: string; contents: string }) {
    if (!mutations.length && !bootstrap)
      throw new FleetError('invalid_request', 'resource batch must not be empty');
    const before = this.list();
    if (before.digest !== expectedDigest)
      throw new FleetError('stale_state', 'configuration digest changed');
    const existing = new Set(before.resources.map(item => `${item.kind}:${item.id}`));
    const touched = new Set<string>();
    const resources: TypedResource[] = [];
    const deleted: Array<{ kind: ResourceKind; id: string }> = [];
    const graphMutations: ConfigGraphMutation[] = mutations.map((mutation, index) => {
      const resource = mutation.mutation === 'delete' ? undefined
        : parseTypedResource(`management-request[${index}]`, stringify(mutation.resource));
      const kind: ResourceKind = mutation.mutation === 'delete' ? mutation.kind : resource!.kind;
      const id = mutation.mutation === 'delete' ? mutation.id : resource!.id;
      if (!ID.test(id)) throw new FleetError('invalid_request', 'invalid resource id');
      const key = `${kind}:${id}`;
      if (touched.has(key)) throw new FleetError('invalid_request', `resource batch contains duplicate '${key}'`);
      touched.add(key);
      const present = existing.has(key);
      if (mutation.mutation === 'create' && present)
        throw new FleetError('conflict', `${kind} '${id}' already exists`);
      if (mutation.mutation !== 'create' && !present)
        throw new FleetError('resource_not_found', `${kind} '${id}' does not exist`);
      if (mutation.mutation === 'delete') deleted.push({ kind, id });
      else resources.push(own(resource!));
      return { target: { scope: 'resource' as const, directory: DIRECTORIES[kind], basename: `${id}.yaml` },
        contents: resource ? Buffer.from(stringify(resource)) : null };
    });
    if (bootstrap) {
      const current = readFileSync(this.bootstrapFile);
      const revision = createHash('sha256').update(current).digest('hex');
      if (!bootstrap.expectedRevision || revision !== bootstrap.expectedRevision)
        throw new FleetError('stale_state', 'fleet.yaml changed since it was opened');
      graphMutations.push({ target: { scope: 'bootstrap' }, contents: Buffer.from(bootstrap.contents) });
    }
    const snapshot = await applyConfigGraphTransaction({ bootstrapFile: this.bootstrapFile, expectedDigest,
      mutations: graphMutations });
    return { digest: snapshot.digest, resources, deleted };
  }

  /** Recover a mutation whose graph effect landed before its operation response was journaled. */
  reconcile(mutations: readonly ManagementResourceMutation[], expectedDigest: string,
    bootstrapContents?: string) {
    const current = this.list();
    if (current.digest === expectedDigest) return undefined;
    const byKey = new Map(current.resources.map(item => [`${item.kind}:${item.id}`, item]));
    for (const mutation of mutations) {
      if (mutation.mutation === 'delete') {
        if (byKey.has(`${mutation.kind}:${mutation.id}`)) return undefined;
      } else {
        const actual = byKey.get(`${mutation.resource.kind}:${mutation.resource.id}`);
        if (!actual || managementDigest(actual) !== managementDigest(mutation.resource)) return undefined;
      }
    }
    if (bootstrapContents !== undefined) {
      const actual = readFileSync(this.bootstrapFile);
      if (createHash('sha256').update(actual).digest('hex')
          !== createHash('sha256').update(bootstrapContents).digest('hex')) return undefined;
    }
    return { digest: current.digest,
      resources: mutations.flatMap(item => item.mutation === 'delete' ? [] : [own(item.resource)]),
      deleted: mutations.flatMap(item => item.mutation === 'delete'
        ? [{ kind: item.kind, id: item.id }] : []) };
  }
}
