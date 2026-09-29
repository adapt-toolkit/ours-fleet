import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { profileEnv } from './cli.js';
import { profileHome, subscriptionsRoot } from './store.js';

/**
 * Ask Haiku for one short reply in the selected Claude home. The JSONL stream
 * can contain a rate_limit_event; prompts, replies and CLI stderr are discarded.
 * This runs only after an explicit UI action and has a time and spend bound.
 */
export function probeClaudeRateLimit(bin: string, profileId: string, timeoutMs = 75_000): Promise<unknown | undefined> {
  const cwd = subscriptionsRoot();
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return new Promise(resolve => {
    const child = spawn(bin, [
      '-p', 'Reply OK.', '--model', 'haiku', '--output-format', 'stream-json',
      '--no-session-persistence', '--strict-mcp-config', '--tools', '',
      '--system-prompt', 'Reply OK.', '--max-budget-usd', '0.05',
    ], {
      cwd, env: profileEnv('CLAUDE_CONFIG_DIR', profileId, profileHome('claude', profileId)),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let pending = '';
    let rateLimit: unknown;
    let done = false;
    const finish = (value?: unknown) => {
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
        } catch { /* Other CLI output is never retained. */ }
      }
    });
    child.once('error', () => finish());
    child.once('close', code => finish(code === 0 ? rateLimit : undefined));
  });
}
