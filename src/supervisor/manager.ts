import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireOwnerBinderLease } from '../owner-channel/binder.js';
import { stateRoot } from '../paths.js';
import { readRestartLedger, writeRestartLedger, backoffFor, RESTART_FAIL_THRESHOLD } from '../runner.js';
import { realExec, type Exec } from '../exec.js';
import { listMemberKeys, managedMemberEnvironment, memberPath, memberProcess, readMember, withMemberLock, writeMember, type FleetMember } from './catalog.js';

interface ChildState { child: ChildProcess; generation: string; startedAt: number; stoppingAt?: number }
export interface ManagerDeps {
  exec?: Exec;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  shouldStop?(): boolean;
  log?(message: string): void;
  spawnChild?(member: FleetMember, generation: string): ChildProcess;
}
/** One parent owns process creation for every kind of Fleet member. */
export async function runFleetManager(entrypoint: string, deps: ManagerDeps = {}): Promise<void> {
  const lease = await acquireOwnerBinderLease(join(stateRoot(), 'supervisor'), 'fleet-manager', 'fleet-manager');
  const children = new Map<string, ChildState>();
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (message => console.error(message));
  const exec = deps.exec ?? realExec;
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const spawnChild = deps.spawnChild ?? ((member: FleetMember, generation: string) => {
    if (!existsSync(member.dir)) throw Error('Fleet member state missing');
    const fd = openSync(join(member.dir, 'supervisor.log'), 'a', 0o600);
    try {
      return spawn(process.execPath, [entrypoint, '_run-managed', member.key, generation], {
        // A process group permits bounded cleanup of a hung runner and its harness.
        // IPC couples its lifetime to this parent even if the parent is SIGKILLed.
        detached: true, stdio: ['ignore', fd, fd, 'ipc'], env: managedMemberEnvironment(member),
      });
    } finally { closeSync(fd); }
  });
  async function reconcile(key: string): Promise<void> {
    await withMemberLock(key, async () => {
      const member = readMember(key);
      const owned = children.get(key);
      if (!member) {
        if (owned && !owned.stoppingAt) { owned.stoppingAt = Date.now(); owned.child.kill('SIGTERM'); }
        return;
      }
      // Our ChildProcess supplies exit notification for steady owned members.
      // Probe argv only for predecessor discovery or before an actual stop;
      // macOS otherwise spawned one ps process per member every 250ms.
      if (owned && owned.generation === member.generation && member.desired === 'running' && !stopping && !owned.stoppingAt) return;
      const live = await memberProcess(member, exec);
      if (member.desired === 'stopped' || stopping) {
        if (live.state === 'running' && live.pid) {
          if (owned && owned.generation === member.generation) {
            if (!owned.stoppingAt) { owned.stoppingAt = Date.now(); owned.child.kill('SIGTERM'); }
            else if (Date.now() - owned.stoppingAt >= 15_000) {
              // Re-check exact generation immediately before a group signal.
              try { process.kill(-live.pid, 'SIGKILL'); } catch { /* next probe proves absence */ }
            }
          } else {
            // A predecessor's child has lost IPC and is shutting down. Never adopt
            // or launch alongside it; its worker also holds the member lifetime lease.
            log(`[fleet] waiting for predecessor ${key}`);
          }
        }
        return;
      }
      if (live.state !== 'stopped' || owned || (member.retryAt ?? 0) > Date.now() || readRestartLedger(member.dir).circuit === 'open') return;
      const generation = randomUUID();
      writeMember({ ...member, generation, pid: undefined });
      let child: ChildProcess;
      try { child = spawnChild(member, generation); }
      catch {
        if (!existsSync(member.dir)) { writeMember({ ...member, generation: undefined, pid: undefined, retryAt: Date.now() + 30_000 }); return; }
        const ledger = readRestartLedger(member.dir);
        const failures = ledger.consecutiveImmediateFailures + 1;
        writeRestartLedger(member.dir, { ...ledger, consecutiveImmediateFailures: failures, circuit: failures >= RESTART_FAIL_THRESHOLD ? 'open' : 'closed', nextDelayMs: backoffFor(failures), lastReason: 'Fleet child spawn failed', updatedAt: new Date().toISOString() });
        writeMember({ ...member, generation: undefined, pid: undefined, retryAt: Date.now() + backoffFor(failures) });
        return;
      }
      const childState: ChildState = { child, generation, startedAt: now() };
      children.set(key, childState);
      writeMember({ ...member, generation, pid: child.pid });
      let finished = false;
      const finish = (failed: boolean) => {
        if (finished) return;
        finished = true;
        if (children.get(key) === childState) children.delete(key);
        void withMemberLock(key, async () => {
          const current = readMember(key);
          if (!current || current.generation !== generation) return;
          if (current.kind === 'temporary' && !existsSync(current.dir)) {
            rmSync(memberPath(key)); return;
          }
          let taskCompleted = false;
          if (!failed && !stopping && !childState.stoppingAt && current.kind === 'task') {
            try { taskCompleted = !(await import('../task-supervision.js')).taskSupervisorMayRun(current.name); }
            catch { failed = true; } // uncertainty consumes the existing bounded failure budget
          }
          const ledger = readRestartLedger(current.dir);
          let previousFailures = ledger.consecutiveImmediateFailures;
          if (failed && !stopping && !childState.stoppingAt) {
            const { stableSupervisorWindow } = await import('../runner.js');
            if (now() - childState.startedAt >= stableSupervisorWindow(current.name, current.kind !== 'permanent', current.configPath) * 1000)
              previousFailures = 0;
          }
          const failures = failed && !stopping && !childState.stoppingAt ? previousFailures + 1 : ledger.consecutiveImmediateFailures;
          if (failed && !stopping && !childState.stoppingAt && existsSync(current.dir)) writeRestartLedger(current.dir, {
            ...ledger, consecutiveImmediateFailures: failures, lastReason: 'Fleet member runner exited unexpectedly',
            circuit: failures >= RESTART_FAIL_THRESHOLD ? 'open' : 'closed', nextDelayMs: backoffFor(failures),
            updatedAt: new Date().toISOString(), ...(failures >= RESTART_FAIL_THRESHOLD ? { openedAt: new Date().toISOString() } : {}),
          });
          writeMember({ ...current, pid: undefined, generation: undefined,
            retryAt: Date.now() + backoffFor(failures),
            // A completed task/transient worker must not become an endless launch loop.
            desired: !failed && !stopping && !childState.stoppingAt && (current.kind === 'temporary' || taskCompleted) ? 'stopped' : current.desired });
        }).catch(() => log(`[fleet] child completion record unavailable: ${key}`));
      };
      child.once('error', () => finish(true));
      child.once('exit', (code, signal) => {
        // The tracked child created this private process group; reclaim any harness
        // descendants even when the runner itself crashed before cleaning them.
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already absent */ } }
        finish(code !== 0 || signal !== null);
      });
    });
  }
  try {
    try {
      const { resumeFleetTransfers } = await import('./adoption.js');
      await resumeFleetTransfers(entrypoint, exec);
    } catch (error) {
      // Existing catalog members continue; uncertain transfers remain held with
      // their receipts. Operator init/up reports the same actionable failure.
      log(`[fleet] transfer pending: ${error instanceof Error ? error.message : 'proof unavailable'}`);
    }
    while (!stopping && !deps.shouldStop?.()) {
      for (const key of listMemberKeys()) {
        try { await reconcile(key); }
        catch { log(`[fleet] reconciliation held: ${key}`); }
      }
      await sleep(250);
    }
  } finally {
    stopping = true;
    // Shutdown preserves desired intent; the successor resumes the same catalog.
    const deadline = Date.now() + 17_000;
    while (children.size && Date.now() < deadline) {
      for (const key of children.keys()) await reconcile(key);
      await sleep(100);
    }
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    lease.release();
  }
}

