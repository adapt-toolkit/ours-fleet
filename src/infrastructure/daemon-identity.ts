import type { IdentityProvisioner, IdentityRegistry } from '../creation.js';
import { resolveEndpoint } from '../monitor.js';

export type IdentityFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export interface IdentityProviderCapability {
  available: boolean;
  version?: number;
  reason?: string;
}

/**
 * Versioned daemon identity transaction client.
 *
 * The daemon owns global name arbitration. A reservation token remains private
 * to this process and is required for create, release, and rollback removal, so
 * rollback can never delete an identity that predates this transaction.
 */
export class DaemonAtomicIdentityProvider implements IdentityRegistry, IdentityProvisioner {
  private readonly reservations = new Map<string, string>();
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: IdentityFetch =
      (url, init) => globalThis.fetch(url, init) as unknown as ReturnType<IdentityFetch>,
  ) {}

  async capability(): Promise<IdentityProviderCapability> {
    try {
      const ep = resolveEndpoint(this.env);
      const response = await this.fetchImpl(`${ep.origin}/v1/identity-transactions/capabilities`, {
        headers: ep.headers,
      });
      if (!response.ok) return { available: false, reason: `daemon returned HTTP ${response.status}` };
      const body = await response.json() as { protocol?: number; operations?: string[] };
      const operations = body.operations ?? [];
      const available = body.protocol === 1
        && ['reserve', 'create', 'remove_created', 'release'].every(op => operations.includes(op));
      return {
        available, version: body.protocol,
        reason: available ? undefined : 'daemon lacks identity transaction protocol v1',
      };
    } catch (error) {
      return { available: false, reason: (error as Error).message };
    }
  }

  async reserve(name: string): Promise<boolean> {
    const ep = resolveEndpoint(this.env);
    const response = await this.fetchImpl(`${ep.origin}/v1/identity-transactions`, {
      method: 'POST', headers: { ...ep.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, name, ttlMs: 60_000 }),
    });
    if (response.status === 409) return false;
    if (!response.ok) throw new Error(`identity reservation failed (HTTP ${response.status})`);
    const body = await response.json() as { transactionId?: string };
    if (!body.transactionId) throw new Error('identity daemon omitted transaction proof');
    this.reservations.set(name, body.transactionId);
    return true;
  }

  async release(name: string): Promise<void> {
    const transactionId = this.reservations.get(name);
    if (!transactionId) return;
    const ep = resolveEndpoint(this.env);
    await this.fetchImpl(
      `${ep.origin}/v1/identity-transactions/${encodeURIComponent(transactionId)}/release`,
      { method: 'POST', headers: ep.headers },
    ).catch(() => undefined);
    this.reservations.delete(name);
  }

  async exists(name: string): Promise<boolean | 'unknown'> {
    const ep = resolveEndpoint(this.env);
    const response = await this.fetchImpl(`${ep.origin}/identities`, { headers: ep.headers });
    if (!response.ok) return 'unknown';
    const body = await response.json() as { identities?: Array<string | { name?: string }> };
    if (!Array.isArray(body.identities)) return 'unknown';
    return body.identities.some(identity =>
      (typeof identity === 'string' ? identity : identity.name) === name);
  }

  async create(name: string, profile: { bio?: string; persona?: string }): Promise<void> {
    const transactionId = this.proof(name);
    const ep = resolveEndpoint(this.env);
    const response = await this.fetchImpl(
      `${ep.origin}/v1/identity-transactions/${encodeURIComponent(transactionId)}/create`,
      {
        method: 'POST', headers: { ...ep.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, name, profile }),
      },
    );
    if (!response.ok) throw new Error(`identity creation failed (HTTP ${response.status})`);
  }

  async remove(name: string): Promise<void> {
    const transactionId = this.proof(name);
    const ep = resolveEndpoint(this.env);
    const response = await this.fetchImpl(
      `${ep.origin}/v1/identity-transactions/${encodeURIComponent(transactionId)}/created-identity`,
      { method: 'DELETE', headers: ep.headers },
    );
    if (!response.ok && response.status !== 404)
      throw new Error(`identity rollback failed (HTTP ${response.status})`);
  }

  private proof(name: string): string {
    const proof = this.reservations.get(name);
    if (!proof) throw new Error(`no daemon identity transaction proof for '${name}'`);
    return proof;
  }
}
