import type { CommonPermissions, ResolvedRole } from '../config.js';

export interface PrereqCheck { name: string; ok: boolean; detail: string }
export interface PrereqReport { ok: boolean; checks: PrereqCheck[] }

export interface RoleDirs { stateDir: string; runCwd: string }
export interface SessionState { sessionId: string }

/** Extra command/argv/env contributed by prepareSession (overlays, trust, limits). */
export interface SessionPrep {
  argv: string[];
  env: Record<string, string>;
  /** Optional launcher selected after runtime prerequisite probing. */
  command?: string;
}
export interface Launch { argv: string[]; env: Record<string, string> }
export interface AcpLaunch { argv: string[]; env: Record<string, string> }
/**
 * The result of expressing neutral `permissions:` in a harness's own terms.
 *
 * `supported: false` is a first-class answer, not an absence. The previous
 * shape made `translatePermissions` optional, so an adapter that simply never
 * implemented it was indistinguishable from one that had nothing to say — and
 * the warnings the implementations DID produce had no caller at all.
 */
/**
 * What an unattended agent must actually be able to DO to run its own briefing.
 * A role that cannot meet this floor does not fail loudly — it silently does
 * less than it was asked to, because the denial happens inside the harness with
 * nobody to see it.
 */
export type UnattendedCapability =
  | 'read-state'        // read its briefing, ROUTINES.md and WORKLOG.md
  | 'write-state'       // append its WORKLOG and its own state files
  | 'messaging'         // bind an identity, send and receive ours mail
  | 'monitor'           // arm and observe its mail monitor
  | 'workspace-edit'    // edit and test files in its working directory
  | 'status-commands';  // run the inspection commands its briefing prescribes

export type PermissionTranslation =
  | {
      supported: true;
      native: Record<string, unknown>;
      exact: boolean;
      warnings: string[];
      /** What the native settings above actually permit, unattended. */
      capabilities: UnattendedCapability[];
    }
  | { supported: false; reason: string };

/** Harness-correct wording/tool names used to generate briefing.md. */
export interface BriefingVocab {
  bindTool: string;
  createTool: string;
  setBioTool: string;
  setPersonaTool: string;
  currentIdentityTool: string;
  sendTool: string;
  getMessagesTool: string;
  watchCommand(identity: string): string;
  monitorInstruction(identity: string, role?: ResolvedRole): string;
  /** Wake-source wording for a role whose monitor is supervisor-owned (monitor.enabled). */
  supervisedWakeNote(identity: string, role?: ResolvedRole): string;
  launchNote(name: string): string;
  restartPrompt(identity: string, worklogPath: string, role?: ResolvedRole): string;
}

export interface ExitPolicy { cleanExitIsFresh: boolean; fastFailSecs: number }
export interface ValidationError { path: string; message: string }

export interface HarnessAdapter {
  id: string;
  supportsResume: boolean;
  checkPrereqs(): Promise<PrereqReport>;
  validateOptions(opts: unknown): ValidationError[];
  prepareSession(role: ResolvedRole, dirs: RoleDirs): Promise<SessionPrep>;
  buildLaunch(role: ResolvedRole, mode: 'fresh' | 'resume', s: SessionState, prep: SessionPrep): Launch;
  buildAcpLaunch?(role: ResolvedRole, prep: SessionPrep): AcpLaunch;
  /**
   * REQUIRED. Every adapter must either translate neutral permissions or
   * explicitly declare that it cannot. Enforced at registration.
   */
  translatePermissions(permissions: CommonPermissions): PermissionTranslation;
  /**
   * The permission settings this role states NATIVELY in `harness_options`,
   * keyed the same way `translatePermissions().native` is, so the two can be
   * compared directly. Only keys the operator actually wrote appear.
   */
  nativePermissionOverrides(options: unknown): Record<string, unknown>;
  vocabulary: BriefingVocab;
  exitPolicy: ExitPolicy;
}
