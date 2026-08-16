import type { RoleRecord, RoleCapabilities, RoleStatus } from './types.js';

export interface CapabilityContext {
  terminalPtyAvailable?: boolean;
  controlProtocolVersion?: number;
}

export function roleCapabilities(
  role: RoleRecord, status: RoleStatus, context: CapabilityContext = {},
): RoleCapabilities {
  const backend = role.configuredBackend ?? (
    role.detectedBackend === 'acp' || role.detectedBackend === 'tmux' ? role.detectedBackend : undefined);
  const online = status.session.reachability === 'online';
  const acp = backend === 'acp';
  const tmux = backend === 'tmux';
  const protocolVersion = context.controlProtocolVersion ?? 1;
  const inactive = status.overall === 'offline'
    || (!online && status.supervisor.liveness === 'stopped');
  const terminalAvailable = tmux && online && context.terminalPtyAvailable === true;
  const terminalReason = terminalAvailable ? undefined
    : !tmux ? 'wrong_backend'
    : !online ? 'offline'
    : 'pty_unavailable';
  return {
    protocolVersion,
    inventory: true,
    status: true,
    output: {
      recent: acp || tmux, stream: (acp && protocolVersion >= 2) || terminalAvailable,
      structured: acp, replayCursor: acp && protocolVersion >= 2,
    },
    input: { text: online && (acp || tmux), rawKeys: terminalAvailable, interrupt: online && acp, steering: false },
    permissions: { observe: acp, respond: acp && online },
    terminal: {
      available: terminalAvailable, reason: terminalReason,
      multiViewer: terminalAvailable, writerLease: terminalAvailable,
    },
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
