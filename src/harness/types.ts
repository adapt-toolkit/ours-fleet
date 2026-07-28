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
export interface PermissionTranslation {
  native: Record<string, unknown>;
  exact: boolean;
  warnings: string[];
}

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
  translatePermissions?(permissions: CommonPermissions): PermissionTranslation;
  vocabulary: BriefingVocab;
  exitPolicy: ExitPolicy;
}
