import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  /**
   * Structured prompt delivery used by ACP sessions. Tmux remains the fallback.
   * `succeeded` is the turn's TERMINAL result, not merely that the session took
   * the prompt: a refused or cancelled wake was seen and not acted on, and must
   * not commit the cursor.
   */
  delivery?: {
    submit(
      text: string,
      options?: { interrupt?: boolean },
    ): Promise<{ succeeded: boolean; outcome: string; detail?: string }>;
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
// How long delivery may wait on a modal before giving up. Unbounded waiting made
// any modal — real or false-positive — wedge wake delivery forever while
// `.monitor-status` still read `armed`, so the failure was invisible from outside.
// 2 minutes: long enough that a human answering a real dialog is not punished with
// a spurious `degraded`, short enough that a wedge shows up in the status while
// it still matters. Giving up drops nothing — the events stay covered by
// unread.json / the SessionStart backlog, and the next wake retries.
const MODAL_GIVE_UP_MS = 120_000;
const MAX_MODAL_WAITS = Math.floor(MODAL_GIVE_UP_MS / MODAL_RETRY_MS);
// Keys that reset the composer to empty before we type a wake, so a human's
// unsubmitted keystrokes can't concatenate with — or wedge (e.g. via an open
// slash-command menu that captures Enter) — the injected line. C-e moves to end
// of line, C-u kills to start ⇒ whole single line cleared regardless of cursor.
const COMPOSER_CLEAR_KEYS = ['C-e', 'C-u'];
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

/**
 * Why the monitor is not healthy. Each cause clears on its OWN recovery signal
 * and nothing else — a successful poll proves the stream works, and proves
 * nothing whatsoever about whether wakes are being delivered or whether the
 * turns they trigger keep dying.
 */
export type StatusCause =
  | 'connectivity'    // prime/poll/stream failure      → cleared by a successful poll
  | 'delivery'        // the wake could not be injected → cleared by a delivered wake
  | 'modal'           // the pane held a dialog         → cleared by a delivered wake
  | 'offline'         // the session is gone            → the run loop ends
  | 'turns-failing'   // delivered wakes keep dying     → cleared by a completed turn
  | 'auth';           // the daemon rejected the token  → fatal

interface StatusEntry {
  level: 'degraded' | 'failed';
  detail: string;
  at: string;
}

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

// ─── Modal-dialog detection (design §3.2, refined empirically) ────────────────
//
// `❯` is Claude Code's ordinary composer prompt, so it is on screen in nearly
// every capture. Testing for it *anywhere* in the pane therefore says nothing;
// paired with "a numbered line anywhere", it flagged every prose list ("1) foo
// 2) bar") and every markdown step list as a dialog. What actually distinguishes
// a select dialog is that its pointer sits ON one of the numbered options.
//
// `[^\S\n]` is horizontal whitespace: unlike `\s` it cannot span a line break,
// so these patterns can't stitch a `❯` in the composer onto a number ten lines up.

/** `❯ 1. Yes` — the pointer on a numbered option. The shape of every CC dialog. */
const POINTED_OPTION = /❯[^\S\n]*\d+[.)][^\S\n]+\S/;
/** A dialog's own chrome. Neither is sufficient alone — see `looksModal`. */
const DIALOG_MARKERS = [/\bDo you want\b/i, /\bEnter to confirm\b/i];
/**
 * A numbered option as a dialog paints it: line start (or a box border), then the
 * number. Anchored so prose can't match mid-sentence ("…rewrote 3. Then we…").
 */
const OPTION_LINE = /^[^\S\n]*(?:[│┃|][^\S\n]*)?(?:❯[^\S\n]*)?\d+[.)][^\S\n]+\S/;
/** How far from a marker line the options may sit (footers trail them, questions lead). */
const OPTION_WINDOW = 10;
/** Options rendered inline on the marker's own line: "…? 1. Yes 2. No". */
const INLINE_OPTION = /\d+[.)][^\S\n]+\S/g;

