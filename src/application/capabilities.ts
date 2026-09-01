import type { RoleRecord, RoleCapabilities, RoleStatus } from './types.js';
import { sessionBackendCapabilities } from '../session/types.js';

export interface CapabilityContext {
  controlProtocolVersion?: number;
}

export function roleCapabilities(
  role: RoleRecord, status: RoleStatus, context: CapabilityContext = {},
): RoleCapabilities {
  const backend = role.configuredBackend
    ?? (role.detectedBackend === 'acp' || role.detectedBackend === 'codex-app-server'
      ? role.detectedBackend : undefined);
  const online = status.session.reachability === 'online';
  const session = backend ? sessionBackendCapabilities(backend, role.config?.harness) : undefined;
  const protocolVersion = context.controlProtocolVersion ?? 1;
  const inactive = status.overall === 'offline'
    || (!online && status.supervisor.liveness === 'stopped');
  return {
    protocolVersion,
    inventory: true,
    status: true,
    output: {
      recent: Boolean(session?.streaming),
      stream: Boolean(session?.streaming) && protocolVersion >= 2,
      structured: Boolean(session?.durableConversation),
      replayCursor: Boolean(session?.durableConversation) && protocolVersion >= 2,
    },
    input: {
      text: online && Boolean(session?.promptInput),
      interrupt: online && Boolean(session?.interrupt),
      steering: online && Boolean(session?.steering),
    },
    permissions: {
      observe: Boolean(session?.permissions),
      respond: online && Boolean(session?.permissions),
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
