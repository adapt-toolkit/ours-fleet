import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { acquireOwnerBinderLease, type OwnerBinderLease } from '../owner-channel/binder.js';
import { binderKey, RuntimeJournal } from './state.js';

/** Reuse Fleet's process-lifetime binder to serialize startup and cleanup. */
export class RuntimeController {
  readonly journal: RuntimeJournal;
  private active = true;
  private constructor(
    private readonly lease: OwnerBinderLease,
    readonly privateDir: string,
  ) {
    this.journal = new RuntimeJournal(privateDir);
  }
  static async acquire(
    root: string,
    daemon: string,
    name: string,
    instance: string,
  ): Promise<RuntimeController> {
    const dir = join(root, binderKey(daemon, name));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lease = await acquireOwnerBinderLease(dir, 'agent-ours', name);
    const controller = new RuntimeController(lease, dir);
    if (controller.journal.read()?.instance && controller.journal.read()!.instance !== instance) {
      lease.release();
      throw Error('RUNTIME_INSTANCE_MISMATCH');
    }
    return controller;
  }
  assertFence = (): void => {
    if (!this.active) throw Error('STALE_RUNTIME_CONTROLLER');
  };
  successor(): string {
    this.assertFence();
    const state = this.journal.read();
    if (state?.phase !== 'RELEASED') throw Error('PREDECESSOR_NOT_RELEASED');
    const archive = join(this.privateDir, `retired-${state.instance}`);
    mkdirSync(archive, { mode: 0o700 });
    for (const file of ['state.json', 'owner.json', 'instance.json'])
      renameSync(join(this.privateDir, file), join(archive, file));
    return randomUUID();
  }
  resumeGeneration(): number {
    this.assertFence();
    const s = this.journal.read();
    if (!s) return 1;
    if (['TERMINAL_INTENT', 'CLEANUP_PENDING', 'RELEASED', 'FAILED'].includes(s.phase))
      throw Error('RUNTIME_RETIRED_OR_FAILED');
    if (!s.cid) throw Error('UNCERTAIN_PROVISIONING');
    this.journal.commit({ ...s, generation: s.generation + 1, phase: 'RECOVERING' }, s.revision);
    return s.generation + 1;
  }
  unlock(): void {
    this.assertFence();
    this.lease.release();
    this.active = false;
  }
}