/**
 * Heuristic: does the pane show a modal selection dialog we must not `Enter`
 * into? Two independent signals, both requiring the *option* shape, not just a
 * loose numbered line:
 *
 *  1. the `❯` pointer sitting on a numbered option — `❯ 1. Use this MCP server`;
 *  2. a dialog marker ("Do you want …", "Enter to confirm") with ≥2 numbered
 *     options within `OPTION_WINDOW` lines — this still catches a dialog captured
 *     mid-redraw, before its pointer row is painted.
 *
 * A running turn, a prose list, and a markdown step list are all NOT modal.
 * Erring modal is the safe direction (a wake is retried; an `Enter` into a live
 * permission dialog is not undoable), which is why signal 2 is kept — but a bare
 * marker with no options no longer suffices, because Claude Code closes turns
 * with exactly that prose ("Do you want me to open the PR?").
 */
export function looksModal(pane: string): boolean {
  if (POINTED_OPTION.test(pane)) return true;
  const lines = pane.split('\n');
  const marker = lines.findIndex(l => DIALOG_MARKERS.some(re => re.test(l)));
  if (marker < 0) return false;
  const from = Math.max(0, marker - OPTION_WINDOW);
  const near = lines.slice(from, marker + OPTION_WINDOW + 1);
  if (near.filter(l => OPTION_LINE.test(l)).length >= 2) return true;
  return (lines[marker].match(INLINE_OPTION) ?? []).length >= 2;
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

const COMPOSER_TOP = /^[^\S\n]*[╭┌][─━]/;
const COMPOSER_BOTTOM = /^[^\S\n]*[╰└][─━]/;
const COMPOSER_PROMPT = /^[^\S\n]*(?:[│┃|][^\S\n]*)?[❯›>][^\S\n]*$/;

/**
 * Remove wrapping-only whitespace and box chrome from composer rows. Notification
 * lines contain no meaningful whitespace distinction, so this lets a fragment
 * cross an arbitrary terminal wrap without matching unrelated transcript text.
 */
function normalizeComposerRows(rows: string[]): string {
  return rows.map((raw, i) => {
    let row = raw;
    if (i > 0) row = row.replace(/^[^\S\n]*(?:[│┃|][^\S\n]*)?/, '');
    row = row.replace(/[^\S\n]*(?:[│┃|])?[^\S\n]*$/, '');
    return row;
  }).join('').replace(/\s+/g, '');
}

/**
 * Is the injected line still sitting unsubmitted in the composer?
 *
 * The footer has variable height and the line may wrap across any number of
 * rows, so a fixed tail window cannot identify the composer. Prefer the final
 * bordered composer region; for a borderless/truncated capture, require the
 * notification prefix to follow a composer prompt. This keeps old submitted
 * wake lines in the transcript from causing stray Enters.
 */
function stillInComposer(pane: string, line: string): boolean {
  if (!pane) return false; // dead pane: do not waste Enters
  const lines = pane.split('\n');

  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (COMPOSER_BOTTOM.test(lines[i])) { bottom = i; break; }
  }
  let top = -1;
  if (bottom >= 0) {
    for (let i = bottom - 1; i >= 0; i--) {
      if (COMPOSER_TOP.test(lines[i])) { top = i; break; }
    }
  }

  const from = top >= 0 ? top + 1 : 0;
  const to = bottom >= 0 ? bottom : lines.length;
  let wakeRow = -1;
  let wakeColumn = -1;
  for (let i = to - 1; i >= from; i--) {
    const column = lines[i].lastIndexOf(PREFIX);
    if (column >= 0) { wakeRow = i; wakeColumn = column; break; }
  }
  if (wakeRow < 0) return false;

  // Without both box boundaries, only trust text visibly in a composer prompt.
  // This is the safe fallback for borderless TUIs and truncated captures.
  if (top < 0 && !COMPOSER_PROMPT.test(lines[wakeRow].slice(0, wakeColumn))) return false;

  const rows = lines.slice(wakeRow, to);
  rows[0] = rows[0].slice(wakeColumn);
  return normalizeComposerRows(rows).includes(line.replace(/\s+/g, ''));
}

