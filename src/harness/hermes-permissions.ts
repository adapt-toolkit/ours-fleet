import type { CommonPermissions } from '../config.js';
import type { PermissionTranslation, UnattendedCapability } from './types.js';

export function hermesPermissionMode(permissions: CommonPermissions): 'default' | 'accept_edits' | 'dont_ask' {
  if (permissions.approval === 'deny') throw new Error('Hermes does not support legacy approval: deny');
  const modes = { ask: 'default', auto: 'accept_edits', allow: 'dont_ask' } as const;
  const mode = modes[permissions.approval];
  if (!mode) throw new Error('Hermes approval must be ask, auto or allow');
  return mode;
}

export function translateHermesPermissions(permissions: CommonPermissions): PermissionTranslation {
  if (permissions.filesystem === 'read-only') return { supported: false, reason: 'Hermes does not support read-only filesystem mode, including with Fleet isolation' };
  if (!['workspace', 'unrestricted'].includes(permissions.filesystem)) return { supported: false, reason: 'Hermes filesystem must be workspace or unrestricted' };
  let mode: ReturnType<typeof hermesPermissionMode>;
  try { mode = hermesPermissionMode(permissions); }
  catch (e) { return { supported: false, reason: (e as Error).message }; }
  const capabilities: UnattendedCapability[] = ['read-state', 'messaging', 'monitor', 'status-commands'];
  if (permissions.approval !== 'ask') capabilities.push('write-state', 'workspace-edit');
  return {
    supported: true,
    native: { permission_mode: mode, approvals_mode: 'manual' },
    exact: false,
    capabilities,
    warnings: [
      'Hermes modes mediate dangerous terminal commands and write_file/patch; browser, memory, skills, delegation and MCP side effects are not universally approval-mediated.',
      'Unattended wait is bounded by Fleet’s 50-second permission timeout and the tested Hermes native 60-second dangerous-command timeout; protected-action floors remain active.',
      ...(permissions.filesystem === 'workspace' ? ['Workspace confinement is an approximation unless enforcing Fleet isolation is verified on this platform.'] : []),
    ],
  };
}
