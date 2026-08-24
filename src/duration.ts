/** Parse `30s | 10m | 2h` duration strings to milliseconds. */
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const RE = /^(\d+)([smhd])$/;

export function parseDuration(
  text: string,
  opts: { name?: string; minMs?: number } = {},
): number {
  const label = opts.name ?? 'duration';
  const m = RE.exec(text);
  if (!m) throw new Error(`${label}: invalid duration '${text}' (expected e.g. 30s, 10m, 2h, 1d)`);
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  if (!Number.isSafeInteger(ms)) throw new Error(`${label}: '${text}' is too large`);
  if (opts.minMs !== undefined && ms < opts.minMs)
    throw new Error(`${label}: '${text}' is below the minimum ${formatDuration(opts.minMs)}`);
  return ms;
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0 && ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0 && ms >= 60_000) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1_000)}s`;
}
