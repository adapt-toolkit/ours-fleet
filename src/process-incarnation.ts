import { readFileSync } from 'node:fs';

/**
 * Which run of a process a PID names. A PID alone is not an identity: after a
 * reboot or wraparound the same number belongs to an unrelated process, and a
 * lock or claim keyed on it would then look held forever. The kernel boot id
 * and the process start time (in clock ticks since boot) pin one incarnation.
 * Both are Linux-only; elsewhere they are absent and callers stay PID-only.
 */
export interface ProcessIncarnation {
  boot?: string;
  start?: string;
}

export interface IncarnationProbe {
  bootId(): string | undefined;
  startTime(pid: number): string | undefined;
}

export const procIncarnationProbe: IncarnationProbe = {
  bootId() {
    try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; }
    catch { return undefined; }
  },
  startTime(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19] || undefined;
    } catch { return undefined; }
  },
};

export function processIncarnation(pid: number, probe: IncarnationProbe = procIncarnationProbe): ProcessIncarnation {
  const boot = probe.bootId(), start = probe.startTime(pid);
  return { ...(boot ? { boot } : {}), ...(start ? { start } : {}) };
}

/**
 * True only when a recorded marker positively proves the live PID is a later
 * process: a different boot, or a different start time. A marker that was not
 * recorded, or cannot be read now, proves nothing and keeps the PID check.
 */
export function incarnationEnded(pid: number, recorded: ProcessIncarnation,
  probe: IncarnationProbe = procIncarnationProbe): boolean {
  if (typeof recorded.boot === 'string') {
    const boot = probe.bootId();
    if (boot && boot !== recorded.boot) return true;
  }
  if (typeof recorded.start === 'string') {
    const start = probe.startTime(pid);
    if (start && start !== recorded.start) return true;
  }
  return false;
}
