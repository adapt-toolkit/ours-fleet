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
  type: 'cli' | 'owner_channel' | 'web';
  owner_cid?: string;
}

export interface TaskOutcome {
  summary: string;
  artifacts?: string[];
}

export interface TaskTerminalIntent {
  kind: 'done' | 'cancelled';
  status: 'pending' | 'settled';
  room_id?: string;
  outcome?: TaskOutcome;
  accepted_at: string;
  settled_at?: string;
  error?: string;
  error_at?: string;
  recovery_hint?: string;
  first_failure?: string;
  first_recovery_hint?: string;
}

export interface TaskRecord {
  task_id: string;
  /** Stable organizational list identifier. Missing legacy values mean `default`. */
  list_id: string;
  /** Derived presentation field; repositories must never persist it. */
  list_name: string;
  title: string;
  brief?: string;
  brief_file?: string;
  state: TaskState;
  blocked?: TaskBlocked;
  template?: TaskTemplateRef;
  execution_plan?: {
    schema_version: 1;
    snapshot: TemplateSnapshot;
    overrides: Record<string, unknown>;
    overrides_hash: string;
    plan_hash: string;
  };
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
  terminal_intent?: TaskTerminalIntent;
}

export interface TaskListRecord {
  list_id: string;
  name: string;
  built_in: boolean;
  created_at: string;
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

export interface RoomRoleBriefingDefinition {
  role: string;
  text: string;
  sha256: string;
  version?: number;
  state: 'pending' | 'configured' | 'failed';
  attempts: number;
  updated_at: string;
  last_error?: string;
}

export interface RoomMemberLaunchState {
  state: 'pending' | 'intent' | 'launched' | 'stopped' | 'failed';
  attempt: number;
  action_id?: string;
  /** Expected authenticated proxy caller while adopting a post-spawn crash. */
  caller_role?: string;
  mission_sha256?: string;
  /** Redacted, deterministic effective Agent launch definition retained for retry inspection. */
  agent_definition?: Record<string, unknown>;
  agent_fingerprint?: string;
  agent_template?: string;
  agent_template_hash?: string;
  launch_id?: string;
  updated_at: string;
  error?: string;
}

export type RoomHistoryEvidence =
  | {
      kind: 'message'; seq: number; record_id: string; at: string; message_id: string;
      category: 'role_briefing' | 'chat';
      author: { identity: string; display_name: string; role: string };
      text: string; recipient_identities: string[];
      briefing_role?: string; briefing_version?: number;
    }
  | {
      kind: 'relay_intent'; seq: number; record_id: string; at: string;
      message_id: string; recipient_identity: string;
    }
  | {
      kind: 'relay_result'; seq: number; record_id: string; at: string;
      intent_record_id: string; message_id: string; recipient_identity: string;
      status: 'queued' | 'send_failed' | 'skipped_removed'; wire_id?: string;
    };

export type MemberRetirementPhase =
  | 'stop_requested'
  | 'liveness_absent'
  | 'archive_secured'
  | 'identity_absent';

export interface MemberRetirement {
  phase: MemberRetirementPhase;
  launch_id: string;
  updated_at: string;
  archive_path?: string;
}

export type RoomClosePhase = 'retire_members' | 'close_cowork' | 'completed';

export interface RoomCloseCursor {
  phase: RoomClosePhase;
  accepted_at: string;
  error?: string;
  error_at?: string;
  recovery_hint?: string;
  first_failure?: string;
  first_recovery_hint?: string;
}

export interface RoomMemberSeat {
  role_name: string;
  identity_cid?: string;
  invite_id?: string;
  slot: string;
  cowork_role: string;
  seat_state: 'pending' | 'active' | 'removed';
  launch?: RoomMemberLaunchState;
  retirement?: MemberRetirement;
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
  role_briefings?: Record<string, RoomRoleBriefingDefinition>;
  history_cursor?: number;
  member_seats: RoomMemberSeat[];
  state: RoomOrchestrationState;
  created_at: string;
  activated_at?: string;
  closed_at?: string;
  close?: RoomCloseCursor;
}

// ── Templates ───────────────────────────────────────────────────────────

export interface TemplateMemberSlot {
  slot: string;
  role: string;
  count: number;
  /** Stable reference to an inert Agent Template, never a persistent Agent. */
  agent_template: string;
}

export interface TemplateRoomConfig {
  quiet_membership?: boolean;
  anonymous?: boolean;
}

export interface TemplateDefinition {
  name: string;
  version: number;
  description: string;
  /** Authoring provenance only; excluded from snapshots and semantic hashes. */
  sourceFile?: string;
  room?: TemplateRoomConfig;
  contract?: string;
  members: TemplateMemberSlot[];
}

export interface TemplateSnapshotMember extends TemplateMemberSlot {
  /** Secret-safe public projection; launch material lives in the sealed snapshot. */
  agent_projection?: Record<string, unknown>;
  agent_template_hash?: string;
  /** Private sealed-snapshot lookup key; harmless provenance, not an identity. */
  launch_definition_id?: string;
  role_preset?: { id: string; hash: string };
  brain_preset?: { id: string; hash: string };
}

export interface TemplateSnapshot extends Omit<TemplateDefinition, 'members'> {
  members: TemplateSnapshotMember[];
  content_hash: string;
  launch_snapshot_hash?: string;
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

export const ROOMS_KEYS = ['cowork', 'owner', 'defaults'] as const;
export const ROOMS_OWNER_KEYS = ['provider', 'public_invite', 'public_invite_file', 'expected_cid', 'role'] as const;
export const ROOMS_COWORK_KEYS = ['config'] as const;
export const ROOMS_DEFAULTS_KEYS = ['template', 'attach_owner', 'close_when_task_done'] as const;
export const TASKS_KEYS = ['default_room_template', 'create_mode', 'close_room_on_done', 'retain_completed_for'] as const;
export const TEMPLATE_KEYS = ['version', 'description', 'room', 'contract', 'members', 'override_builtin'] as const;
/** `agent` is accepted only so validation can emit its actionable migration error. */
export const TEMPLATE_MEMBER_KEYS = ['slot', 'role', 'count', 'agent_template', 'agent'] as const;
