import { createHash } from 'node:crypto';
import {
  AcpBodyBrainTransportBoundary,
  type AcpBodyBrainDelivery, type AcpBodyBrainProvider, type AcpBodyReference,
  type AcpBodySource, type AcpGenerationRequest, type AcpPermissionRequest,
  type AcpRestoreRequest, type AcpStartRequest, type AcpSubmitRequest,
} from './session/acp-body-brain-transport.js';

const endpointBrand: unique symbol = Symbol('AgentConversationEndpoint');
export interface AgentConversationEndpoint { readonly [endpointBrand]: true }
export interface AuthenticatedAgentConversationEndpoint {
  readonly agentId: string; readonly generation: number; readonly runtimeInstanceKey: string;
  readonly providerRuntimeId: string; readonly pid: number;
  subscribe(listener: (delivery: AcpBodyBrainDelivery) => void): () => void;
  submit(request: Omit<AcpSubmitRequest, 'body'>, body: Uint8Array): ReturnType<AcpBodyBrainTransportBoundary['submit']>;
  respondPermission(request: AcpPermissionRequest): ReturnType<AcpBodyBrainTransportBoundary['respondPermission']>;
  cancel(request: AcpGenerationRequest): ReturnType<AcpBodyBrainTransportBoundary['cancel']>;
  forceTerminate(request: AcpGenerationRequest): ReturnType<AcpBodyBrainTransportBoundary['forceTerminate']>;
  close(request: AcpGenerationRequest): ReturnType<AcpBodyBrainTransportBoundary['close']>;
}
export interface AgentConversationEndpointAuthority {
  authenticate(value: AgentConversationEndpoint): AuthenticatedAgentConversationEndpoint | undefined;
}
const MAX_BUFFERED_DELIVERIES = 1024;
class OwnedBodies implements AcpBodySource {
  readonly #bodies = new Map<string, Uint8Array>();
  put(body: Uint8Array): AcpBodyReference { const owned = Uint8Array.from(body);
    const digest = `sha256:${createHash('sha256').update(owned).digest('hex')}`;
    this.#bodies.set(digest, owned); return Object.freeze({ digest, bytes: owned.byteLength }); }
  async resolve(reference: Readonly<AcpBodyReference>): Promise<Uint8Array> { const body = this.#bodies.get(reference.digest);
    if (!body || body.byteLength !== reference.bytes) throw new TypeError('conversation body unavailable');
    this.#bodies.delete(reference.digest); return Uint8Array.from(body); }
  clear(): void { for (const body of this.#bodies.values()) body.fill(0); this.#bodies.clear(); }
}

/** Internal one-subscription relay. Only validated TransportBoundary deliveries enter its buffer. */
export class AgentConversationRelay implements AgentConversationEndpointAuthority {
  readonly #bodies = new OwnedBodies(); readonly #transport: AcpBodyBrainTransportBoundary;
  readonly #issued = new WeakMap<object, AuthenticatedAgentConversationEndpoint>();
  readonly #buffer: AcpBodyBrainDelivery[] = []; #listener?: (delivery: AcpBodyBrainDelivery) => void;
  #claimed = false; #failed = false;
  constructor(readonly bindings: Readonly<{ agentId: string; generation: number; runtimeInstanceKey: string;
    providerRuntimeId: string }>, adapterId: string, provider: AcpBodyBrainProvider,
  private readonly processId: () => number = () => 2_147_483_647) {
    this.#transport = new AcpBodyBrainTransportBoundary(adapterId, provider, this.#bodies);
    if (!this.#transport.subscribe(delivery => this.#receive(delivery)))
      throw new TypeError('conversation transport subscription unavailable');
  }
  start(request: Readonly<AcpStartRequest>) { return this.#transport.start(request); }
  restore(request: Readonly<AcpRestoreRequest>) { return this.#transport.restore(request); }
  issue(): AgentConversationEndpoint {
    if (this.#failed || this.#claimed) throw new TypeError('conversation endpoint unavailable');
    const endpoint = Object.freeze({ [endpointBrand]: true as const });
    const pid = this.processId();
    if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) throw new TypeError('conversation pid unavailable');
    const authenticated: AuthenticatedAgentConversationEndpoint = Object.freeze({ ...this.bindings, pid,
      subscribe: (listener: (delivery: AcpBodyBrainDelivery) => void) => this.#claim(listener),
      submit: (request: Omit<AcpSubmitRequest, 'body'>, body: Uint8Array) =>
        this.#transport.submit(Object.freeze({ ...request, body: this.#bodies.put(body) })),
      respondPermission: (request: AcpPermissionRequest) => this.#transport.respondPermission(request),
      cancel: (request: AcpGenerationRequest) => this.#transport.cancel(request),
      forceTerminate: (request: AcpGenerationRequest) => this.#transport.forceTerminate(request),
      close: (request: AcpGenerationRequest) => this.#transport.close(request),
    }); this.#issued.set(endpoint, authenticated); return endpoint;
  }
  authenticate(value: AgentConversationEndpoint) { return this.#issued.get(value as object); }
  #receive(delivery: AcpBodyBrainDelivery): void { if (this.#failed) return;
    if (delivery.state === 'failed') { const listener = this.#listener;
      if (listener) try { listener(delivery); } catch { /* cleanup below */ }
      this.#fail(); return; }
    const terminal = delivery.notification.kind === 'exited' || delivery.notification.kind === 'failed';
    const listener = this.#listener;
    if (listener) { try { listener(delivery); } catch { this.#fail(); } return; }
    if (terminal || this.#buffer.length >= MAX_BUFFERED_DELIVERIES) { this.#fail(); return; }
    this.#buffer.push(delivery); }
  #claim(listener: (delivery: AcpBodyBrainDelivery) => void): () => void {
    if (typeof listener !== 'function' || this.#claimed || this.#failed) throw new TypeError('conversation endpoint unavailable');
    this.#claimed = true; this.#listener = listener; const prefix = this.#buffer.splice(0);
    try { for (const delivery of prefix) listener(delivery); }
    catch { this.#fail(); throw new TypeError('conversation endpoint unavailable'); }
    let owned = true; return () => { if (!owned) return; owned = false;
      if (this.#listener === listener) this.#listener = undefined; };
  }
  async cleanup(): Promise<void> { this.#failed = true; this.#listener = undefined; this.#buffer.length = 0;
    this.#bodies.clear(); await this.#transport.cleanup(); }
  #fail(): void { if (this.#failed) return; this.#failed = true; this.#listener = undefined;
    this.#buffer.length = 0; void this.cleanup(); }
}
