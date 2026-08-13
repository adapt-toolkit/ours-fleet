import {
  closeSync, existsSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync, writeSync,
} from 'node:fs';

/**
 * Crash-safe JSONL primitives for the session event stream.
 *
 * The 06:32 disk-full incident showed what an unguarded `appendFileSync` does
 * under ENOSPC: the kernel short-writes, the already-written prefix stays on
 * disk, and the next successful append lands directly on it — fusing a partial
 * record with a valid later one into a single unparseable line. These helpers
 * make an append all-or-nothing, keep a damaged byte range from ever swallowing
 * a later record, and describe damage rather than quietly dropping it.
 *
 * Single-writer assumption: rollback truncates back to the size observed at the
 * start of the append, so exactly one process may append to a given path.
 */

/** The syscall surface an append needs, injectable so faults can be forced deterministically. */
export interface LogIo {
  openSync(path: string, flags: string, mode?: number): number;
  fstatSync(fd: number): { size: number };
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  ftruncateSync(fd: number, length: number): void;
  closeSync(fd: number): void;
}

export const nodeLogIo: LogIo = {
  openSync: (path, flags, mode) => openSync(path, flags, mode),
  fstatSync: fd => fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  ftruncateSync: (fd, length) => ftruncateSync(fd, length),
  closeSync: fd => closeSync(fd),
};

const NEWLINE = 0x0a;
/** Enough to hold a whole event line as evidence without letting one record dominate the sidecar. */
const MAX_RAW_EVIDENCE_BYTES = 8 * 1024;
const MAX_QUARANTINE_BYTES = 1024 * 1024;

export class AtomicAppendError extends Error {
  constructor(message: string, readonly rollbackFailed: boolean, readonly cause?: unknown) {
    super(message);
    this.name = 'AtomicAppendError';
  }
}

export interface AppendResult {
  /** True when a dangling partial record was closed off before this line was written. */
  repairedBoundary: boolean;
}

export interface AppendOptions {
  io?: LogIo;
  /** Total attempts, including the first. Bounded so a full disk cannot spin. */
  maxAttempts?: number;
  mode?: number;
}

/**
 * Append one line, all or nothing. A failed write is rolled back to the byte
 * length observed before it started, so a partial record never persists; if the
 * file already ends mid-record (damage from before this fix), the line is put on
 * a fresh line so it cannot fuse with the damaged bytes.
 */
export function appendLineAtomic(path: string, line: string, options: AppendOptions = {}): AppendResult {
  const io = options.io ?? nodeLogIo;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const payload = line.endsWith('\n') ? line : line + '\n';
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let fd: number | undefined;
    let sizeBefore = 0;
    try {
      fd = io.openSync(path, 'a+', options.mode ?? 0o600);
      sizeBefore = io.fstatSync(fd).size;
      const repairedBoundary = sizeBefore > 0 && !endsWithNewline(io, fd, sizeBefore);
      const buffer = Buffer.from(repairedBoundary ? '\n' + payload : payload, 'utf8');
      let written = 0;
      try {
        while (written < buffer.length) {
          const advanced = io.writeSync(fd, buffer, written, buffer.length - written);
          // A write that accepts nothing would spin forever and never reach the
          // bounded-retry logic, so it fails here instead.
          if (advanced <= 0) throw new Error(`write made no progress at byte ${written} of ${buffer.length}`);
          written += advanced;
        }
      } catch (writeError) {
        throw rollback(io, fd, sizeBefore, writeError);
      }
      return { repairedBoundary };
    } catch (error) {
      lastError = error;
      // A failed rollback leaves bytes we cannot account for; retrying would
      // append on top of them, so stop and let the caller report it.
      if (error instanceof AtomicAppendError && error.rollbackFailed) break;
    } finally {
      if (fd !== undefined) { try { io.closeSync(fd); } catch { /* the write outcome is what matters */ } }
    }
  }

  throw lastError;
}

function endsWithNewline(io: LogIo, fd: number, size: number): boolean {
  const tail = Buffer.alloc(1);
  const read = io.readSync(fd, tail, 0, 1, size - 1);
  // An unreadable tail is treated as damaged: adding a newline is always safe.
  return read === 1 && tail[0] === NEWLINE;
}

function rollback(io: LogIo, fd: number, sizeBefore: number, writeError: unknown): AtomicAppendError {
  const detail = writeError instanceof Error ? writeError.message : String(writeError);
  try {
    io.ftruncateSync(fd, sizeBefore);
    return new AtomicAppendError(detail, false, writeError);
  } catch (truncateError) {
    const reason = truncateError instanceof Error ? truncateError.message : String(truncateError);
    return new AtomicAppendError(`${detail} (rollback failed: ${reason})`, true, writeError);
  }
}

export type DamageReason = 'truncated_tail' | 'interior_corruption';

export interface DamagedLine {
  /** 1-based line number in the file as read. */
  lineNumber: number;
  /** True byte length of the damaged line, even when `raw` is capped. */
  bytes: number;
  reason: DamageReason;
  /** The damaged bytes, capped for storage; `truncatedEvidence` says when. */
  raw: string;
  truncatedEvidence: boolean;
}

/** A run of sequence numbers that is simply gone — never recoverable, only reportable. */
export interface SequenceGap {
  afterSeq: number;
  beforeSeq: number;
  missing: number;
}

export interface LogRecord {
  version: 1;
  seq: number;
  [key: string]: unknown;
}

