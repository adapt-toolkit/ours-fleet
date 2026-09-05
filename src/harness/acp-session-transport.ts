import type { AcpSessionOptions } from '../session/acp.js';
import type { AgentSession } from '../session/types.js';

/** ACP implementation seam kept out of the harness-neutral adapter contract. */
export type AcpSessionTransport = (options: AcpSessionOptions) => Promise<AgentSession>;

export interface AcpAdapterState {
  permissionMetadataSource?: AcpSessionOptions['permissionMetadataSource'];
}

export function acpAdapterState(value: unknown): AcpAdapterState {
  return (value ?? {}) as AcpAdapterState;
}
