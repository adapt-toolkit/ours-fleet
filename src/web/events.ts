import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

export interface FleetEvent {
  eventId: string;
  at: string;
  roleId?: string;
  kind: string;
  payload: unknown;
}

export class FleetEventBus {
  private readonly events: FleetEvent[] = [];
  private readonly clients = new Set<WebSocket>();
  publish(kind: string, payload: unknown, roleId?: string): FleetEvent {
    const event = { eventId: randomUUID(), at: new Date().toISOString(), roleId, kind, payload };
    this.events.push(event);
    if (this.events.length > 5_000) this.events.shift();
    const frame = JSON.stringify(event);
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN && socket.bufferedAmount < 1024 * 1024) socket.send(frame);
    }
    return event;
  }
  attach(socket: WebSocket, lastEventId?: string): () => void {
    this.clients.add(socket);
    if (lastEventId) {
      const index = this.events.findIndex(event => event.eventId === lastEventId);
      if (index < 0) socket.send(JSON.stringify({ kind: 'resync.required', at: new Date().toISOString() }));
      else for (const event of this.events.slice(index + 1)) socket.send(JSON.stringify(event));
    }
    return () => this.clients.delete(socket);
  }
  close(): void {
    for (const socket of this.clients) socket.close(1001, 'server shutdown');
    this.clients.clear();
  }
}