export interface ReadLogResult {
  /** Records this version understands and can replay. */
  records: LogRecord[];
  /**
   * Sequence numbers claimed by every readable entry in file order, whatever
   * its version. A record written by a newer version is not replayable here,
   * but it did occupy its number: counting it is what keeps a forward-compatible
   * file from looking like it has a hole, and keeps continuation past it.
   */
  sequence: number[];
  /** Highest sequence still readable anywhere in the file, for monotonic continuation. */
  maxSeq: number;
  damaged: DamagedLine[];
  gaps: SequenceGap[];
}

/**
 * Read the log line by line. One bad line costs exactly that line: everything
 * before and after it is kept, and the damage is described rather than dropped.
 */
export function readLog(path: string): ReadLogResult {
  const empty: ReadLogResult = { records: [], sequence: [], maxSeq: 0, damaged: [], gaps: [] };
  if (!existsSync(path)) return empty;

  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return empty; }
  if (raw === '') return empty;

  const terminated = raw.endsWith('\n');
  const segments = raw.split('\n');
  if (terminated) segments.pop();

  const records: LogRecord[] = [];
  const sequence: number[] = [];
  const damaged: DamagedLine[] = [];
  let maxSeq = 0;

  segments.forEach((segment, index) => {
    if (segment.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment);
    } catch {
      const isFinalSegment = index === segments.length - 1;
      damaged.push({
        lineNumber: index + 1,
        bytes: Buffer.byteLength(segment, 'utf8'),
        // An unterminated final line is a write that never committed; anything
        // else sits between records that did, so it is interior corruption.
        reason: isFinalSegment && !terminated ? 'truncated_tail' : 'interior_corruption',
        raw: segment.slice(0, MAX_RAW_EVIDENCE_BYTES),
        truncatedEvidence: segment.length > MAX_RAW_EVIDENCE_BYTES,
      });
      return;
    }
    // Unknown versions are forward compatibility, not damage: they are not
    // replayed here, but they did claim their sequence number, so they still
    // count towards ordering and continuation.
    const seq = sequenceOf(parsed);
    if (seq === undefined) return;
    sequence.push(seq);
    if (seq > maxSeq) maxSeq = seq;
    if (isLogRecord(parsed)) records.push(parsed);
  });

  return { records, sequence, maxSeq, damaged, gaps: findSequenceGaps(sequence) };
}

/** The sequence a readable entry claims, whatever version wrote it. */
function sequenceOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const seq = (value as { seq?: unknown }).seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined;
}

function isLogRecord(value: unknown): value is LogRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LogRecord>;
  return candidate.version === 1 && typeof candidate.seq === 'number';
}

/**
 * Missing sequence numbers between consecutive records. Records that parse
 * perfectly still leave a hole when the writes between them never landed, so
 * this is computed over whatever ordered run the caller cares about — including
 * a rotated stream followed by its live successor, where the hole falls on the
 * boundary and neither file can see it alone.
 */
export function findSequenceGaps(sequence: number[]): SequenceGap[] {
  const gaps: SequenceGap[] = [];
  for (let i = 1; i < sequence.length; i++) {
    const afterSeq = sequence[i - 1];
    const beforeSeq = sequence[i];
    if (beforeSeq > afterSeq + 1) gaps.push({ afterSeq, beforeSeq, missing: beforeSeq - afterSeq - 1 });
  }
  return gaps;
}

export interface QuarantineResult {
  quarantined: boolean;
  /** Present when the sidecar could not be written; the source file is untouched either way. */
  error?: string;
  sidecar: string;
}

/**
 * Copy damaged bytes to a sidecar for later forensics. The damaged file itself
 * is never read-modify-written, and a sidecar that cannot be created is reported
 * rather than retried into the event writer.
 */
export function quarantineDamage(path: string, damaged: DamagedLine[], source = path): QuarantineResult {
  const sidecar = path + '.corrupt';
  if (damaged.length === 0) return { quarantined: false, sidecar };

  let alreadyHeld: Set<string>;
  try {
    alreadyHeld = existingEvidence(sidecar);
  } catch (error) {
    return { quarantined: false, error: describe(error), sidecar };
  }

  const pending = damaged.filter(line => !alreadyHeld.has(evidenceKey(source, line.raw)));
  if (pending.length === 0) return { quarantined: true, sidecar };

  for (const line of pending) {
    try {
      appendLineAtomic(sidecar, JSON.stringify({
        quarantinedAt: new Date().toISOString(),
        source,
        lineNumber: line.lineNumber,
        bytes: line.bytes,
        reason: line.reason,
        truncatedEvidence: line.truncatedEvidence,
        raw: line.raw,
      }));
    } catch (error) {
      return { quarantined: false, error: describe(error), sidecar };
    }
  }
  return { quarantined: true, sidecar };
}

function existingEvidence(sidecar: string): Set<string> {
  const held = new Set<string>();
  if (!existsSync(sidecar)) return held;
  const raw = readFileSync(sidecar, 'utf8');
  if (raw.length > MAX_QUARANTINE_BYTES) throw new Error(`quarantine sidecar is full (${raw.length} bytes)`);
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as { raw?: unknown; source?: unknown };
      if (typeof entry.raw === 'string' && typeof entry.source === 'string') {
        held.add(evidenceKey(entry.source, entry.raw));
      }
    } catch { /* an unreadable sidecar entry only costs us dedup */ }
  }
  return held;
}

/** Damage is identified by its bytes and which file they came from, so the live
 *  stream and its rotated predecessor are never confused for each other. */
function evidenceKey(source: string, raw: string): string {
  return `${source} ${raw}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
