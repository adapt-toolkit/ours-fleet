import { access, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPrivateOursFixture } from './fixtures/hermes-acp/ours-fixture.js';
import { makeHermesAdapter } from '../src/harness/hermes.js';
import type { ResolvedRole } from '../src/config.js';
import type { AgentSession } from '../src/session/types.js';
import YAML from 'yaml';
import { createNativeHermesFixture } from './fixtures/hermes-acp/native-fixture.js';

const enabled = process.env.HERMES_ACP_INTEGRATION === '1'
  || process.env.HERMES_ACP_INTEGRATION_REQUIRED === '1';

describe.skipIf(!enabled)('installed Hermes ACP conformance (basic native contract)', () => {
  it('uses the native selected model on fresh starts and retains home data', async () => {
    const fixture = await createNativeHermesFixture();
    try {
      const first = await fixture.start('fleet-fixture-a');
      expect(first.initialize.agentInfo).toMatchObject({ name: 'hermes-agent', version: '0.21.1' });
      expect(first.initialize.protocolVersion).toBe(1);
      expect(first.session.models.currentModelId).toBe('custom:fleet-fixture-a');
      expect(first.session.modes.availableModes.map((mode: { id: string }) => mode.id))
        .toEqual(['default', 'accept_edits', 'dont_ask']);
      await first.rpc('session/set_mode', { sessionId: first.session.sessionId, modeId: 'default' });
      await first.prompt('Reply with the fixture response.');
      expect(first.output()).toContain('fixture reply');
      expect(fixture.inferenceModels()).toEqual(['fleet-fixture-a']);
      await fixture.writeRetainedMarker();
      await first.stop();
      const second = await fixture.start('fleet-fixture-b');
      expect(second.session.sessionId).not.toBe(first.session.sessionId);
      expect(second.session.models.currentModelId).toBe('custom:fleet-fixture-b');
      expect(await fixture.readRetainedMarker()).toBe('retained across fresh sessions');
      await second.prompt('Reply with the fixture response.');
      expect(fixture.inferenceModels()).toEqual(['fleet-fixture-a', 'fleet-fixture-b']);
      expect(await fixture.nativeProvider()).toBe('custom');
    } finally { await fixture.close(); }
  }, 60_000);

  it('cancels a pending real provider stream without restoring a previous session', async () => {
    const fixture = await createNativeHermesFixture();
    try {
      const child = await fixture.start('fleet-fixture-cancel');
      fixture.holdNextInference();
      const prompt = child.prompt('Wait for the deterministic fixture.');
      await fixture.waitForHeldInference();
      child.notify('session/cancel', { sessionId: child.session.sessionId });
      fixture.releaseHeldInference();
      expect(await prompt).toMatchObject({ stopReason: 'cancelled' });
    } finally { await fixture.close(); }
  }, 60_000);
  it('denies and approves dangerous terminal commands through native ACP permissions', async () => {
    const fixture = await createNativeHermesFixture();
    try {
      const child = await fixture.start('fleet-fixture-permissions');
      const target = join(fixture.cwd, 'permission-target');
      const marker = join(fixture.cwd, 'permission-ran');
      await writeFile(target, 'fixture');
      const command = `chmod -R 777 '${target}' && printf approved > '${marker}'`;
      child.setPermissionAnswer('deny');
      fixture.callTerminalNext(command);
      await child.prompt('Run the fixture terminal operation.');
      expect(child.permissionRequests()).toHaveLength(1);
      await expect(access(marker)).rejects.toThrow();
      child.setPermissionAnswer('allow_once');
      fixture.callTerminalNext(command);
      await child.prompt('Run the fixture terminal operation with approval.');
      expect(child.permissionRequests()).toHaveLength(2);
      await expect(access(marker)).resolves.toBeUndefined();
      expect(child.toolOutput()).toContain('denied');
    } finally { await fixture.close(); }
  }, 90_000);

  it('expires native permission requests and ignores a late approval', async () => {
    const fixture = await createNativeHermesFixture();
    try {
      const child = await fixture.start('fleet-fixture-expiry');
      const target = join(fixture.cwd, 'expiry-target');
      const marker = join(fixture.cwd, 'expired-operation-ran');
      await writeFile(target, 'fixture');
      fixture.callTerminalNext(`chmod -R 777 '${target}' && printf late > '${marker}'`);
      const started = Date.now();
      await child.prompt('Run the fixture operation requiring approval.');
      expect(Date.now() - started).toBeGreaterThanOrEqual(59_000);
      expect(child.permissionRequests()).toHaveLength(1);
      await expect(access(marker)).rejects.toThrow();
      expect(child.toolOutput()).toContain('timed out');
      child.answerPermission(child.permissionRequests()[0].id, 'allow_once');
      await child.prompt('Reply after the expired operation.');
      await expect(access(marker)).rejects.toThrow();
      expect(child.permissionRequests()).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 100_000);

  it('runs actual Fleet adapter preparation and transport with authoritative Brain models', async () => {
    const fixture = await createNativeHermesFixture();
    let session: AgentSession | undefined;
    try {
      const adapter = makeHermesAdapter();
      const stateDir = join(fixture.root, 'managed-role');
      const home = join(stateDir, 'harness/hermes');
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(join(home, 'config.yaml'), JSON.stringify({
        model: { default: 'old-native-model', provider: 'custom', base_url: fixture.providerUrl, api_key: 'fixture-dummy', context_length: 131072 },
        compression: { enabled: false }, plugins: { enabled: [] },
      }), { mode: 0o600 });
      const logs: string[] = [];
      for (const model of ['fleet-adapter-a', 'fleet-adapter-b']) {
        const role = { name: 'Fixture', identity: 'Fixture', harness: 'hermes', session: 'acp', model,
          permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' }, monitor: { mode: 'fleet' },
          env: { HOME: fixture.userHome, PATH: '/usr/local/bin:/usr/bin:/bin' },
          session_options: { acp: { command: [fixture.executable] } }, permissionsDeclared: true, sourceFile: 'native-fixture',
        } as unknown as ResolvedRole;
        const prep = await adapter.prepareSession(role, { stateDir, runCwd: fixture.cwd });
        const launch = adapter.agentSession!.prepareLaunch(role, prep);
        session = await adapter.agentSession!.start({ role, prep, launch, cwd: fixture.cwd, stateDir,
          mode: 'resume', permissions: role.permissions,
          permissionMode: { fleetMode: 'ask', nativeMode: 'default' }, log: line => logs.push(line),
        });
        const result = await session.submitPrompt('Reply with the fixture response.');
        expect(result).toMatchObject({ accepted: true, outcome: 'completed', succeeded: true });
        await session.close(); session = undefined;
        const native = YAML.parse(await readFile(join(home, 'config.yaml'), 'utf8'));
        expect(native.model.default).toBe(model);
        expect(native.model.provider).toBe('custom');
        expect(native.model.api_key).toBe('fixture-dummy');
      }
      expect(fixture.inferenceModels()).toEqual(['fleet-adapter-a', 'fleet-adapter-b']);
      expect(logs.join('\n')).toContain('MCP availability unverified');
    } finally { await session?.close(); await fixture.close(); }
  }, 90_000);

  it('invokes real ours MCP and delivers to the authenticated local fixture Owner', async () => {
    const fixture = await createNativeHermesFixture();
    let ours: Awaited<ReturnType<typeof createPrivateOursFixture>> | undefined;
    try {
      ours = await createPrivateOursFixture();
      const child = await fixture.start('fleet-fixture-ours', undefined, [ours.declaration]);
      fixture.callToolNext('tool_call', { name: 'mcp__ours__current_identity', arguments: {} });
      await child.prompt('Check your fixture identity.');
      expect(fixture.toolResults(), child.diagnostics()).toContain('FixtureAgent');
      expect(child.toolStarts()).toContain('mcp__ours__current_identity');
      fixture.callToolNext('tool_call', { name: 'mcp__ours__send_message', arguments: { contact: 'FixtureOwner', text: 'Hermes local conformance reply' } });
      await child.prompt('Send the fixture-only reply to the fixture Owner.');
      const received = await ours.owner.getMessages({ limit: 10 });
      expect(received.messages).toHaveLength(1);
      expect(received.messages[0]).toMatchObject({ text: 'Hermes local conformance reply', from: { id: ours.agentCid } });
      expect(child.toolStarts()).toContain('mcp__ours__send_message');
    } finally { await fixture.close(); await ours?.close(); }
  }, 90_000);

  it('connects with failing ours registration but exposes failure on actual first use', async () => {
    const fixture = await createNativeHermesFixture();
    try {
      const child = await fixture.start('fleet-fixture-missing-ours', undefined, [
        { name: 'ours', command: join(fixture.root, 'missing-ours-mcp'), args: [], env: [] },
      ]);
      expect(child.session.sessionId).toBeTruthy();
      fixture.callToolNext('tool_call', { name: 'mcp__ours__current_identity', arguments: {} });
      await child.prompt('Check the fixture connector on first use.');
      expect(child.toolOutput()).toContain('not a deferrable tool');
      expect(fixture.toolResults()).toContain('mcp__ours__current_identity');
      expect(child.toolStarts()).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 60_000);

});
