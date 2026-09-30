import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFLICTING_AUTH_ENV } from './launch.js';
import { DEFAULT_PROFILE_ID } from './store.js';

/**
 * Thin adapters over the official CLIs. Nothing here reads or returns a token
 * value: credentials stay in files the CLIs own, and secrets typed by the user
 * (a Claude paste code) travel only over a child's stdin, never argv or logs.
 */
export interface SubscriptionBinaries {
  claude: string;
  codex: string;
  /** `script(1)`, used to give `claude auth login` the terminal it expects. */
  script: string;
}

export const defaultBinaries = (): SubscriptionBinaries => ({
  claude: process.env.OURS_FLEET_CLAUDE_BIN ?? 'claude',
  codex: process.env.OURS_FLEET_CODEX_BIN ?? 'codex',
  script: 'script',
});

/**
 * Child env for a profile helper: explicit home for added profiles, the CLI
 * default otherwise. Every credential selector either CLI honours is removed,
 * so a helper can only ever see the profile's own login.
 */
export function profileEnv(homeVar: string, profileId: string, home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, BROWSER: 'true', NO_COLOR: '1' };
  for (const key of [...CONFLICTING_AUTH_ENV.claude, ...CONFLICTING_AUTH_ENV.codex, 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'])
    delete env[key];
  if (profileId !== DEFAULT_PROFILE_ID) env[homeVar] = home;
  return env;
}

export interface ClaudeStatus {
  loggedIn: boolean;
  email?: string;
  plan?: string;
  org?: string;
  authMethod?: string;
}

/** `claude auth status --json` (documented: exit 0 when logged in, 1 otherwise). */
export function claudeAuthStatus(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<ClaudeStatus> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['auth', 'status', '--json'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude auth status timed out')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; if (out.length > 64 * 1024) child.kill('SIGKILL'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(out) as Record<string, unknown>; } catch { /* non-JSON: rely on exit code */ }
      const str = (v: unknown) => typeof v === 'string' && v ? v.slice(0, 120) : undefined;
      resolve({
        loggedIn: code === 0 && parsed.loggedIn !== false,
        email: str(parsed.email), plan: str(parsed.subscriptionType), org: str(parsed.orgName),
        authMethod: str(parsed.authMethod),
      });
    });
  });
}

/**
 * Login expiry timestamps from the Claude credentials file. Field names are
 * observed (Claude Code 2.1.x), not a documented contract, so absence is normal.
 * Only the two numbers are kept; the parsed object is discarded immediately.
 */
export function claudeLoginExpiry(home: string): { accessExpiresAt?: number; refreshExpiresAt?: number } {
  try {
    const oauth = (JSON.parse(readFileSync(join(home, '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { expiresAt?: unknown; refreshTokenExpiresAt?: unknown };
    }).claudeAiOauth;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    return { accessExpiresAt: num(oauth?.expiresAt), refreshExpiresAt: num(oauth?.refreshTokenExpiresAt) };
  } catch { return {}; }
}

/** Minimal stdio JSON-RPC client for `codex app-server` (the supported transport). */
export class CodexAppServer {
  private id = 0;
  private buffer = '';
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private closed = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', chunk => this.onData(String(chunk)));
    child.stdin.on('error', () => { /* child exited; pending calls reject on close */ });
    child.stderr.resume();
    child.once('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('codex app-server exited'));
      this.pending.clear();
    });
  }

  static async start(bin: string, env: NodeJS.ProcessEnv): Promise<CodexAppServer> {
    const child = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const server = new CodexAppServer(child);
    await server.call('initialize', { clientInfo: { name: 'ours-fleet', title: 'Ours Fleet', version: '1' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return server;
  }

  call<T = unknown>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('codex app-server exited'));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v as T); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  onNotification(fn: (method: string, params: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    if (!this.closed) this.child.kill();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } };
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id === 'number' && this.pending.has(message.id) && !message.method) {
        const p = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) p.reject(Object.assign(new Error(String(message.error.message ?? 'codex error').slice(0, 300)), { rpcCode: message.error.code }));
        else p.resolve(message.result);
      } else if (message.method) {
        for (const fn of this.listeners) fn(message.method, message.params);
      }
    }
  }
}

/** One-shot use of an app-server for a profile. */
export async function withCodex<T>(bin: string, env: NodeJS.ProcessEnv, fn: (s: CodexAppServer) => Promise<T>): Promise<T> {
  const server = await CodexAppServer.start(bin, env);
  try { return await fn(server); } finally { server.close(); }
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  windowMins?: number;
  resetsAt?: string;
}

interface CodexWindow { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null }
interface CodexSnapshot { limitId?: string | null; limitName?: string | null; primary?: CodexWindow | null; secondary?: CodexWindow | null }

/** Flatten `account/rateLimits/read` into display windows. */
export function codexUsageWindows(result: {
  rateLimits?: CodexSnapshot; rateLimitsByLimitId?: Record<string, CodexSnapshot | undefined> | null;
}): UsageWindow[] {
  const snapshots = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId) : [['codex', result.rateLimits] as const];
  const windows: UsageWindow[] = [];
  for (const [limitId, snap] of snapshots) {
    if (!snap) continue;
    for (const [slot, w] of [['primary', snap.primary], ['secondary', snap.secondary]] as const) {
      if (!w || typeof w.usedPercent !== 'number') continue;
      windows.push({
        id: `${limitId}:${slot}`,
        label: `${snap.limitName ?? limitId} · ${windowName(w.windowDurationMins ?? undefined)}`,
        usedPercent: w.usedPercent,
        windowMins: w.windowDurationMins ?? undefined,
        resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : undefined,
      });
    }
  }
  return windows;
}

export function windowName(mins?: number): string {
  if (!mins) return 'window';
  if (mins === 300) return '5h';
  if (mins === 10_080) return 'weekly';
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}
