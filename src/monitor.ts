import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MonitorConfig, NotifyEventType } from './config.js';

// ─── The supervisor-owned message monitor (DESIGN-external-monitor §1, §3, §4) ──
//
// An in-process long-poll client of the ours daemon notification API, hosted by
// the per-role runner (`runOnce`). It primes at the stream tip BEFORE the tmux
// session launches (zero deaf gap), then streams content-free arrival events,
// filters them by the role's wake_sources, coalesces a burst, and injects a
// single `[fleet-monitor] …` line into the console. Failures are written to
// `.monitor-status` (armed | degraded | failed) — they never kill the agent.

/** A content-free arrival event as the daemon serves it over the notifications API. */
export interface NotifyEvent {
  event?: NotifyEventType | string;
  from?: string;
  msg_id?: number | string;
  file_id?: number | string;
  date?: string;
  queued?: number | string;
}

export interface FetchResponse {
  status: number;
  ok: boolean;
  json(): Promise<{ cursor?: number; events?: NotifyEvent[] }>;
}
export type FetchLike = (
  url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponse>;

export interface MonitorTmux {
  has(name: string): Promise<boolean>;
  capture(name: string, lines?: number): Promise<string>;
  sendText(name: string, text: string): Promise<void>;
  sendKey(name: string, key: string): Promise<void>;
}

export interface MonitorDeps {
  fetch: FetchLike;
  tmux: MonitorTmux;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  env: NodeJS.ProcessEnv;
  timers: {
    set(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
    clear(t: ReturnType<typeof setTimeout>): void;
  };
}

// Code constants (not config — YAGNI, design §2).
const DEFAULT_PORT = 3050;
const LONGPOLL_TIMEOUT_MS = 35_000;   // > the daemon's 25s hold
const COALESCE_HOLD_MS = 500;         // straggler poll must not block
const BOOT_GRACE_MS = 15_000;         // hold injection until the TUI is up
const POST_VERIFY_MS = 1_000;
const MAX_ENTER_RETRIES = 2;
const MODAL_RETRY_MS = 5_000;
const BACKOFF_STEP_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;
const PREFIX = '[fleet-monitor]';
const MAX_LINE = 260;
// Turn-outcome observation (issue #19): after a delivered wake, watch the pane
// until the triggered turn settles, then classify it. Code constants (not config):
const TURN_OBSERVE_POLLS = 20;         // give up after ~POLLS × INTERVAL of a still-running turn
const TURN_OBSERVE_INTERVAL_MS = 1_500;
const DEFAULT_TURN_FAIL_THRESHOLD = 3; // fallback when the resolved config omits it

class AuthError extends Error {}

/** Best-effort daemon config (issue #17): the fields the MCP client reads. */
interface DaemonConfig {
  apiToken?: string;
  port?: number;
  stateDir?: string;
}

/** Path to the daemon config the MCP client uses: OURS_CONFIG ?? real ~/.ours/config.json. */
const daemonConfigPath = (env: NodeJS.ProcessEnv): string =>
  env.OURS_CONFIG ?? join(homedir(), '.ours', 'config.json');

/** Match ours-mcp's env integer semantics: parseInt, invalid → absent. */
function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Read the daemon config the way the MCP client does — best-effort. Any missing,
 * malformed, or unreadable config yields `{}` so token resolution falls through
 * (issue #17). Only the well-typed fields we consume are surfaced.
 */
export function readDaemonConfig(env: NodeJS.ProcessEnv): DaemonConfig {
  try {
    const p = JSON.parse(readFileSync(daemonConfigPath(env), 'utf8'));
    const o: DaemonConfig = {};
    if (typeof p.apiToken === 'string' && p.apiToken.trim()) o.apiToken = p.apiToken.trim();
    if (typeof p.port === 'number' && Number.isFinite(p.port)) o.port = p.port;
    if (typeof p.stateDir === 'string') o.stateDir = p.stateDir;
    return o;
  } catch {
    return {};
  }
}

/**
 * Resolve the daemon API token exactly like the MCP client (issue #17), a 3-step
 * chain: `OURS_API_TOKEN` (trimmed) → config `apiToken` (trimmed) → the 0600 owner
 * token at `<stateDir>/daemon-token`. Never generates a token; a failed read of
 * any source (missing/unreadable) silently falls through to the next.
 */
export function resolveApiToken(
  env: NodeJS.ProcessEnv, file: DaemonConfig = readDaemonConfig(env),
): string | undefined {
  const e = env.OURS_API_TOKEN?.trim();
  if (e) return e;
  if (file.apiToken) return file.apiToken;
  const sd = env.OURS_STATE_DIR ?? file.stateDir ?? join(homedir(), '.ours');
  try {
    const t = readFileSync(join(sd, 'daemon-token'), 'utf8').trim();
    if (t) return t;
  } catch { /* missing/unreadable (e.g. cross-user 0600) → fall through */ }
  return undefined;
}

export interface DaemonEndpoint {
  origin: string;
  port: number;
  configPath: string;
  stateDir: string;
  url(name: string): string;
  headers: Record<string, string>;
}

/** Resolve the daemon endpoint + auth header from env → config → defaults. */
export function resolveEndpoint(env: NodeJS.ProcessEnv): DaemonEndpoint {
  const file = readDaemonConfig(env);
  const port = envInt(env, 'OURS_PORT') ?? file.port ?? DEFAULT_PORT;
  const configPath = daemonConfigPath(env);
  const stateDir = env.OURS_STATE_DIR ?? file.stateDir ?? join(homedir(), '.ours');
  const token = resolveApiToken(env, file);
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    port,
    configPath,
    stateDir,
    url: (name: string) => `${origin}/identities/${encodeURIComponent(name)}/notifications`,
    headers: token ? { 'x-ours-api-token': token } : {},
  };
}

/** Actionable, secret-free description of every token source for this profile. */
export function authResolutionHint(ep: DaemonEndpoint): string {
  const tokenPath = join(ep.stateDir, 'daemon-token');
  return `set OURS_API_TOKEN, set apiToken in ${JSON.stringify(ep.configPath)}, or ensure ` +
    `${JSON.stringify(tokenPath)} is readable by the fleet supervisor`;
}

/** Keep only the events whose type the role asked to wake on. */
export function filterEvents(events: NotifyEvent[], wakeSources: string[]): NotifyEvent[] {
  const set = new Set(wakeSources);
  return events.filter(e => e.event !== undefined && set.has(e.event));
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const plural = (n: number, one: string, many = one + 's') => (n === 1 ? one : many);

/**
 * Summarize a (coalesced) batch of events into one content-free console line —
 * count + senders + ids, ending in the call to action. Falls back to compact
 * counts when a burst would blow past the length cap (design §3, edge: burst).
 */
export function formatNotificationLine(events: NotifyEvent[]): string {
  const of = (t: string) => events.filter(e => e.event === t);
  const msgs = of('message_received');
  const files = of('file_received');
  const intros = of('local_contact_request');
  const pending = of('pending_message');
  const known = new Set(['message_received', 'file_received', 'local_contact_request', 'pending_message']);
  const others = events.filter(e => !known.has(e.event ?? ''));

  const senders = (list: NotifyEvent[]) => uniq(list.map(e => e.from ?? '?')).join(', ');
  const ids = (list: NotifyEvent[]) => {
    const xs = list.map(e => e.msg_id).filter(v => v !== undefined);
    return xs.length ? ` (${xs.map(x => `#${x}`).join(', ')})` : '';
  };

  const clauses: string[] = [];
  if (msgs.length) clauses.push(`${msgs.length} new ${plural(msgs.length, 'message')} from ${senders(msgs)}${ids(msgs)}`);
  if (files.length) clauses.push(`${files.length} ${plural(files.length, 'file')} from ${senders(files)}`);
  if (intros.length) clauses.push(`${intros.length} pending ${plural(intros.length, 'introduction')} from ${senders(intros)}`);
  if (pending.length) clauses.push(`${pending.length} queued ${plural(pending.length, 'message')} from ${senders(pending)}`);
  if (others.length) clauses.push(`${others.length} other ${plural(others.length, 'event')} (${uniq(others.map(e => e.event ?? '?')).join(', ')})`);

  const line = `${PREFIX} ${clauses.join(', ')} — run get_messages`;
  if (line.length <= MAX_LINE) return line;
  const compact = [
    msgs.length && `${msgs.length} messages`,
    files.length && `${files.length} files`,
    intros.length && `${intros.length} introductions`,
    pending.length && `${pending.length} queued`,
    others.length && `${others.length} other`,
  ].filter(Boolean).join(', ');
  return `${PREFIX} ${compact} — run get_messages`;
}

/**
 * Heuristic: does the pane show a modal selection dialog we must not `Enter`
 * into? Markers are the deployed Claude Code trust/permission dialogs — a `❯`
 * pointer beside numbered options, or a "Do you want …" prompt (design §3.2,
 * open question (a): refine empirically). A running turn is NOT modal.
 */
export function looksModal(pane: string): boolean {
  if (/Do you want\b/i.test(pane)) return true;
  const hasPointer = /❯/.test(pane);
  const hasNumbered = /(^|\n)\s*[❯>]?\s*\d+[.)]\s+\S/.test(pane);
  return hasPointer && hasNumbered;
}

/**
 * Heuristic: did the turn shown in this pane TERMINATE in an API-level error?
 * Claude Code renders a failed turn's tail as an `API Error:` line (a Usage-Policy
 * refusal, a 4xx, etc.). We scan a generous tail window so the marker survives a
 * trailing idle composer redrawn beneath it (design §3.2, refine empirically).
 * The N-consecutive threshold in the Monitor debounces the odd false match.
 */
export function looksApiError(pane: string): boolean {
  const tail = pane.split('\n').slice(-15).join('\n');
  return /\bAPI Error\b/i.test(tail);
}

/**
 * Heuristic: is a turn still RUNNING in this pane? Claude Code shows a live
 * "esc to interrupt" footer (often with an elapsed-seconds meter) while a turn
 * streams. Absence of any running marker — and no API error — means the turn has
 * settled (completed). Kept a positive check so a quiet idle pane reads as done.
 */
export function looksRunning(pane: string): boolean {
  const tail = pane.split('\n').slice(-6).join('\n');
  if (/esc to interrupt/i.test(tail)) return true;   // Claude Code's running footer
  if (/\(\s*\d+s\b/.test(tail)) return true;         // "(12s · … tokens)" elapsed meter
  return false;
}

/** Is the injected line still sitting unsubmitted in the composer (bottom of pane)? */
function stillInComposer(pane: string, line: string): boolean {
  const frag = line.slice(0, 48);
  const tail = pane.split('\n').slice(-4).join('\n');
  return tail.includes(frag);
}

export interface MonitorOpts {
  name: string;
  agentDir: string;
  cfg: MonitorConfig;
  deps: MonitorDeps;
}

/** The lifecycle surface the runner drives: prime pre-launch, run, stop on pid death. */
export interface MonitorHandle {
  prime(): Promise<void>;
  run(pid: number): Promise<void>;
  stop(): void;
}

export class Monitor {
  private readonly name: string;
  private readonly cfg: MonitorConfig;
  private readonly deps: MonitorDeps;
  private readonly ep: ReturnType<typeof resolveEndpoint>;
  private readonly statusPath: string;
  private readonly cursorPath: string;
  private cursor: number | null = null;
  private fatal = false;
  private stopped = false;
  private bootDeadline = 0;
  private currentAbort: AbortController | null = null;
  // Refusal-wedge detector (issue #19): consecutive delivered wakes whose turn
  // ended in an API error with no completed turn in between.
  private apiErrorStreak = 0;
  private readonly turnFailThreshold: number;

  constructor(o: MonitorOpts) {
    this.name = o.name;
    this.cfg = o.cfg;
    this.deps = o.deps;
    this.ep = resolveEndpoint(o.deps.env);
    this.statusPath = join(o.agentDir, '.monitor-status');
    this.cursorPath = join(o.agentDir, '.notify-cursor');
    const n = o.cfg.turn_fail_threshold;
    this.turnFailThreshold = typeof n === 'number' && n >= 1 ? n : DEFAULT_TURN_FAIL_THRESHOLD;
  }

  /** Prime at the stream tip (or resume a persisted cursor if the daemon is down). */
  async prime(): Promise<void> {
    try {
      const body = await this.doFetch('tip', LONGPOLL_TIMEOUT_MS);
      this.cursor = typeof body.cursor === 'number' ? body.cursor : 0;
      this.persistCursor();
      this.setStatus('armed');
    } catch (e) {
      if (e instanceof AuthError) {
        this.fatal = true;
        this.setStatus(`failed: ${e.message}`);
      } else {
        this.cursor = this.readPersistedCursor();
        this.setStatus(`degraded: prime failed (${msg(e)})`);
      }
    }
  }

  /** Long-poll → filter → coalesce → inject, until the pane pid dies or stop(). */
  async run(pid: number): Promise<void> {
    if (this.fatal) return;
    this.bootDeadline = this.deps.now() + BOOT_GRACE_MS;
    let backoff = 0;
    while (!this.stopped) {
      if (!this.deps.isAlive(pid)) { this.setStatus('degraded: session offline'); return; }
      let body: { cursor?: number; events?: NotifyEvent[] };
      try {
        body = await this.doFetch(String(this.cursor ?? 0), LONGPOLL_TIMEOUT_MS);
        backoff = 0;
      } catch (e) {
        if (this.stopped) return;
        if (e instanceof AuthError) { this.fatal = true; this.setStatus(`failed: ${e.message}`); return; }
        backoff = Math.min(backoff + BACKOFF_STEP_MS, BACKOFF_MAX_MS);
        this.setStatus(`degraded: stream hiccup (${msg(e)})`);
        await this.deps.sleep(backoff);
        continue;
      }
      this.advance(body.cursor);
      const batch = filterEvents(body.events ?? [], this.cfg.wake_sources);
      if (batch.length === 0) continue;
      await this.coalesce(batch);
      await this.deliver(pid, batch);
    }
  }

  stop(): void {
    this.stopped = true;
    this.currentAbort?.abort();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Gather stragglers arriving within batch_ms so a burst lands as one line. */
  private async coalesce(batch: NotifyEvent[]): Promise<void> {
    if (this.cfg.batch_ms <= 0 || this.stopped) return;
    await this.deps.sleep(this.cfg.batch_ms);
    if (this.stopped) return;
    try {
      const more = await this.doFetch(String(this.cursor ?? 0), COALESCE_HOLD_MS);
      this.advance(more.cursor);
      batch.push(...filterEvents(more.events ?? [], this.cfg.wake_sources));
    } catch { /* no stragglers / abort — deliver what we have */ }
  }

  private async deliver(pid: number, batch: NotifyEvent[]): Promise<void> {
    const state = await this.awaitInjectable(pid);
    if (state !== 'ready') {
      if (state === 'offline') this.setStatus('degraded: offline during delivery');
      return; // events remain covered by unread.json / SessionStart backlog
    }
    const line = formatNotificationLine(batch);
    await this.deps.tmux.sendText(this.name, line);   // send-keys -l + Enter
    let delivered = false;
    // Verify submission for THIS line even if stop() arrives mid-flight: the text
    // is already in the composer and we want it submitted (at-least-once). A truly
    // dead pane makes safeCapture return '' ⇒ not-in-composer ⇒ breaks, no wasted Enter.
    for (let i = 0; i < MAX_ENTER_RETRIES; i++) {
      await this.deps.sleep(POST_VERIFY_MS);
      const pane = await safeCapture(this.deps.tmux, this.name);
      if (!stillInComposer(pane, line)) { delivered = true; break; }
      await this.deps.tmux.sendKey(this.name, 'Enter');
    }
    if (!delivered) { this.setStatus('degraded: injection unverified'); return; }
    // The wake landed and a turn started; observe how that turn terminates so a
    // refusal-wedge (every turn dies with `API Error:` while delivery stays green)
    // becomes visible in `.monitor-status` instead of masquerading as armed (#19).
    await this.observeTurnOutcome(pid);
  }

  /**
   * Watch the pane until the just-triggered turn settles, then fold its outcome
   * into the API-error streak and republish `.monitor-status`. A completed turn
   * (or an inconclusive give-up) resets/keeps the streak; an `API Error:` tail
   * grows it. Once the streak reaches the threshold the status degrades; a later
   * completed turn flips it back to armed. Detection only — no remediation (#19).
   */
  private async observeTurnOutcome(pid: number): Promise<void> {
    for (let i = 0; i < TURN_OBSERVE_POLLS; i++) {
      if (this.stopped) return;                                  // shutting down — leave status
      if (!this.deps.isAlive(pid) || !(await this.deps.tmux.has(this.name))) return; // loop marks offline
      const pane = await safeCapture(this.deps.tmux, this.name);
      if (looksApiError(pane)) { this.recordTurn('api-error'); return; }
      if (!looksRunning(pane)) { this.recordTurn('completed'); return; }
      await this.deps.sleep(TURN_OBSERVE_INTERVAL_MS);
    }
    this.recordTurn('inconclusive');   // still running at give-up: hold the streak, don't re-arm
  }

  /** Update the consecutive-API-error streak and derive `.monitor-status` from it. */
  private recordTurn(outcome: 'api-error' | 'completed' | 'inconclusive'): void {
    if (outcome === 'api-error') this.apiErrorStreak++;
    else if (outcome === 'completed') this.apiErrorStreak = 0;
    // 'inconclusive' leaves the streak (and therefore the status) unchanged.
    this.setStatus(this.apiErrorStreak >= this.turnFailThreshold
      ? 'degraded: turns failing (api error)'
      : 'armed');
  }

  /** Block until the console can accept input; classify offline/stopped/ready. */
  private async awaitInjectable(pid: number): Promise<'ready' | 'offline' | 'stopped'> {
    for (;;) {
      if (this.stopped) return 'stopped';
      if (!this.deps.isAlive(pid) || !(await this.deps.tmux.has(this.name))) return 'offline';
      const now = this.deps.now();
      if (now < this.bootDeadline) { await this.deps.sleep(this.bootDeadline - now); continue; }
      const pane = await safeCapture(this.deps.tmux, this.name);
      if (looksModal(pane)) { await this.deps.sleep(MODAL_RETRY_MS); continue; }
      return 'ready';
    }
  }

  private async doFetch(since: string, holdMs: number): Promise<{ cursor?: number; events?: NotifyEvent[] }> {
    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    const timer = this.deps.timers.set(() => ctrl.abort(), holdMs);
    let resp: FetchResponse;
    try {
      resp = await this.deps.fetch(`${this.ep.url(this.name)}?since=${since}`,
        { headers: this.ep.headers, signal: ctrl.signal });
    } finally {
      this.deps.timers.clear(timer);
      this.currentAbort = null;
    }
    if (resp.status === 401)
      throw new AuthError(
        `daemon rejected the API token (401) — ${authResolutionHint(this.ep)}`);
    if (!resp.ok) throw new Error(`daemon returned HTTP ${resp.status}`);
    return resp.json();
  }

  private advance(cursor: number | undefined): void {
    if (typeof cursor === 'number' && cursor !== this.cursor) {
      this.cursor = cursor;
      this.persistCursor();
    }
  }

  private persistCursor(): void {
    try { if (this.cursor !== null) writeFileSync(this.cursorPath, `${this.cursor}\n`); }
    catch (e) { this.deps.log(`[${this.name}] monitor: failed to persist cursor: ${msg(e)}`); }
  }

  private readPersistedCursor(): number | null {
    try {
      if (!existsSync(this.cursorPath)) return null;
      const n = parseInt(readFileSync(this.cursorPath, 'utf8').trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  }

  private setStatus(s: string): void {
    try { writeFileSync(this.statusPath, `${s}\n`); }
    catch (e) { this.deps.log(`[${this.name}] monitor: failed to write status: ${msg(e)}`); }
    if (!s.startsWith('armed')) this.deps.log(`[${this.name}] monitor ${s}`);
  }
}

export function createMonitor(o: MonitorOpts): Monitor {
  return new Monitor(o);
}

async function safeCapture(tmux: MonitorTmux, name: string): Promise<string> {
  try { return await tmux.capture(name); } catch { return ''; }
}

const msg = (e: unknown): string => (e as Error)?.message ?? String(e);
