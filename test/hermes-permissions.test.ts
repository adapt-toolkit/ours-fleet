import { describe, expect, it } from 'vitest';
import { hermesPermissionMode, translateHermesPermissions } from '../src/harness/hermes-permissions.js';
import type { CommonPermissions } from '../src/config.js';
const permissions = (approval: CommonPermissions['approval'], filesystem: CommonPermissions['filesystem'] = 'workspace'): CommonPermissions => ({ approval, filesystem, unattended: 'wait' });
describe('Hermes permissions', () => {
  it.each([['ask', 'default'], ['auto', 'accept_edits'], ['allow', 'dont_ask']] as const)('maps %s to native %s with manual terminal approval', (approval, mode) => {
    expect(hermesPermissionMode(permissions(approval))).toBe(mode);
    expect(translateHermesPermissions(permissions(approval))).toMatchObject({ supported: true, native: { permission_mode: mode, approvals_mode: 'manual' }, exact: false });
  });
  it('rejects legacy deny and read-only', () => {
    expect(() => hermesPermissionMode(permissions('deny'))).toThrow(/legacy approval: deny/);
    expect(translateHermesPermissions(permissions('deny'))).toMatchObject({ supported: false });
    expect(translateHermesPermissions(permissions('ask', 'read-only'))).toMatchObject({ supported: false });
  });
  it('reports bounded waiting and incomplete approval and filesystem coverage', () => {
    const result = translateHermesPermissions(permissions('ask'));
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.warnings.join(' ')).toMatch(/browser.*memory.*skills.*delegation.*MCP/);
    expect(result.warnings.join(' ')).toMatch(/50.*60/);
    expect(result.warnings.join(' ')).toMatch(/isolation/);
    expect(result.capabilities).not.toContain('workspace-edit');
  });
});
