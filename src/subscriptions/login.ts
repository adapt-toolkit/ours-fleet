import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { FleetError } from '../application/errors.js';
import { CodexAppServer, profileEnv, type SubscriptionBinaries } from './cli.js';
import type { SubscriptionProvider } from './store.js';

/**
 * A short-lived, browser-owned login. The URL comes from the official CLI and
 * is shown only if its origin is on the provider's allowlist; the user's code
 * goes to the CLI's stdin exactly once and is never stored.
 */
export type LoginState = 'starting' | 'awaiting_user' | 'verifying' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface LoginView {
  loginId: string;
  provider: SubscriptionProvider;
  kind: 'paste_code' | 'device_code';
  state: LoginState;
  url?: string;
  /** Device code to type at `url`; only exposed while the user still needs it. */
  userCode?: string;
  expiresAt: string;
  error?: string;
}

export const LOGIN_TTL_MS = 10 * 60_000;

export const LOGIN_URL_ALLOWLIST: Record<SubscriptionProvider, string[]> = {
  claude: ['claude.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com'],
  codex: ['auth.openai.com'],
};

export function allowedLoginUrl(provider: SubscriptionProvider, raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  return LOGIN_URL_ALLOWLIST[provider].includes(url.hostname) ? url.toString() : undefined;
}

