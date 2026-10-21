import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type Phase =
  | 'PREPARING'
  | 'OWNED'
  | 'ROOM_PENDING'
  | 'READY'
  | 'SERVING'
  | 'RECOVERING'
  | 'QUIESCING'
  | 'TERMINAL_INTENT'
  | 'RELEASED'
  | 'FAILED'
  | 'CLEANUP_PENDING';
export interface RuntimeState {
  version: 1;
  instance: string;
  generation: number;
  daemon: string;
  name: string;
  cid?: string;
  lifetime: 'permanent' | 'temporary';
  action: string;
  phase: Phase;
  revision: number;
  updatedAt: string;
  admissionIntent?: { id: string; cid: string; seat: string; action: string; agentCid: string };
  releaseAck?: {
    released: string[];
    closed: string[];
    attempted: number;
    notified: number;
    failed: number;
  };
  room?: { id: string; cid: string; seat: string; agentCid: string; action: string };
}
const phases: Phase[] = [
  'PREPARING',
  'OWNED',
  'ROOM_PENDING',
  'READY',
  'SERVING',
  'RECOVERING',
  'QUIESCING',
  'TERMINAL_INTENT',
  'RELEASED',
  'FAILED',
  'CLEANUP_PENDING',
];
export function atomicPrivateWrite(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const parent = openSync(join(path, '..'), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function binderKey(daemon: string, identity: string): string {
  return createHash('sha256')
    .update(JSON.stringify([daemon, identity]))
    .digest('hex');
}
/** Supervisor-owned durable state; retained across harness reconnects. */
export class RuntimeJournal {
  readonly path: string;
  constructor(readonly privateDir: string) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    this.path = join(privateDir, 'state.json');
  }
  read(): RuntimeState | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const s = JSON.parse(raw) as RuntimeState;
    if (
      s.version !== 1 ||
      !s.instance ||
      !s.daemon ||
      !s.name ||
      !s.action ||
      !phases.includes(s.phase) ||
      !Number.isSafeInteger(s.generation) ||
      s.generation < 1 ||
      !Number.isSafeInteger(s.revision) ||
      !['permanent', 'temporary'].includes(s.lifetime)
    )
      throw Error('CORRUPT_RUNTIME_JOURNAL');
    return s;
  }
  commit(next: RuntimeState, expectedRevision?: number): void {
    const current = this.read();
    if (current?.revision !== expectedRevision) throw Error('STALE_RUNTIME_REVISION');
    if (
      current &&
      (current.instance !== next.instance ||
        current.daemon !== next.daemon ||
        current.name !== next.name ||
        current.lifetime !== next.lifetime ||
        next.generation < current.generation)
    )
      throw Error('RUNTIME_IDENTITY_MISMATCH');
    if (
      current &&
      ['TERMINAL_INTENT', 'CLEANUP_PENDING', 'RELEASED'].includes(current.phase) &&
      !['TERMINAL_INTENT', 'CLEANUP_PENDING', 'RELEASED'].includes(next.phase)
    )
      throw Error('RETIRED_RUNTIME');
    atomicPrivateWrite(this.path, {
      ...next,
      revision: (expectedRevision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    });
  }
}
