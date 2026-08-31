import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeRestartBatch, RoleCommandService, RoleLifecycleService,
  type RestartBatchPlan,
} from '../src/application/role-command-service.js';
import { FleetError } from '../src/application/errors.js';
import { dispatchOwnerCommand } from '../src/owner-channel/commands.js';
import type { FleetConfig } from '../src/config.js';
import type { OpsDeps } from '../src/ops.js';
import type { RoleRepository } from '../src/application/role-repository.js';
import { writeV2Fixture } from './v2-fixture.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const cfg = (names: string[]) => ({
  roles: names.map(name => ({ name })), files: ['/fleet.yaml'],
} as unknown as FleetConfig);

function service(names: string[]) {
  const restart = vi.fn(async () => undefined);
  const repository = { get: vi.fn(async (id: string) => names.includes(id)
    ? { id, lifetime: 'permanent' } : undefined) } as unknown as RoleRepository;
  const ops = { backend: {} } as unknown as OpsDeps;
  return { restart, lifecycle: new RoleLifecycleService({ repository, ops,
    status: vi.fn(), restart }) };
}

describe('RoleLifecycleService restart batches', () => {
  it.each([
    { names: [], mode: 'keep' as const },
    { names: ['A', 'B'], mode: 'keep' as const },
    { names: ['B'], mode: 'fresh' as const },
  ])('preserves one immutable $mode batch for $names', async ({ names, mode }) => {
    const h = service(['A', 'B']);
    const config = cfg(['A', 'B']);
    const expected = [...names];
    const plan = await h.lifecycle.prepareRestart({ roleIds: names, mode, config });
    names.push('mutated');
    await h.lifecycle.executeRestart(plan);
    expect(h.restart).toHaveBeenCalledOnce();
    expect(h.restart).toHaveBeenCalledWith(config, expected, expect.anything(), mode, undefined);
  });

  it('normalizes a missing explicit target before backend effects', async () => {
    const h = service(['A']);
    await expect(h.lifecycle.prepareRestart({ roleIds: ['missing'], mode: 'keep',
      config: cfg(['A']) })).rejects.toEqual(expect.objectContaining<FleetError>({
        code: 'role_not_found',
      }));
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('distinguishes an inert template target from an ordinary missing role', async () => {
    const h = service(['FleetCoordinator']);
    const config = { ...cfg(['FleetCoordinator']), agentTemplates: { Secretary: {} } } as FleetConfig;
    await expect(h.lifecycle.prepareRestart({ roleIds: ['Secretary'], mode: 'fresh', config }))
      .rejects.toMatchObject({ code: 'capability_unavailable', message: expect.stringMatching(/inert Agent Template/) });
    await expect(h.lifecycle.prepareRestart({ roleIds: ['Unknown'], mode: 'fresh', config }))
      .rejects.toMatchObject({ code: 'role_not_found', message: "no such role 'Unknown'" });
    expect(h.restart).not.toHaveBeenCalled();
  });
});

describe('restart-resume adapter parity', () => {
  function harness(missing = false) {
    const dir = mkdtempSync(join(tmpdir(), 'ours-role-lifecycle-'));
    dirs.push(dir);
    const configPath = join(dir, 'fleet.yaml');
    writeV2Fixture(configPath, { roles: { Alpha: {} } });
    const effects: Array<{ target: string; mode: string }> = [];
    const prepareRestart = vi.fn(async ({ roleIds, mode }: {
      roleIds: string[]; mode: 'keep' | 'fresh';
    }) => {
      if (missing) throw new FleetError('role_not_found', "no such role 'Alpha'");
      return { roleIds: Object.freeze([...roleIds]), mode,
        config: cfg(['Alpha']) } as RestartBatchPlan;
    });
    const executeRestart = vi.fn(async (plan: RestartBatchPlan) => {
      effects.push({ target: plan.roleIds[0], mode: plan.mode });
    });
    const lifecycle = { prepareRestart, executeRestart } as unknown as RoleLifecycleService;
    const repository = { get: vi.fn(async () => missing ? undefined
      : { id: 'Alpha', lifetime: 'permanent' }) } as unknown as RoleRepository;
    const commands = new RoleCommandService({ repository,
      ops: { backend: {} } as unknown as OpsDeps, status: vi.fn(), lifecycle, configPath });
    return { effects, lifecycle, commands };
  }

  it('drives CLI, REST action, and Messenger adapters to the same target/mode/effect', async () => {
    const h = harness();
    await executeRestartBatch(h.lifecycle, { roleIds: ['Alpha'], mode: 'keep',
      config: cfg(['Alpha']) });
    await h.commands.execute({ roleId: 'Alpha', action: 'restart_resume', actionId: 'rest-action' });
    await vi.waitFor(() => expect(h.effects).toHaveLength(2));
    await dispatchOwnerCommand('/restart', {
      role: 'Alpha', restart: async mode => {
        const plan = await h.lifecycle.prepareRestart({ roleIds: ['Alpha'], mode });
        await h.lifecycle.executeRestart(plan);
      }, reply: vi.fn(),
    } as any);
    expect(h.effects).toEqual([
      { target: 'Alpha', mode: 'keep' },
      { target: 'Alpha', mode: 'keep' },
      { target: 'Alpha', mode: 'keep' },
    ]);
  });

  it('surfaces role_not_found with no backend effect through all three adapters', async () => {
    const h = harness(true);
    const cli = executeRestartBatch(h.lifecycle, { roleIds: ['Alpha'], mode: 'keep',
      config: cfg(['Alpha']) });
    await expect(cli).rejects.toMatchObject({ code: 'role_not_found' });
    await expect(h.commands.execute({ roleId: 'Alpha', action: 'restart_resume',
      actionId: 'missing-rest' })).rejects.toMatchObject({ code: 'role_not_found' });
    await expect(dispatchOwnerCommand('/restart', {
      role: 'Alpha', restart: async mode => {
        const plan = await h.lifecycle.prepareRestart({ roleIds: ['Alpha'], mode });
        await h.lifecycle.executeRestart(plan);
      }, reply: vi.fn(async () => undefined),
    } as any)).rejects.toMatchObject({ code: 'role_not_found' });
    expect(h.effects).toEqual([]);
  });

  it('rejects an inert template through the command service before recording effects', async () => {
    const h = harness();
    await expect(h.commands.execute({ roleId: 'Agent', action: 'start', actionId: 'template' }))
      .rejects.toMatchObject({ code: 'capability_unavailable', message: expect.stringMatching(/inert Agent Template/) });
    expect(h.effects).toEqual([]);
  });
});
