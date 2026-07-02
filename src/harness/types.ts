import type { ResolvedRole } from '../config.js';

export interface PrereqCheck { name: string; ok: boolean; detail: string }
export interface PrereqReport { ok: boolean; checks: PrereqCheck[] }

export interface RoleDirs { stateDir: string; runCwd: string }
export interface SessionState { sessionId: string }

/** Extra argv/env contributed by prepareSession (overlays, trust, limits). */
export interface SessionPrep { argv: string[]; env: Record<string, string> }
export interface Launch { argv: string[]; env: Record<string, string> }

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
  monitorInstruction(identity: string): string;
  launchNote(name: string): string;
  restartPrompt(identity: string, worklogPath: string): string;
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
  vocabulary: BriefingVocab;
  exitPolicy: ExitPolicy;
}
