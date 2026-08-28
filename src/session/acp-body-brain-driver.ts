import type { RuntimeProviderBindings } from '../agent-runtime-transaction.js';
import type { AcpBodyBrainInjectedDriver, AcpBodyBrainDriverLaunchRequest } from './acp-body-brain-provider.js';
import { sanitizeAcpBodyBrainSessionUpdate,
  type AcpBodyBrainNotification, type AcpLifecycleResult, type AcpRestoreRequest } from './acp-body-brain-transport.js';
import { AcpProtocolRuntime, type AcpProtocolRuntimeBindings, type AcpProtocolRuntimeEvent,
  type AcpProtocolRuntimeLaunchContext } from './acp-protocol-runtime.js';

type RuntimePort = Pick<AcpProtocolRuntime, 'pid'|'subscribe'|'start'|'restore'|'prompt'|'cancel'|'close'|'cleanup'>;
type NotificationPayload<T = AcpBodyBrainNotification> = T extends AcpBodyBrainNotification
  ? Omit<T, 'protocolVersion'|'generation'|'transportSeq'|'notificationId'> : never;
export type AcpProtocolRuntimeFactory = (request: Readonly<AcpBodyBrainDriverLaunchRequest>,
  bindings: Readonly<AcpProtocolRuntimeBindings>, stateDir: string) => RuntimePort;

/** Process/protocol driver. Fleet conversation semantics remain solely in the injected outer AcpSession. */
export function createAcpBodyBrainDriver(stateDir: string,
  runtimeBindings: Readonly<RuntimeProviderBindings & { providerRuntimeId: string }>,
  launchContext: Readonly<AcpProtocolRuntimeLaunchContext>,
  makeRuntime: AcpProtocolRuntimeFactory = (request, bindings, root) =>
    new AcpProtocolRuntime(request.launch, bindings, root, launchContext)): AcpBodyBrainInjectedDriver & { pid(): number } {
  let listener: ((notification: unknown) => void) | undefined; let runtime: RuntimePort | undefined;
  let generation = ''; let seq = 0; let terminal = false;
  const permissions = new Map<string, Extract<AcpProtocolRuntimeEvent, { kind: 'permission' }>>();
  const emit = (value: NotificationPayload) => {
    if (terminal) return;
    if (value.kind === 'failed' || value.kind === 'exited') {
      terminal = true;
      for (const pending of permissions.values()) pending.reject();
      permissions.clear();
    }
    listener?.(Object.freeze({ protocolVersion: 1, generation, transportSeq: ++seq,
      notificationId: `driver-${seq}`, ...value }));
  };
  const bind = (event: AcpProtocolRuntimeEvent): void => {
    if (event.kind === 'update') {
      const update = sanitizeAcpBodyBrainSessionUpdate(event.update);
      if (update) emit({ kind: 'session_update', update });
      else emit({ kind: 'failed', code: 'protocol_error' });
    }
    else if (event.kind === 'permission') { const prior = permissions.get(event.permissionId);
      if (prior) { prior.reject(); event.reject(); permissions.delete(event.permissionId);
        emit({ kind: 'failed', code: 'protocol_error' }); return; }
      permissions.set(event.permissionId, event);
      emit({ kind: 'permission_requested', promptId: 'active-prompt', permissionId: event.permissionId,
        optionIds: event.optionIds }); }
    else if (event.kind === 'exit') emit({ kind: 'exited', code: event.code });
  };
  const launch = async (request: Readonly<AcpBodyBrainDriverLaunchRequest>, restore: boolean): Promise<AcpLifecycleResult> => {
    if (runtime || terminal) return { state: 'failed', code: 'already_started' };
    generation = request.lifecycle.generation;
    const bindings: AcpProtocolRuntimeBindings = Object.freeze({ agentId: runtimeBindings.agentId,
      generation: runtimeBindings.generation, runtimeInstanceKey: runtimeBindings.runtimeInstanceKey,
      providerRuntimeId: runtimeBindings.providerRuntimeId, adapterId: request.launch.adapterId,
      adapterVersion: request.launch.adapterVersion, adapterArtifactDigest: runtimeBindings.adapterDescriptorDigest,
      planDigest: runtimeBindings.planDigest });
    runtime = makeRuntime(request, bindings, stateDir); runtime.subscribe(bind);
    try { return { state: 'accepted', sessionMetadata: restore
      ? await runtime.restore((request.lifecycle as AcpRestoreRequest).sessionMetadata)
      : await runtime.start() }; }
    catch { await runtime.cleanup(); runtime = undefined; return { state: 'failed', code: 'adapter_rejected' }; }
  };
  return {
    pid: () => runtime?.pid ?? 2_147_483_647,
    subscribe(next) { if (listener) throw new TypeError('driver listener unavailable'); listener = next;
      return () => { if (listener === next) listener = undefined; }; },
    start: request => launch(request, false), restore: request => launch(request, true),
    async submit(request, body) {
      if (!runtime || request.generation !== generation || terminal) return { state: 'failed', code: 'generation_changed' };
      const text = new TextDecoder().decode(body);
      void runtime.prompt(text).then(result => emit({ kind: 'completed', promptId: request.promptId,
        outcome: result.stopReason === 'refusal' ? 'refused' : result.stopReason === 'cancelled' ? 'cancelled' : 'completed' }))
        .catch(() => emit({ kind: 'failed', promptId: request.promptId, code: 'adapter_error' }));
      return { state: 'accepted' };
    },
    async respondPermission(request) { const pending = permissions.get(request.permissionId);
      if (!pending || !pending.optionIds.includes(request.optionId)) return { state: 'failed', code: 'adapter_rejected' };
      permissions.delete(request.permissionId); pending.settle(request.optionId); return { state: 'accepted' }; },
    async cancel() { if (!runtime || terminal) return { state: 'failed', code: 'closed' };
      try { await runtime.cancel(); return { state: 'accepted' }; } catch { return { state: 'failed', code: 'adapter_unavailable' }; } },
    async forceTerminate() { if (!runtime || terminal) return { state: 'failed', code: 'closed' };
      await runtime.close(true); emit({ kind: 'exited', code: 'forced' }); return { state: 'accepted' }; },
    async close() { if (!runtime || terminal) return { state: 'failed', code: 'closed' };
      await runtime.close(); emit({ kind: 'exited', code: 'clean_exit' }); return { state: 'accepted' }; },
    async retire() { if (!runtime || terminal) return { state: 'failed', code: 'closed' };
      await runtime.close(); emit({ kind: 'exited', code: 'clean_exit' }); return { state: 'accepted' }; },
    async cleanup() { for (const pending of permissions.values()) pending.reject(); permissions.clear();
      await runtime?.cleanup(); runtime = undefined; listener = undefined; terminal = true; },
  };
}
