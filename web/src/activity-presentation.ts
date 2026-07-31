export interface ActivityEvent {
  kind: string;
  seq?: number;
  text?: string;
}

export type PresentedActivityEvent<T extends ActivityEvent> = T & { lastSeq?: number };

/** Keep low-level streaming telemetry available without letting it bury agent activity. */
export function partitionActivity<T extends ActivityEvent>(events: T[] = []): {
  meaningful: Array<PresentedActivityEvent<T>>; technical: T[];
} {
  const technical: T[] = [];
  const meaningful: Array<PresentedActivityEvent<T>> = [];
  let canAppendAgentText = false;
  for (const event of events) {
    if (event.kind === 'tool_update' || event.kind === 'thought') {
      technical.push(event);
      canAppendAgentText = false;
      continue;
    }
    const previous = meaningful.at(-1);
    if (event.kind === 'agent_text' && canAppendAgentText && previous?.kind === 'agent_text') {
      previous.text = `${previous.text ?? ''}${event.text ?? ''}`;
      previous.lastSeq = event.seq;
      continue;
    }
    meaningful.push({ ...event });
    canAppendAgentText = event.kind === 'agent_text';
  }
  return { meaningful, technical };
}