/** Workers cannot outlive their parent or overlap another generation of this member. */
export async function runManagedMember(key: string, generation: string): Promise<void> {
  let stopping = false;
  const stop = () => { stopping = true; };
  const disconnected = () => {
    stopping = true;
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 15_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('disconnect', disconnected);
  if (!process.connected) throw Error('FLEET_MEMBER_PARENT_MISSING');
  const lease = await acquireOwnerBinderLease(join(stateRoot(), 'supervisor', 'workers', key), 'fleet-member', key);
  try {
    const member = readMember(key);
    if (!member || member.generation !== generation || member.desired !== 'running' || stopping) return;
    const { runSupervised } = await import('../runner.js');
    if (member.kind === 'permanent') {
      const { waitForRoleDaemon } = await import('../startup-readiness.js');
      // Waiting for a daemon is readiness, not a failed harness attempt.
      while (!stopping) {
        try { await waitForRoleDaemon(member.name, member.configPath); break; }
        catch { if (!stopping) await new Promise(resolve => setTimeout(resolve, 5000)); }
      }
      if (!stopping) await runSupervised(member.name, { configPath: member.configPath }, { shouldStop: () => stopping });
    } else if (member.kind === 'watchdogs') {
      const { runScheduler } = await import('../watchdog/scheduler.js');
      await runScheduler(member.configPath, {
        now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        log: message => console.log(message), binPath: process.argv[1], shouldStop: () => stopping,
      });
    } else {
      const { runTempSupervisor } = await import('../temp-supervisor-recovery.js');
      const { runTemp } = await import('../runner.js');
      await runTempSupervisor(member.name, process.argv[1], () => runTemp(member.name, {
        shouldStop: () => stopping, suspendOnStop: true,
      }), true);
    }
  } finally {
    lease.release();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.off('disconnect', disconnected);
    if (process.connected) process.disconnect();
    else if (stopping) { try { process.kill(-process.pid, 'SIGKILL'); } catch { /* no private group */ } }
  }
}