export interface MonitorOpts {
  name: string;
  /** Ours identity whose notification stream is authoritative (may differ from role name). */
  identity?: string;
  agentDir: string;
  cfg: MonitorConfig;
  deps: MonitorDeps;
}

/** The lifecycle surface the runner drives: prime pre-launch, run, stop on pid death. */
export interface MonitorHandle {
  prime(options?: { resetCursor?: boolean }): Promise<void>;
  run(pid: number): Promise<void>;
  stop(): void;
}

export class Monitor {
  private readonly name: string;
  private readonly identity: string;
  private readonly cfg: MonitorConfig;
  private readonly deps: MonitorDeps;
  private readonly ep: ReturnType<typeof resolveEndpoint>;
  private readonly statusPath: string;
  private readonly cursorPath: string;
  private readonly statePath: string;
  private cursor: number | null = null;
  private deliveredCursor: number | null = null;
  private pendingState: { count: number; eventTypes: string[]; attempts: number } | null = null;
  private fatal = false;
  private stopped = false;
  private bootDeadline = 0;
  private currentAbort: AbortController | null = null;
  // Refusal-wedge detector (issue #19): consecutive delivered wakes whose turn
  // ended in an API error with no completed turn in between.
  private apiErrorStreak = 0;
  private readonly turnFailThreshold: number;
  /** Active degradations, keyed by cause. Empty means armed. */
  private readonly causes = new Map<StatusCause, StatusEntry>();

  constructor(o: MonitorOpts) {
    this.name = o.name;
    this.identity = o.identity ?? o.name;
    this.cfg = o.cfg;
    this.deps = o.deps;
    this.ep = resolveEndpoint(o.deps.env);
    this.statusPath = join(o.agentDir, '.monitor-status');
    this.cursorPath = join(o.agentDir, '.notify-cursor');
    this.statePath = join(o.agentDir, '.monitor-state.json');
    const n = o.cfg.turn_fail_threshold;
    this.turnFailThreshold = typeof n === 'number' && n >= 1 ? n : DEFAULT_TURN_FAIL_THRESHOLD;
  }

  /**
   * Resume the last delivered cursor during ordinary fleet-owned restarts.
   * A native→fleet ownership transition resets at stream tip because the native
   * owner was responsible for arrivals while the supervisor was inactive.
   */
  async prime(options: { resetCursor?: boolean } = {}): Promise<void> {
    const persisted = options.resetCursor ? null : this.readPersistedCursor();
    if (persisted !== null) {
      this.cursor = persisted;
      this.deliveredCursor = persisted;
      this.writeStatus();
      return;
    }
    try {
      const body = await this.doFetch('tip', LONGPOLL_TIMEOUT_MS);
      this.cursor = typeof body.cursor === 'number' ? body.cursor : 0;
      this.persistCursor();
      this.writeStatus();
    } catch (e) {
      if (e instanceof AuthError) {
        this.fatal = true;
        this.degrade('auth', e.message, 'failed');
      } else {
        this.cursor = null;
        this.degrade('connectivity', `prime failed (${msg(e)})`);
      }
    }
  }

