import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { expect, it, vi } from 'vitest';

// Exercise the pinned adapter's real v1 router/config handler with Fleet's SDK.
// Only the native query is recorded: no Claude process or inference requests.
it('negotiates ACP v1 and delivers all Fable 5.2 efforts through the updated adapter', async () => {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('@agentclientprotocol/claude-agent-acp/package.json'));
  const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(join(root, 'dist', path)).href);
  const { acpProtocolRouter } = await load('serve.js');
  const { buildConfigOptions } = await load('session-config-options.js');
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const model = 'claude-fable-5-2';
  const models = { currentModelId: model, availableModels: [{ modelId: model, name: 'Claude Fable 5.2' }] };
  const modelInfos = [{ value: model, supportsEffort: true, supportedEffortLevels: efforts }];
  const applyFlagSettings = vi.fn(async () => {});
  const session = {
    modelInfos, models, query: { applyFlagSettings },
    configOptions: buildConfigOptions({ currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      models, modelInfos, undefined),
  };
  const outgoing = new TransformStream<Uint8Array, Uint8Array>();
  const incoming = new TransformStream<Uint8Array, Uint8Array>();
  const client = acp.client({ name: 'ours-fleet' }).connect(acp.ndJsonStream(outgoing.writable, incoming.readable));
  const router = acpProtocolRouter({ log() {}, error() {} }, (agent: any) => {
    agent.authStatus.probe = async () => {}; // No host credentials or CLI probes.
    agent.sessions.fixture = session;
  }).connect(acp.ndJsonStream(incoming.writable, outgoing.readable));
  try {
    const initialized = await client.agent.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    expect(initialized.protocolVersion).toBe(1);
    const option = session.configOptions.find((option: any) => option.id === 'effort');
    expect(option.options.map((entry: any) => entry.value)).toEqual(['default', ...efforts]);
    expect(session.configOptions.find((option: any) => option.id === 'model').currentValue).toBe(model);
    for (const effort of efforts) {
      const response = await client.agent.request(acp.methods.agent.session.setConfigOption,
        { sessionId: 'fixture', configId: 'effort', value: effort });
      expect(response.configOptions.find(option => option.id === 'effort')?.currentValue).toBe(effort);
      expect(applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: effort });
    }
    await expect(client.agent.request(acp.methods.agent.session.setConfigOption,
      { sessionId: 'fixture', configId: 'effort', value: 'ultra' })).rejects.toThrow();
    expect(applyFlagSettings).toHaveBeenCalledTimes(efforts.length);
  } finally {
    client.close();
    void router.closed.catch(() => {});
  }
}, 15_000);
