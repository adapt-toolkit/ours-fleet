/**
 * Typed client for the ours-cowork v1 private management-socket protocol.
 *
 * Cowork owns room state. Fleet only invokes the versioned JSON RPC exposed
 * by Cowork's Unix socket and projects the response into orchestration data.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';

const RPC_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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
    goal: string;
    briefing: string;
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
  getRoom(roomId: string): Promise<CoworkRoomInfo | undefined>;
  listRooms(): Promise<CoworkRoomInfo[]>;
  closeRoom(roomId: string): Promise<void>;
  getSeats(roomId: string): Promise<CoworkSeatInfo[]>;
  recoverRoom(roomId: string): Promise<CoworkRoomInfo>;
}

export class CoworkUnavailableError extends Error {
  constructor(message = 'Cowork management socket is not reachable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CoworkUnavailableError';
  }
}

export class CoworkProtocolError extends Error {
  constructor(
    public readonly operation: string,
    message: string,
    public readonly code = 'protocol_error',
    options?: ErrorOptions,
  ) {
    super(`cowork ${operation}: ${message}`, options);
    this.name = 'CoworkProtocolError';
  }
}

export interface CoworkAdapterOptions {
  configPath?: string;
  socketPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  connect?: (path: string) => Socket;
}

type JsonRecord = Record<string, unknown>;

function object(value: unknown, operation: string, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new CoworkProtocolError(operation, `${label} must be an object`);
  return value as JsonRecord;
}

function string(value: unknown, operation: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new CoworkProtocolError(operation, `${label} must be a non-empty string`);
  return value;
}

function text(value: unknown, operation: string, label: string): string {
  if (typeof value !== 'string') throw new CoworkProtocolError(operation, `${label} must be a string`);
  return value;
}

function roomState(value: unknown, operation: string): CoworkRoomInfo['state'] {
  if (value !== 'provisioning' && value !== 'active' && value !== 'closing' && value !== 'closed')
    throw new CoworkProtocolError(operation, 'room state is invalid');
  return value;
}

function seatState(value: unknown, operation: string): CoworkSeatInfo['seat_state'] {
  if (value !== 'pending' && value !== 'active' && value !== 'removed')
    throw new CoworkProtocolError(operation, 'seat state is invalid');
  return value;
}

function projectSeat(value: unknown, operation: string): CoworkSeatInfo {
  const seat = object(value, operation, 'seat');
  return {
    identity_cid: string(seat.identity, operation, 'seat.identity'),
    role: string(seat.role, operation, 'seat.role'),
    seat_state: seatState(seat.state, operation),
  };
}

function projectRoom(value: unknown, operation: string): CoworkRoomInfo {
  const room = object(value, operation, 'room');
  if (!Array.isArray(room.seats)) throw new CoworkProtocolError(operation, 'room.seats must be an array');
  const mission = room.mission === undefined ? undefined : object(room.mission, operation, 'room.mission');
  return {
    room_id: string(room.room_id, operation, 'room.room_id'),
    identity_name: string(room.identity_name, operation, 'room.identity_name'),
    // Cowork reserves an empty CID only for its durable packet_pending
    // recovery sentinel; list/show must preserve that recoverable state.
    identity_cid: text(room.identity_cid, operation, 'room.identity_cid'),
    room_name: string(room.room_name, operation, 'room.room_name'),
    state: roomState(room.state, operation),
    seats: room.seats.map((seat) => projectSeat(seat, operation)),
    ...(typeof mission?.goal === 'string' ? { goal: mission.goal } : {}),
    ...(typeof mission?.briefing === 'string' ? { briefing: mission.briefing } : {}),
  };
}

/** Resolve the same config/state inputs as ours-cowork and return its Unix socket. */
export function resolveCoworkSocketPath(options: CoworkAdapterOptions = {}): string {
  if (options.socketPath) return resolve(options.socketPath);
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configuredPath = options.configPath ?? env.OURS_COWORK_CONFIG;
  const configPath = resolve(configuredPath ?? join(home, '.ours-cowork', 'config.json'));
  let stateDir = resolve(home, '.ours-cowork');
  if (existsSync(configPath)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch (error) { throw new CoworkProtocolError('config', `malformed config at ${configPath}`, 'invalid_config', { cause: error }); }
    const config = object(parsed, 'config', 'config');
    if (config.version !== 1 || typeof config.stateDir !== 'string' || !config.stateDir)
      throw new CoworkProtocolError('config', `invalid Cowork v1 config at ${configPath}`, 'invalid_config');
    stateDir = resolve(config.stateDir);
  } else if (configuredPath !== undefined) {
    throw new CoworkProtocolError('config', `configured Cowork config does not exist: ${configPath}`, 'invalid_config');
  }
  if (env.OURS_COWORK_STATE_DIR) stateDir = resolve(env.OURS_COWORK_STATE_DIR);
  return join(stateDir, 'management.sock');
}