  /** Long-poll → filter → coalesce → inject, until the pane pid dies or stop(). */
  async run(pid: number): Promise<void> {
    if (this.fatal) return;
    this.bootDeadline = this.deps.now() + BOOT_GRACE_MS;
    let backoff = 0;
    const pending: NotifyEvent[] = [];
    while (!this.stopped) {
      if (!this.deps.isAlive(pid)) { this.degrade('offline', 'session offline'); return; }
      let body: { cursor?: number; events?: NotifyEvent[] };
      try {
        body = await this.doFetch(String(this.cursor ?? 0), LONGPOLL_TIMEOUT_MS);
        backoff = 0;
        // A poll that worked proves the stream is healthy — and only that.
        this.recover('connectivity');
      } catch (e) {
        if (this.stopped) return;
        if (e instanceof AuthError) { this.fatal = true; this.degrade('auth', e.message, 'failed'); return; }
        backoff = Math.min(backoff + BACKOFF_STEP_MS, BACKOFF_MAX_MS);
        this.degrade('connectivity', `stream hiccup (${msg(e)})`);
        await this.deps.sleep(backoff);
        continue;
      }
      this.advance(body.cursor, false);
      const batch = filterEvents(body.events ?? [], this.cfg.wake_sources);
      pending.push(...batch);
      if (pending.length === 0) {
        this.persistCursor();
        continue;
      }
      this.pendingState = {
        count: pending.length,
        eventTypes: uniq(pending.map(event => event.event ?? 'unknown')),
        attempts: (this.pendingState?.attempts ?? 0) + 1,
      };
      this.persistState();
      await this.coalesce(pending);
      // Do not durably commit this cursor until the session explicitly accepts
      // the wake. If delivery fails or the runner crashes, the daemon replays
      // from the last committed cursor and the wake is attempted again.
      let accepted = false;
      try {
        accepted = await this.deliver(pid, pending);
      } catch (e) {
        this.degrade('delivery', `delivery failed (${msg(e)})`);
      }
      if (accepted) {
        pending.length = 0;
        this.pendingState = null;
        this.persistCursor();
      }
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
      this.advance(more.cursor, false);
      batch.push(...filterEvents(more.events ?? [], this.cfg.wake_sources));
    } catch { /* no stragglers / abort — deliver what we have */ }
  }

