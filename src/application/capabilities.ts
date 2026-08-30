import type { RoleRecord, RoleCapabilities, RoleStatus } from './types.js';

export interface CapabilityContext {
  controlProtocolVersion?: number;
}

export function roleCapabilities(
  role: RoleRecord, status: RoleStatus, context: CapabilityContext = {},
): RoleCapabilities {
  const backend = role.configuredBackend ?? (role.detectedBackend === 'acp' ? 'acp' : undefined);
  const online = status.session.reachability === 'online';
  const acp = backend === 'acp';
  const protocolVersion = context.controlProtocolVersion ?? 1;
  const inactive = status.overall === 'offline'
    || (!online && status.supervisor.liveness === 'stopped');
  return {
    protocolVersion,
    inventory: true,
    status: true,
    output: {
      recent: acp, stream: acp && protocolVersion >= 2,
      structured: acp, replayCursor: acp && protocolVersion >= 2,
    },
    input: { text: online && acp, interrupt: online && acp, steering: false },
    permissions: { observe: acp, respond: acp && online },
    lifecycle: {
      start: role.lifetime === 'permanent' && status.supervisor.liveness !== 'running',
      stop: role.lifetime === 'permanent' && !inactive && status.supervisor.liveness !== 'stopped',
      restartResume: role.lifetime === 'permanent' && !inactive,
      restartFresh: role.lifetime === 'permanent' && !inactive,
      remove: false,
    },
    logs: { tail: true, follow: status.supervisor.backend !== 'none', cursor: status.supervisor.backend !== 'none' },
  };
}
