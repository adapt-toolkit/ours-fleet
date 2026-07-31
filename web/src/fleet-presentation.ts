export interface PresentableFleetItem {
  role: { id: string; config?: { mission?: string } };
  status: {
    overall: string;
    supervisor: { liveness: string };
    session: { reachability: string };
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

export function presentFleet<T extends PresentableFleetItem>(
  items: T[], options: { filter: string; showInactive: boolean; attentionOnly: boolean },
): T[] {
  const filter = options.filter.toLowerCase();
  return items.filter(item => {
    if (isInactive(item) && !options.showInactive) return false;
    if (options.attentionOnly && !needsAttention(item)) return false;
    return `${item.role.id} ${item.role.config?.mission ?? ''} ${item.status.overall}`
      .toLowerCase().includes(filter);
  }).sort((a, b) => Number(!needsAttention(a)) - Number(!needsAttention(b))
    || a.role.id.localeCompare(b.role.id));
}
