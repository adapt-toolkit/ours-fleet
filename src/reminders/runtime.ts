import { ReminderManager, type ReminderAdmitter, type ReminderManagerDeps } from './manager.js';
import { ReminderStore, type ReminderOwner } from './store.js';
import type { ReminderToolBackend } from './tools.js';

export interface RoleReminderBinding {
  role: string;
  stateDir: string;
  /** The managed runtime's own record; nothing here comes from the agent. */
  runtime: { instance?: string; cid?: string; action?: string; lifetime?: 'permanent' | 'temporary' };
  /** Whether this session backend accepts supervisor-submitted prompts. */
  promptInput: boolean;
  admitter: ReminderAdmitter;
  service: { setReminders?(backend: ReminderToolBackend | undefined): void };
  deps: ReminderManagerDeps;
}

/**
 * Bind self-reminders for one runner attempt: load the store for exactly this
 * runtime instance and identity, expose it behind the agent's own MCP tools,
 * and return the (not yet started) dispatcher. Any doubt leaves reminders
 * unavailable rather than guessing an owner.
 */
export function bindRoleReminders(binding: RoleReminderBinding): ReminderManager | undefined {
  const { role, runtime, deps } = binding;
  if (!binding.promptInput || !binding.service.setReminders) return undefined;
  if (!runtime.instance || !runtime.action || !/^[A-Fa-f0-9]{64}$/.test(runtime.cid ?? '')
      || (runtime.lifetime !== 'permanent' && runtime.lifetime !== 'temporary')) {
    deps.log(`[${role}] self-reminders unavailable: managed runtime identity is not established`);
    return undefined;
  }
  const owner: ReminderOwner = {
    role, lifetime: runtime.lifetime, instance: runtime.instance, cid: runtime.cid!, action: runtime.action,
  };
  let store: ReminderStore;
  try { store = new ReminderStore(binding.stateDir, owner, deps.now, deps.log); }
  catch (error) {
    deps.log(`[${role}] self-reminders unavailable: state could not be opened (${(error as Error)?.name ?? 'Error'})`);
    return undefined;
  }
  const manager = new ReminderManager(role, store, binding.admitter, deps);
  binding.service.setReminders({ store, changed: () => manager.changed() });
  return manager;
}
