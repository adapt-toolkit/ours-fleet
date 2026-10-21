import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { profileEnv } from './cli.js';
import { profileHome, subscriptionsRoot } from './store.js';

export interface ClaudeProbeResult { rateLimit?: unknown; exhausted: boolean }

const LIMIT_ERROR = /\b(?:hit (?:your |the )?limit|reached (?:your |the )?(?:usage )?limit|usage limits? (?:reached|exceeded)|rate limits? (?:reached|exceeded)|rate_limit_error|quota exceeded|out of (?:usage|credits)|too many requests|429)\b/i;

/**
 * Ask Haiku for one short reply in the selected Claude home. The JSONL stream
 * can contain a rate_limit_event; prompts, replies and CLI stderr are discarded.
 * This runs only after an explicit UI action and has a time and spend bound.
 */
export function probeClaudeRateLimit(bin: string, profileId: string, timeoutMs = 75_000): Promise<ClaudeProbeResult | undefined> {
  const cwd = subscriptionsRoot();
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return new Promise(resolve => {
    const child = spawn(bin, [
      '-p', 'Reply OK.', '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--tools', '',
      '--system-prompt', 'Reply OK.', '--max-budget-usd', '0.05',
    ], {
      cwd, env: profileEnv('CLAUDE_CONFIG_DIR', profileId, profileHome('claude', profileId)),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    let rateLimit: unknown;
    let exhausted = false;
    let done = false;
    const finish = (value?: ClaudeProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      pending += String(chunk);
      if (pending.length > 64 * 1024 && !pending.includes('\n')) { child.kill('SIGKILL'); finish(); return; }
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.length > 64 * 1024) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === 'rate_limit_event')
            rateLimit = event.rate_limit_info ?? event.rateLimitInfo ?? event.rate_limit ?? event.rateLimit ?? event;
          if ((event.type === 'result' && event.is_error === true) || event.type === 'error') {
            const error = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : undefined;
            const message = typeof event.result === 'string' ? event.result
              : typeof event.error === 'string' ? event.error : error?.message;
            if (typeof message === 'string' && LIMIT_ERROR.test(message.slice(0, 4000))) exhausted = true;
          }
        } catch { /* Other CLI output is never retained. */ }
      }
    });
    // Some CLI failures are reported only on stderr. Inspect a small rolling
    // fragment for a limit signal; never retain or return the raw text.
    let stderrTail = '';
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + String(chunk)).slice(-4000);
      if (LIMIT_ERROR.test(stderrTail)) exhausted = true;
    });
    child.once('error', () => finish());
    child.once('close', () => finish(rateLimit !== undefined || exhausted ? { rateLimit, exhausted } : undefined));
  });
}
