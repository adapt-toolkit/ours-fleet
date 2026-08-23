/**
 * Rooms & Tasks domain types for ours-fleet.
 *
 * Task and Room are Fleet orchestration records. Cowork owns room content,
 * membership, and archive. Messenger Server owns owner presentation.
 * Fleet stores only IDs, CIDs, orchestration state, and saga cursors.
 */

// ── Task ────────────────────────────────────────────────────────────────

export type TaskState =
  | 'backlog'
  | 'provisioning'
  | 'active'
  | 'review'
  | 'done'
  | 'cancelled'
  | 'failed';

export const TASK_TERMINAL_STATES: readonly TaskState[] = ['done', 'cancelled', 'failed'];
export const TASK_CANCELLABLE_STATES: readonly TaskState[] = ['backlog', 'provisioning', 'active', 'review'];

export interface TaskBlocked {
  reason: string;
  at: string;
}

export interface TaskTemplateRef {
  name: string;
  version: number;
  content_hash: string;
}

export interface TaskMemberRole {
  name: string;
  identity_cid: string;
  slot: string;
  cowork_role: string;
}

export interface TaskOrigin {
  type: 'cli' | 'owner_channel';
  owner_cid?: string;
}

export interface TaskOutcome {
  summary: string;
  artifacts?: string[];
}

export interface TaskRecord {
  task_id: string;
  title: string;
  brief?: string;
  brief_file?: string;
  state: TaskState;
  blocked?: TaskBlocked;
  template?: TaskTemplateRef;
  no_room?: boolean;
  room_id?: string;
  room_identity_cid?: string;
  member_roles: TaskMemberRole[];
  origin: TaskOrigin;
  idempotency_key: string;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  outcome?: TaskOutcome;
}

// ── Room orchestration (Fleet side) ─────────────────────────────────────

export type RoomOrchestrationState = 'provisioning' | 'active' | 'closing' | 'closed';

export type SagaPhase =
  | 'persist_intent'
  | 'create_room'
  | 'attach_owner'
  | 'create_members'
  | 'join_role_groups'
  | 'wait_seats'
  | 'launch_work'
  | 'activate'
  | 'completed'
  | 'failed';

export interface SagaCursor {
  phase: SagaPhase;
  step_index: number;
  error?: string;
  recovery_hint?: string;
}

export type ProvisioningDetail =
  | 'waiting_cowork'
  | 'waiting_owner_invite'
  | 'owner_cid_mismatch'
  | 'member_failed'
  | 'waiting_seats'
  | 'uncertain';

export interface RoomMemberSeat {
  role_name: string;
  identity_cid: string;
  slot: string;
  cowork_role: string;
  seat_state: 'pending' | 'active' | 'removed';
}

export interface RoomOrchestrationRecord {
  room_id: string;
  room_identity_cid?: string;
  room_name: string;
  goal?: string;
  task_id?: string;
  template_snapshot?: TemplateSnapshot;
  saga: SagaCursor;
  provisioning_detail?: ProvisioningDetail;
  owner_seat_cid?: string;
  owner_invite_fingerprint?: string;
  member_seats: RoomMemberSeat[];
  state: RoomOrchestrationState;
  created_at: string;
  activated_at?: string;
  closed_at?: string;
}

// ── Templates ───────────────────────────────────────────────────────────

export interface TemplateMemberSlot {
  slot: string;
  role: string;
  count: number;
  role_ref: string;
  overrides?: TemplateRoleOverrides;
}

export interface TemplateRoleOverrides {
  harness?: string;
  model?: string;
  model_chain?: string[];
  permissions?: Record<string, unknown>;
  isolation?: Record<string, unknown>;
  cwd?: string;
  env?: Record<string, string>;
  persona?: string;
  mission?: string;
}

export interface TemplateRoomConfig {
  quiet_membership?: boolean;
  anonymous?: boolean;
}

export interface TemplateDefinition {
  name: string;
  version: number;
  description: string;
  builtin?: boolean;
  room?: TemplateRoomConfig;
  contract?: string;
  members: TemplateMemberSlot[];
}

export interface TemplateSnapshot extends TemplateDefinition {
  content_hash: string;
}

// ── Config sections ─────────────────────────────────────────────────────

export interface RoomsOwnerConfig {
  provider: string;
  public_invite?: string;
  public_invite_file?: string;
  expected_cid: string;
  role: string;
}

export interface RoomsCoworkConfig {
  config?: string;
}

export interface RoomsDefaults {
  template?: string;
  attach_owner?: boolean;
  close_when_task_done?: boolean;
}

export interface RoomsConfig {
  provider: string;
  cowork?: RoomsCoworkConfig;
  owner: RoomsOwnerConfig;
  defaults?: RoomsDefaults;
}

export interface TasksConfig {
  default_room_template?: string;
  create_mode?: 'start' | 'backlog';
  close_room_on_done?: boolean;
  retain_completed_for?: string;
}

export type RoomTemplatesConfig = Record<string, TemplateDefinition>;

// ── Validation keys ─────────────────────────────────────────────────────

export const ROOMS_KEYS = ['provider', 'cowork', 'owner', 'defaults'] as const;
export const ROOMS_OWNER_KEYS = ['provider', 'public_invite', 'public_invite_file', 'expected_cid', 'role'] as const;
export const ROOMS_COWORK_KEYS = ['config'] as const;
export const ROOMS_DEFAULTS_KEYS = ['template', 'attach_owner', 'close_when_task_done'] as const;
export const TASKS_KEYS = ['default_room_template', 'create_mode', 'close_room_on_done', 'retain_completed_for'] as const;
export const TEMPLATE_KEYS = ['version', 'description', 'room', 'contract', 'members', 'override_builtin'] as const;
export const TEMPLATE_MEMBER_KEYS = ['slot', 'role', 'count', 'role_ref', 'overrides'] as const;
export const TEMPLATE_OVERRIDE_KEYS = [
  'harness', 'model', 'model_chain', 'permissions', 'isolation', 'cwd', 'env', 'persona', 'mission',
] as const;
