/**
 * Cowork private management-socket adapter.
 *
 * Fleet orchestrates tasks/rooms but Cowork owns room state. This adapter
 * communicates with Cowork via its Unix management socket using versioned
 * JSON RPC. All methods fail closed: if Cowork is unreachable or returns
 * an unexpected response, the operation fails rather than guessing.
 *
 * BLOCKED: The management socket protocol is defined in ours-cowork but
 * the exact prerelease wire format needs verification. This adapter
 * defines the interface Fleet needs and provides a fail-closed stub
 * that reports the blocker. Replace the stub with socket calls once
 * the Cowork management socket contract is verified.
 */

export interface CoworkRoomCreateResult {
  room_id: string;
  identity_name: string;
  identity_cid: string;
}

export interface CoworkInviteAcceptResult {
  seat_cid: string;
  seat_state: 'pending' | 'active';
}

export interface CoworkInviteResult {
  invite: string;
  min_accepts: number;
}

export interface CoworkSeatInfo {
  identity_cid: string;
  role: string;
  seat_state: 'pending' | 'active' | 'removed';
}

export interface CoworkRoomInfo {
  room_id: string;
  identity_name: string;
  identity_cid: string;
  room_name: string;
  state: 'provisioning' | 'active' | 'closing' | 'closed';
  seats: CoworkSeatInfo[];
  goal?: string;
  briefing?: string;
}

export interface CoworkAdapter {
  available(): Promise<boolean>;
  createRoom(opts: {
    room_name: string;
    goal?: string;
    briefing?: string;
    quiet_membership?: boolean;
    anonymous?: boolean;
  }): Promise<CoworkRoomCreateResult>;
  acceptInvite(roomId: string, invite: string, opts: {
    role: string;
    expected_cid: string;
  }): Promise<CoworkInviteAcceptResult>;
  issueInvite(roomId: string, opts: {
    role: string;
    min_accepts: number;
  }): Promise<CoworkInviteResult>;
  acceptAsIdentity(roomId: string, invite: string, identityCid: string, opts: {
    role: string;
  }): Promise<CoworkInviteAcceptResult>;
  getRoom(roomId: string): Promise<CoworkRoomInfo | undefined>;
  listRooms(): Promise<CoworkRoomInfo[]>;
  closeRoom(roomId: string): Promise<void>;
  getSeats(roomId: string): Promise<CoworkSeatInfo[]>;
}

export class CoworkUnavailableError extends Error {
  constructor(message = 'Cowork management socket is not reachable') {
    super(message);
  }
}

export class CoworkProtocolError extends Error {
  constructor(public readonly operation: string, message: string) {
    super(`cowork ${operation}: ${message}`);
  }
}

/**
 * Fail-closed stub adapter. Every method throws CoworkUnavailableError.
 * This is the correct behavior until the Cowork management socket
 * integration is verified against the prerelease wire format.
 */
export function createStubAdapter(): CoworkAdapter {
  const unavailable = (op: string): never => {
    throw new CoworkUnavailableError(
      `Cowork adapter not yet connected: ${op}. ` +
      'Blocker: Cowork management socket wire format must be verified against ours-cowork/prerelease.',
    );
  };
  return {
    async available() { return false; },
    async createRoom() { return unavailable('createRoom'); },
    async acceptInvite() { return unavailable('acceptInvite'); },
    async issueInvite() { return unavailable('issueInvite'); },
    async acceptAsIdentity() { return unavailable('acceptAsIdentity'); },
    async getRoom() { return unavailable('getRoom'); },
    async listRooms() { return unavailable('listRooms'); },
    async closeRoom() { return unavailable('closeRoom'); },
    async getSeats() { return unavailable('getSeats'); },
  };
}