function rpcCall(
  socketPath: string,
  method: string,
  params: JsonRecord,
  timeoutMs: number,
  connect: (path: string) => Socket,
): Promise<unknown> {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const request = `${JSON.stringify({ version: RPC_VERSION, id, method, params })}\n`;
  return new Promise((resolveCall, rejectCall) => {
    const socket = connect(socketPath);
    let bytes = '';
    let size = 0;
    let settled = false;
    let connected = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectCall(error);
    };
    const timer = setTimeout(() => finishError(new CoworkUnavailableError(
      connected ? 'Cowork did not answer the management socket' : 'Cowork management socket is not reachable',
    )), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      socket.write(request);
    });
    socket.on('data', (chunk: string | Buffer) => {
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      size += Buffer.byteLength(text);
      if (size > MAX_RESPONSE_BYTES) {
        finishError(new CoworkProtocolError(method, 'response exceeded 4 MiB'));
        return;
      }
      bytes += text;
      const newline = bytes.indexOf('\n');
      if (newline < 0) return;
      if (bytes.slice(newline + 1).trim() !== '') {
        finishError(new CoworkProtocolError(method, 'daemon returned more than one response'));
        return;
      }
      let response: JsonRecord;
      try { response = object(JSON.parse(bytes.slice(0, newline)), method, 'RPC response'); }
      catch (error) {
        finishError(error instanceof CoworkProtocolError
          ? error : new CoworkProtocolError(method, 'daemon returned malformed JSON', 'protocol_error', { cause: error }));
        return;
      }
      if (response.version !== RPC_VERSION || response.id !== id
        || (Object.hasOwn(response, 'error') === Object.hasOwn(response, 'result'))) {
        finishError(new CoworkProtocolError(method, 'daemon returned an invalid RPC response'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (Object.hasOwn(response, 'error')) {
        const error = object(response.error, method, 'RPC error');
        rejectCall(new CoworkProtocolError(
          method,
          typeof error.message === 'string' ? error.message : 'unknown RPC error',
          typeof error.code === 'string' ? error.code : 'rpc_error',
        ));
      } else {
        resolveCall(response.result);
      }
    });
    socket.once('end', () => {
      if (!settled) finishError(new CoworkProtocolError(method, 'daemon closed without a complete response'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (!settled) finishError(new CoworkUnavailableError(
        error.code === 'EACCES' || error.code === 'EPERM'
          ? 'Cowork management socket access denied' : 'Cowork management socket is not reachable',
        { cause: error },
      ));
    });
  });
}

export function createCoworkAdapter(options: CoworkAdapterOptions = {}): CoworkAdapter {
  const socketPath = resolveCoworkSocketPath(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connect = options.connect ?? ((path: string) => createConnection(path));
  const call = (method: string, params: JsonRecord): Promise<unknown> =>
    rpcCall(socketPath, method, params, timeoutMs, connect);
  return {
    async available() {
      try { await call('room.list', {}); return true; } catch { return false; }
    },
    async createRoom(opts) {
      const result = projectRoom(await call('room.create', {
        name: opts.room_name,
        goal: opts.goal,
        briefing: opts.briefing,
        ...(opts.quiet_membership === undefined ? {} : { quiet_membership: opts.quiet_membership }),
        ...(opts.anonymous === undefined ? {} : { anonymous: opts.anonymous }),
      }), 'room.create');
      if (!result.identity_cid)
        throw new CoworkProtocolError('room.create', 'created room did not establish an identity CID');
      return { room_id: result.room_id, identity_name: result.identity_name, identity_cid: result.identity_cid };
    },
    async acceptInvite(roomId, invite, opts) {
      const receipt = object(await call('room.accept', {
        room_id: roomId,
        role: opts.role,
        invite,
        expected_cid: opts.expected_cid,
      }), 'room.accept', 'receipt');
      const state = seatState(receipt.state, 'room.accept');
      if (state === 'removed') throw new CoworkProtocolError('room.accept', 'accepted seat cannot be removed');
      return {
        seat_cid: string(receipt.identity, 'room.accept', 'receipt.identity'),
        seat_state: state,
      };
    },
    async issueInvite(roomId, opts) {
      const receipt = object(await call('room.invite', {
        room_id: roomId,
        mode: 'public',
        role: opts.role,
        min_accepts: opts.min_accepts,
      }), 'room.invite', 'receipt');
      const invite = object(receipt.invite, 'room.invite', 'receipt.invite');
      return {
        invite: string(receipt.blob, 'room.invite', 'receipt.blob'),
        min_accepts: typeof invite.min_accepts === 'number'
          ? invite.min_accepts : opts.min_accepts,
      };
    },
    async getRoom(roomId) {
      try { return projectRoom(await call('room.show', { room_id: roomId }), 'room.show'); }
      catch (error) {
        if (error instanceof CoworkProtocolError && error.code === 'not_found') return undefined;
        throw error;
      }
    },
    async listRooms() {
      const result = await call('room.list', {});
      if (!Array.isArray(result)) throw new CoworkProtocolError('room.list', 'result must be an array');
      return result.map((room) => projectRoom(room, 'room.list'));
    },
    async closeRoom(roomId) { await call('room.close', { room_id: roomId }); },
    async getSeats(roomId) {
      const result = await call('room.participants', { room_id: roomId });
      if (!Array.isArray(result)) throw new CoworkProtocolError('room.participants', 'result must be an array');
      return result.map((seat) => projectSeat(seat, 'room.participants'));
    },
    async recoverRoom(roomId) {
      // Cowork performs packet/state reconciliation during daemon recovery.
      // Its `room.recover` RPC is specifically invite-receipt recovery, so a
      // Fleet reconciliation pass must read `room.show`, not mutate invites.
      return projectRoom(await call('room.show', { room_id: roomId }), 'room.show');
    },
  };
}
