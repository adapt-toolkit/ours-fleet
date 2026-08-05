export interface PresentableFleetItem {
  role: { id: string; config?: { mission?: string } };
  status: {
    overall: string;
    supervisor: { liveness: string };
    session: { reachability: string };
    problems?: Array<{ source?: string }>;
  };
}

export function isInactive(item: PresentableFleetItem): boolean {
  return item.status.overall === 'offline'
    || (item.status.supervisor.liveness === 'stopped'
      && item.status.session.reachability !== 'online');
}

export function needsAttention(item: PresentableFleetItem): boolean {
  return !isInactive(item) && ['attention', 'unknown'].includes(item.status.overall);
}

function hasWatchdogFinding(item: PresentableFleetItem): boolean {
  return (item.status.problems ?? []).some(problem => problem.source === 'watchdog');
}

/**
 * The names of the agents the graph draws, taken from the graph itself.
 *
 * This is what keeps the two surfaces honest about the same collection: the
 * table below the graph does not re-derive who is in the fleet from a rule that
 * merely resembles the server's — it asks the graph. Sketches are excluded
 * because a sketch is not a role yet, and the role list only lists roles.
 */
export function fleetAgents(
  topology: { nodes: Array<{ kind: string; label: string; origin?: string }> },
): Set<string> {
  return new Set(topology.nodes
    .filter(node => node.kind === 'agent' && node.origin !== 'draft')
    .map(node => node.label));
}

/**
 * Whether the inventory carries this role only because a state directory
 * outlived it: it is not in the fleet the graph draws.
 */
export function isPastAgent(item: PresentableFleetItem, fleet: Set<string>): boolean {
  return !fleet.has(item.role.id);
}

export interface PresentOptions {
  filter: string;
  /** The agents the graph draws — see `fleetAgents`. */
  fleet: Set<string>;
  /** Also list the inventory entries the fleet no longer contains. */
  showPast: boolean;
  attentionOnly: boolean;
}

export function presentFleet<T extends PresentableFleetItem>(
  items: T[], options: PresentOptions,
): T[] {
  const filter = options.filter.toLowerCase();
  return items.filter(item => {
    if (isPastAgent(item, options.fleet) && !options.showPast) return false;
    if (options.attentionOnly && !needsAttention(item)) return false;
    const watchdogTag = hasWatchdogFinding(item) ? ' watchdog' : '';
    return `${item.role.id} ${item.role.config?.mission ?? ''} ${item.status.overall}${watchdogTag}`
      .toLowerCase().includes(filter);
  }).sort((a, b) => Number(!needsAttention(a)) - Number(!needsAttention(b))
    || a.role.id.localeCompare(b.role.id));
}