/** Claude paste codes are opaque `code#state` strings; refuse anything else. */
const PASTE_CODE_RE = /^[A-Za-z0-9._~#-]{8,512}$/;
const URL_RE = /https:\/\/[^\s\x07\x1b"'<>\\]+/;

export interface LoginHandle {
  view(): LoginView;
  /** Browser session that started the login; only it may act on it. */
  readonly owner: string;
  submitCode(code: string): void;
  cancel(): void;
  /** Resolves when the CLI has finished (success or not). */
  readonly done: Promise<boolean>;
}

abstract class BaseLogin implements LoginHandle {
  readonly loginId = randomBytes(16).toString('hex');
  readonly expiresAt: number;
  state: LoginState = 'starting';
  url?: string;
  userCode?: string;
  error?: string;
  done!: Promise<boolean>;
  protected finish!: (ok: boolean) => void;
  private readonly timer: NodeJS.Timeout;

  constructor(
    readonly provider: SubscriptionProvider, readonly owner: string,
    readonly kind: LoginView['kind'], now = Date.now(),
  ) {
    this.expiresAt = now + LOGIN_TTL_MS;
    this.done = new Promise(resolve => { this.finish = resolve; });
    this.timer = setTimeout(() => this.end('expired', 'login timed out'), LOGIN_TTL_MS);
    this.timer.unref?.();
  }

  view(): LoginView {
    const live = this.state === 'starting' || this.state === 'awaiting_user';
    return {
      loginId: this.loginId, provider: this.provider, kind: this.kind, state: this.state,
      url: live ? this.url : undefined,
      userCode: this.state === 'awaiting_user' ? this.userCode : undefined,
      expiresAt: new Date(this.expiresAt).toISOString(),
      error: this.error,
    };
  }

  abstract submitCode(code: string): void;
  protected abstract stop(): void;

  cancel(): void { this.end('cancelled'); }

  protected end(state: LoginState, error?: string): void {
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(this.state)) return;
    this.state = state;
    this.error = error?.slice(0, 200);
    this.userCode = undefined;
    clearTimeout(this.timer);
    this.stop();
    this.finish(state === 'succeeded');
  }

  /** Called by the service after verifying the new home. */
  complete(ok: boolean, error?: string): void { this.end(ok ? 'succeeded' : 'failed', error); }
}

/** `claude auth login` inside script(1): prints an authorize URL, then reads a paste code. */
export class ClaudeLogin extends BaseLogin {
  private child?: ChildProcessWithoutNullStreams;
  private output = '';
  private submitted = false;
  /** Resolves with the CLI exit status once it exits. */
  exited: Promise<number | null>;

  constructor(owner: string, bins: SubscriptionBinaries, home: string, profileId: string) {
    super('claude', owner, 'paste_code');
    const child = spawn(bins.script, ['-qefc', `${shellQuote(bins.claude)} auth login`, '/dev/null'], {
      env: profileEnv('CLAUDE_CONFIG_DIR', profileId, home), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin.on('error', () => { /* CLI exited; handled by 'close' */ });
    const onData = (chunk: Buffer) => {
      if (this.output.length < 64 * 1024) this.output += chunk.toString('utf8');
      if (!this.url) {
        const match = URL_RE.exec(this.output);
        if (match) {
          const url = allowedLoginUrl('claude', match[0]);
          if (!url) { this.end('failed', 'the CLI returned an unexpected sign-in address'); return; }
          this.url = url;
          this.state = 'awaiting_user';
        }
      }
      // Claude asks for Enter after success; the answer carries no secret.
      if (this.submitted && /press enter/i.test(this.output)) child.stdin.write('\r');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    this.exited = new Promise(resolve => {
      child.once('error', () => { this.end('failed', 'could not start the sign-in'); resolve(null); });
      child.once('close', code => resolve(code));
    });
  }

  submitCode(code: string): void {
    if (this.state !== 'awaiting_user' || this.submitted)
      throw new FleetError('conflict', 'this login is not waiting for a code');
    if (!PASTE_CODE_RE.test(code)) throw new FleetError('invalid_request', 'that does not look like a sign-in code');
    this.submitted = true;
    this.state = 'verifying';
    this.output = '';
    this.child?.stdin.write(`${code}\r`);
  }

  protected stop(): void { this.child?.kill('SIGTERM'); }
}

/** Codex device-code login through the app-server's supported account API. */
export class CodexDeviceLogin extends BaseLogin {
  private server?: CodexAppServer;
  private codexLoginId?: string;
  /** Resolves true when the app-server reports a successful login. */
  completed: Promise<boolean>;

  constructor(owner: string, bins: SubscriptionBinaries, home: string, profileId: string) {
    super('codex', owner, 'device_code');
    this.completed = (async () => {
      try {
        this.server = await CodexAppServer.start(bins.codex, profileEnv('CODEX_HOME', profileId, home));
        const completion = new Promise<boolean>(resolve => {
          this.server!.onNotification((method, params) => {
            const p = params as { loginId?: string | null; success?: boolean; error?: string | null };
            if (method === 'account/login/completed' && (!p.loginId || p.loginId === this.codexLoginId)) {
              if (!p.success) this.error = 'sign-in was not completed';
              resolve(Boolean(p.success));
            }
          });
        });
        const started = await this.server.call<{ type: string; loginId?: string; verificationUrl?: string; userCode?: string }>(
          'account/login/start', { type: 'chatgptDeviceCode' });
        const url = started.verificationUrl && allowedLoginUrl('codex', started.verificationUrl);
        if (!url || !started.userCode) { this.end('failed', 'the CLI returned an unexpected sign-in address'); return false; }
        this.codexLoginId = started.loginId;
        this.url = url;
        this.userCode = String(started.userCode).slice(0, 32);
        this.state = 'awaiting_user';
        const ok = await Promise.race([completion, this.done.then(() => false)]);
        if (this.state === 'awaiting_user') this.state = 'verifying';
        return ok;
      } catch {
        this.end('failed', 'could not start the sign-in');
        return false;
      }
    })();
  }

  submitCode(): void { throw new FleetError('invalid_request', 'device-code logins need no code from Fleet'); }

  protected stop(): void {
    if (this.server && this.codexLoginId && this.state === 'cancelled')
      void this.server.call('account/login/cancel', { loginId: this.codexLoginId }, 3_000).catch(() => {});
    setTimeout(() => this.server?.close(), 500).unref?.();
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
