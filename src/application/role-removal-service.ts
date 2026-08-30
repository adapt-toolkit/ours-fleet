import { cpSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadConfig, ROLE_NAME_RE } from '../config.js';
import { agentDir, stateRoot } from '../paths.js';
import { rmRole, type OpsDeps } from '../ops.js';
import { FleetError } from './errors.js';
import { provesGeneratedAgentSource } from '../generated-agent-source.js';

export interface RoleRemovalPreview {
  role: string;
  configured: boolean;
  lifetime: 'permanent' | 'temporary' | 'orphan';
  effects: string[];
  confirmation: 'typed-role-name' | 'confirm';
  coordinatorProtection: boolean;
  selfProtected: boolean;
  recovery: { available: boolean; detail: string };
}

export class RoleRemovalService {
  constructor(private readonly options: { configPath?: string; ops: OpsDeps; currentControlRole?: string }) {}

  async removeDirect(input: { actor: { kind: 'local_control'; surface: 'cli' }; role: string }): Promise<void> {
    const cfg = loadConfig(this.options.configPath);
    await rmRole(cfg, input.role, this.options.ops);
  }

  previewWeb(requested: string): RoleRemovalPreview {
    if (!ROLE_NAME_RE.test(requested)) throw new FleetError('invalid_request', 'invalid role name');
    const cfg = loadConfig(this.options.configPath);
    const names = new Set(cfg.roles.map(role => role.name));
    for (const root of [dirname(agentDir('_')), dirname(agentDir('_', true))]) {
      try { for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) names.add(entry.name); }
      catch { /* missing state root */ }
    }
    const folded = [...names].filter(name => name.toLocaleLowerCase('en-US') === requested.toLocaleLowerCase('en-US'));
    if (folded.length > 1)
      throw new FleetError('conflict', `case-fold collision: ${folded.sort().join(', ')}; use the exact role name`);
    if (!names.has(requested)) {
      if (folded.length) throw new FleetError('conflict', `role names are case-sensitive; use '${folded[0]}' exactly`);
      throw new FleetError('role_not_found', `no such configured or state-backed role '${requested}'`);
    }
    const role = cfg.roles.find(item => item.name === requested);
    const permanentState = agentDir(requested);
    const temporaryState = agentDir(requested, true);
    const lifetime = existsSync(temporaryState) && !existsSync(permanentState)
      ? 'temporary' : role ? 'permanent' : 'orphan';
    const coordinatorProtection = cfg.roles.some(item => item.name !== requested && item.coordinator === requested);
    const selfProtected = this.options.currentControlRole === requested;
    const effects = [
      `Stop and uninstall the exact backend registration for '${requested}'.`,
      `Archive then remove ${lifetime === 'temporary' ? temporaryState : permanentState}.`,
    ];
    const generatedSource = role && provesGeneratedAgentSource(
      agentDir(requested), cfg.files[0], role.sourceFile,
    );
    if (generatedSource) effects.push(`Remove generated Agent configuration ${role.sourceFile}.`);
    else if (role) effects.push(`Keep hand-written configuration ${role.sourceFile}; the role can be recreated from it.`);
    else effects.push('Clean dangling unit/state left before configuration registration completed.');
    return {
      role: requested, configured: Boolean(role), lifetime, effects,
      confirmation: lifetime === 'temporary' ? 'confirm' : 'typed-role-name',
      coordinatorProtection, selfProtected,
      recovery: { available: true, detail: 'State and spawned configuration are copied to the local removal archive before deletion.' },
    };
  }

  async removeWeb(input: { role: string; confirmation?: string; confirmed?: boolean; coordinatorAcknowledged?: boolean }): Promise<RoleRemovalPreview & { removed: true; recoveryPath: string }> {
    const preview = this.previewWeb(input.role);
    if (preview.selfProtected)
      throw new FleetError('forbidden', 'the current control role cannot remove itself from its own web session');
    if (preview.coordinatorProtection && !input.coordinatorAcknowledged)
      throw new FleetError('prerequisite_unavailable', 'this role coordinates other configured roles; acknowledge the impact explicitly');
    if (preview.confirmation === 'typed-role-name' && input.confirmation !== preview.role)
      throw new FleetError('invalid_request', `type '${preview.role}' exactly to confirm removal`);
    if (preview.confirmation === 'confirm' && input.confirmed !== true)
      throw new FleetError('invalid_request', 'explicit confirmation is required');
    const cfg = loadConfig(this.options.configPath);
    const role = cfg.roles.find(item => item.name === preview.role);
    const sourceState = preview.lifetime === 'temporary' ? agentDir(preview.role, true) : agentDir(preview.role);
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const recoveryPath = join(stateRoot(), 'recovery', 'removed', `${stamp}-${preview.role}`);
    mkdirSync(recoveryPath, { recursive: true, mode: 0o700 });
    if (existsSync(sourceState)) cpSync(sourceState, join(recoveryPath, 'state'), { recursive: true });
    if (role && provesGeneratedAgentSource(agentDir(preview.role), cfg.files[0], role.sourceFile)
        && existsSync(role.sourceFile))
      cpSync(role.sourceFile, join(recoveryPath, basename(role.sourceFile)));
    if (role || preview.lifetime === 'temporary')
      await rmRole(cfg, preview.role, this.options.ops);
    else {
      await this.options.ops.backend.uninstall(preview.role);
      if (existsSync(sourceState)) renameSync(sourceState, join(recoveryPath, 'orphan-state'));
      this.options.ops.log(`removed orphaned backend/state '${preview.role}'`);
    }
    return { ...preview, removed: true, recoveryPath };
  }

  /** @deprecated Internal compatibility aliases; surface adapters use explicit policies above. */
  preview(requested: string): RoleRemovalPreview { return this.previewWeb(requested); }
  /** @deprecated Internal compatibility aliases; surface adapters use explicit policies above. */
  remove(input: { role: string; confirmation?: string; confirmed?: boolean; coordinatorAcknowledged?: boolean }) {
    return this.removeWeb(input);
  }
}
