import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentProductionRuntime } from '../src/agent-production-runtime.js';
import type { ResolvedRole } from '../src/config.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const role = (name: string): ResolvedRole => ({ name, harness: 'codex', session: 'acp', identity: name,
  model: 'gpt-5', sourceFile: 'test', permissionsDeclared: true,
  permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
  monitor: { mode: 'native', enabled: false, wake_sources: [], batch_ms: 0,
    inject: 'notification', interrupt: false } });

describe('Agent production runtime facade', () => {
  it('creates permanent and temporary product Agents without exposing internal authorities', async () => {
    const trustedStateRoot = mkdtempSync(join(tmpdir(), 'agent-product-')); roots.push(trustedStateRoot);
    const identities = new Map<string, string>(); const create = vi.fn(async (name: string) => {
      const cid = name.repeat(64).slice(0, 64); identities.set(name, cid);
      return { state: 'created_here' as const, cid };
    });
    const runtime = createAgentProductionRuntime({ trustedStateRoot, identityProvisioner: {
      exists: async name => identities.has(name),
      inspect: async name => identities.has(name)
        ? { state: 'present' as const, cid: identities.get(name)! } : { state: 'absent' as const }, create,
    }, now: () => 1 });
    expect(Object.keys(runtime)).toEqual(['create', 'createRole', 'launch']);
    const permanent = await runtime.createRole({ role: role('Permanent'), lifetime: 'persistent', actionId: 'p-1' });
    expect(permanent).toMatchObject({ state: 'complete', identityAcquisition: 'created',
      identityName: 'Permanent' });
    await expect(runtime.createRole({ role: role('Permanent'), lifetime: 'persistent', actionId: 'p-1' }))
      .resolves.toMatchObject({ state: 'complete', locator: { agentId: 'Permanent', actionId: 'p-1' } });
    const temporary = await runtime.createRole({ role: role('Temporary'), lifetime: 'temporary', actionId: 't-1' });
    expect(temporary).toEqual({ state: 'reserved', agentId: 'Temporary', generation: 1,
      actionId: 't-1', lifetime: 'temporary', completion: 'deferred' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects corrupt persistent active authority instead of treating it as absence', async () => {
    const trustedStateRoot = mkdtempSync(join(tmpdir(), 'agent-product-')); roots.push(trustedStateRoot);
    const identities = new Map<string, string>();
    const runtime = createAgentProductionRuntime({ trustedStateRoot, identityProvisioner: {
      exists: async name => identities.has(name),
      inspect: async name => identities.has(name)
        ? { state: 'present' as const, cid: identities.get(name)! } : { state: 'absent' as const },
      create: async name => { const cid = name.repeat(64).slice(0, 64); identities.set(name, cid);
        return { state: 'created_here' as const, cid }; },
    }, now: () => 1 });
    await runtime.createRole({ role: role('Corrupt'), lifetime: 'persistent', actionId: 'p-1' });
    writeFileSync(join(trustedStateRoot, 'agents', Buffer.from('Corrupt').toString('base64url'),
      'active.json'), '{}\n', { mode: 0o600 });
    await expect(runtime.createRole({ role: role('Corrupt'), lifetime: 'persistent', actionId: 'p-1' }))
      .rejects.toThrow(/invalid_handoff/u);
  });

  it('fails closed for non-ACP creation input', async () => {
    const trustedStateRoot = mkdtempSync(join(tmpdir(), 'agent-product-')); roots.push(trustedStateRoot);
    const runtime = createAgentProductionRuntime({ trustedStateRoot,
      identityProvisioner: { exists: async () => false } });
    await expect(runtime.createRole({ role: { ...role('Tmux'), session: 'tmux' },
      lifetime: 'persistent', actionId: 'x' })).rejects.toThrow(/requires ACP/u);
  });
});