  private async deliver(pid: number, batch: NotifyEvent[]): Promise<boolean> {
    const line = formatNotificationLine(batch);
    if (this.deps.delivery) {
      const result = await this.deps.delivery.submit(line, { interrupt: this.cfg.interrupt });
      if (!result.succeeded) {
        // Name the reason: "refused" and "cancelled" are the agent's answer,
        // not a transport problem, and an operator has to be able to tell them
        // apart from a dead socket.
        this.degrade('delivery', `wake ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`);
        return false;
      }
      this.recover('delivery', 'modal');
      if (result.detail !== 'injected' && result.detail !== 'startedNewTurn')
        this.recordTurn('completed');
      return true;
    }
    if (this.cfg.interrupt) await this.deps.tmux.sendKey(this.name, 'C-c');
    const state = await this.awaitInjectable(pid);
    if (state !== 'ready') {
      if (state === 'offline') this.degrade('offline', 'offline during delivery');
      else if (state === 'modal')
        this.degrade('modal', `modal wedge — pane held a dialog for ` +
          `${MODAL_GIVE_UP_MS / 1000}s, wake not injected`);
      return false;
    }
    await this.clearComposer();                        // start from an empty composer
    await this.deps.tmux.sendText(this.name, line);   // send-keys -l + Enter
    let delivered = false;
    // Verify submission for THIS line even if stop() arrives mid-flight: the text
    // is already in the composer and we want it submitted (at-least-once). A truly
    // dead pane makes safeCapture return '' ⇒ not-in-composer ⇒ breaks, no wasted Enter.
    for (let i = 0; i < MAX_ENTER_RETRIES;) {
      await this.deps.sleep(POST_VERIFY_MS);
      const capture = await safeCapture(this.deps.tmux, this.name);
      if (!capture.ok) {
        this.degrade('delivery', 'capture failed during injection verification');
        return false;
      }
      // A dialog can appear after the initial send. Never let a verification
      // retry confirm it. Wait under the same bounded modal policy as initial
      // injection, then re-capture immediately before considering Enter.
      if (looksModal(capture.pane)) {
        const state = await this.awaitInjectable(pid);
        if (state === 'ready') continue;
        if (state === 'offline')
          this.degrade('offline', 'offline during injection verification');
        else if (state === 'modal')
          this.degrade('modal', `modal wedge during injection verification — ` +
            `no Enter sent for ${MODAL_GIVE_UP_MS / 1000}s`);
        return false;
      }
      if (!stillInComposer(capture.pane, line)) { delivered = true; break; }
      await this.deps.tmux.sendKey(this.name, 'Enter');
      i++;
    }
    if (!delivered) { this.degrade('delivery', 'injection unverified'); return false; }
    this.recover('delivery', 'modal');
    // The wake landed and a turn started; observe how that turn terminates so a
    // refusal-wedge (every turn dies with `API Error:` while delivery stays green)
    // becomes visible in `.monitor-status` instead of masquerading as armed (#19).
    await this.observeTurnOutcome(pid);
    return true;
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
      const capture = await safeCapture(this.deps.tmux, this.name);
      if (!capture.ok) {
        this.degrade('delivery', 'capture failed during turn observation');
        return;
      }
      if (looksApiError(capture.pane)) { this.recordTurn('api-error'); return; }
      if (!looksRunning(capture.pane)) { this.recordTurn('completed'); return; }
      await this.deps.sleep(TURN_OBSERVE_INTERVAL_MS);
    }
    this.recordTurn('inconclusive');   // still running at give-up: hold the streak, don't re-arm
  }

  /** Update the consecutive-API-error streak and derive `.monitor-status` from it. */
  private recordTurn(outcome: 'api-error' | 'completed' | 'inconclusive'): void {
    if (outcome === 'inconclusive') return;   // no evidence either way; leave the streak
    if (outcome === 'api-error') this.apiErrorStreak++;
    else this.apiErrorStreak = 0;
    if (this.apiErrorStreak >= this.turnFailThreshold)
      this.degrade('turns-failing', 'turns failing (api error)');
    else if (outcome === 'completed')
      // A turn that ran to the end is the ONLY thing that clears this.
      this.recover('turns-failing');
  }

  /**
   * Reset the composer to empty before typing a wake. Without this, any
   * unsubmitted text a human left in the input concatenates with the injected
   * line (`stray[fleet-monitor] …`) or, when it has opened a slash-command menu,
   * swallows the submit Enter entirely — wedging every subsequent injection until
   * the composer is cleared by hand. Best-effort: a dead pane just makes the keys
   * no-ops (delivery is still verified downstream).
   */
  private async clearComposer(): Promise<void> {
    for (const key of COMPOSER_CLEAR_KEYS) await this.deps.tmux.sendKey(this.name, key);
  }

  /**
   * Block until the console can accept input; classify offline/stopped/ready, or
   * `modal` when the pane still looks modal after `MODAL_GIVE_UP_MS`. The bound is
   * what keeps a modal from wedging delivery silently: we still never `Enter` into
   * the dialog, but the give-up is reported instead of retried forever.
   */
  private async awaitInjectable(pid: number): Promise<'ready' | 'offline' | 'stopped' | 'modal'> {
    let modalWaits = 0;
    for (;;) {
      if (this.stopped) return 'stopped';
      if (!this.deps.isAlive(pid) || !(await this.deps.tmux.has(this.name))) return 'offline';
      const now = this.deps.now();
      if (now < this.bootDeadline) { await this.deps.sleep(this.bootDeadline - now); continue; }
      const capture = await safeCapture(this.deps.tmux, this.name);
      if (!capture.ok) {
        this.degrade('delivery', 'capture failed while checking session readiness');
        await this.deps.sleep(MODAL_RETRY_MS);
        continue;
      }
      if (!looksModal(capture.pane)) return 'ready';
      if (modalWaits++ >= MAX_MODAL_WAITS) return 'modal';
      await this.deps.sleep(MODAL_RETRY_MS);
    }
  }

  private async doFetch(since: string, holdMs: number): Promise<{ cursor?: number; events?: NotifyEvent[] }> {
    const ctrl = new AbortController();
    this.currentAbort = ctrl;
    const timer = this.deps.timers.set(() => ctrl.abort(), holdMs);
    let resp: FetchResponse;
    try {
      resp = await this.deps.fetch(`${this.ep.url(this.identity)}?since=${since}`,
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

  private advance(cursor: number | undefined, persist = true): void {
    if (typeof cursor === 'number' && cursor !== this.cursor) {
      this.cursor = cursor;
      if (persist) this.persistCursor();
      else this.persistState();
    }
  }

  private persistCursor(): void {
    try {
      if (this.cursor !== null) {
        this.deliveredCursor = this.cursor;
        writeFileSync(this.cursorPath, `${this.cursor}\n`);
        this.persistState();
      }
    }
    catch (e) { this.deps.log(`[${this.name}] monitor: failed to persist cursor: ${msg(e)}`); }
  }

  private readPersistedCursor(): number | null {
    try {
      if (existsSync(this.statePath)) {
        const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as {
          identity?: string; profileKey?: string; deliveredCursor?: number;
        };
        if ((state.identity !== undefined && state.identity !== this.identity)
            || (state.profileKey !== undefined && state.profileKey !== this.ep.origin))
          return null;
        if (typeof state.deliveredCursor === 'number') {
          this.deliveredCursor = state.deliveredCursor;
          return state.deliveredCursor;
        }
      }
      if (!existsSync(this.cursorPath)) return null;
      const n = parseInt(readFileSync(this.cursorPath, 'utf8').trim(), 10);
      if (Number.isFinite(n)) this.deliveredCursor = n;
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  }

  /** Atomically persist body-free delivery state; restart always resumes from deliveredCursor. */
  private persistState(): void {
    try {
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        version: 1,
        identity: this.identity,
        profileKey: this.ep.origin,
        observedCursor: this.cursor,
        deliveredCursor: this.deliveredCursor,
        pending: this.pendingState,
        updatedAt: new Date(this.deps.now()).toISOString(),
      }, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, this.statePath);
    } catch (e) {
      this.deps.log(`[${this.name}] monitor: failed to persist state: ${msg(e)}`);
    }
  }

  /** Record a degradation under its own cause and republish the status. */
  private degrade(cause: StatusCause, detail: string, level: StatusEntry['level'] = 'degraded'): void {
    const previous = this.causes.get(cause);
    this.causes.set(cause, { level, detail, at: new Date(this.deps.now()).toISOString() });
    this.writeStatus();
    if (previous?.detail !== detail) this.deps.log(`[${this.name}] monitor ${level}: ${cause} — ${detail}`);
  }

  /**
   * Clear exactly the causes this recovery signal speaks to. Anything else
   * stays: one successful poll must never be able to erase `turns failing`.
   */
  private recover(...causes: StatusCause[]): void {
    let changed = false;
    for (const cause of causes) changed = this.causes.delete(cause) || changed;
    if (changed) this.deps.log(`[${this.name}] monitor recovered: ${causes.join(', ')}`);
    this.writeStatus();
  }

  /**
   * One line per active cause, each dated; `armed` when there are none. Every
   * line carries an ISO timestamp so an operator can tell a live status from a
   * stale one left behind by a monitor that stopped writing.
   */
  private writeStatus(): void {
    const lines = this.causes.size
      ? [...this.causes.entries()].map(([cause, e]) => `${e.level}: ${cause} at ${e.at} — ${e.detail}`)
      : [`armed at ${new Date(this.deps.now()).toISOString()}`];
    try { writeFileSync(this.statusPath, lines.join('\n') + '\n'); }
    catch (e) { this.deps.log(`[${this.name}] monitor: failed to write status: ${msg(e)}`); }
  }
}

export function createMonitor(o: MonitorOpts): Monitor {
  return new Monitor(o);
}

async function safeCapture(
  tmux: MonitorTmux, name: string,
): Promise<{ ok: true; pane: string } | { ok: false; pane: '' }> {
  try { return { ok: true, pane: await tmux.capture(name) }; }
  catch { return { ok: false, pane: '' }; }
}

const msg = (e: unknown): string => (e as Error)?.message ?? String(e);
