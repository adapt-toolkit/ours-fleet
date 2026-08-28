import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, constants, fstatSync, ftruncateSync, fsyncSync, lstatSync, openSync, readSync,
  realpathSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { AcpBodyBrainPreparedLaunch } from './acp-body-brain-provider.js';
import type { AcpSessionMetadata } from './acp-body-brain-transport.js';
import { runtimeCanonical, runtimeDigest } from '../agent-runtime-record.js';

const LOCATOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
export interface AcpProtocolRuntimeBindings {
  agentId: string; generation: number; runtimeInstanceKey: string; providerRuntimeId: string;
  adapterId: string; adapterVersion: string; adapterArtifactDigest: string; planDigest: string;
}
export interface AcpProtocolRuntimeLaunchContext { cwd: string; env: Readonly<Record<string, string>> }
export interface AcpProtocolRuntimeSecurityHooks {
  beforeLocatorOpen?(): void;
  afterLocatorReserveOpen?(): void;
}
export type AcpProtocolRuntimeEvent = Readonly<
  | { kind: 'update'; update: unknown }
  | { kind: 'permission'; permissionId: string; optionIds: readonly string[];
      settle(optionId: string): void; reject(): void }
  | { kind: 'exit'; code: 'clean_exit' | 'forced' | 'lost' }
>;

export const acpProtocolMetadataDigest = (locator: string, bindings: AcpProtocolRuntimeBindings): string =>
  runtimeDigest(runtimeCanonical({ locator, agentId: bindings.agentId, generation: bindings.generation,
    runtimeInstanceKey: bindings.runtimeInstanceKey, providerRuntimeId: bindings.providerRuntimeId,
    adapterId: bindings.adapterId, adapterVersion: bindings.adapterVersion,
    adapterArtifactDigest: bindings.adapterArtifactDigest, planDigest: bindings.planDigest }));

/** Low-level child/protocol/session-id owner. It never opens Fleet semantic event or conversation stores. */
export class AcpProtocolRuntime {
  readonly #sessionFile: string;
  readonly #listeners = new Set<(event: AcpProtocolRuntimeEvent) => void>();
  #child?: ChildProcessWithoutNullStreams; #connection?: acp.ClientConnection; #sessionId?: string;
  #locatorFd?: number;
  #forced = false;
  constructor(private readonly launch: Readonly<AcpBodyBrainPreparedLaunch>,
    private readonly bindings: Readonly<AcpProtocolRuntimeBindings>, stateDir: string,
    private readonly context: Readonly<AcpProtocolRuntimeLaunchContext>,
    private readonly log: (line: string) => void = () => undefined,
    private readonly securityHooks: Readonly<AcpProtocolRuntimeSecurityHooks> = {}) {
    if (realpathSync(stateDir) !== stateDir || !lstatSync(stateDir).isDirectory()
        || (lstatSync(stateDir).mode & 0o777) !== 0o700) throw new TypeError('unsafe ACP state directory');
    this.#sessionFile = join(stateDir, '.body-brain-acp-session-id');
  }
  get pid(): number { return this.#child?.pid ?? 2_147_483_647; }
  subscribe(listener: (event: AcpProtocolRuntimeEvent) => void): () => void {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  }
  #emit(event: AcpProtocolRuntimeEvent): void { for (const listener of this.#listeners) listener(event); }

  async start(): Promise<Readonly<AcpSessionMetadata>> {
    if (this.#child) throw new TypeError('ACP protocol runtime already started');
    this.#reserveSessionFile();
    try { await this.#connect();
    const created = await this.#connection!.agent.request(acp.methods.agent.session.new, {
      cwd: this.context.cwd,
      mcpServers: this.launch.translation.mcpServers ?? [],
      ...(this.launch.translation.sessionMeta ? { _meta: this.launch.translation.sessionMeta } : {}),
    }) as { sessionId: string };
    if (!LOCATOR.test(created.sessionId)) { await this.cleanup(); throw new TypeError('invalid ACP session locator'); }
    this.#sessionId = created.sessionId; this.#publishSessionId(created.sessionId);
    return Object.freeze({ schemaVersion: 1, token: created.sessionId,
      digest: acpProtocolMetadataDigest(created.sessionId, this.bindings) });
    } catch (error) { await this.cleanup(); throw error; }
  }

  async restore(metadata: Readonly<AcpSessionMetadata>): Promise<Readonly<AcpSessionMetadata>> {
    if (this.#child || metadata.schemaVersion !== 1 || !LOCATOR.test(metadata.token)
        || metadata.digest !== acpProtocolMetadataDigest(metadata.token, this.bindings))
      throw new TypeError('ACP restore metadata mismatch');
    this.#authenticateSessionFile(metadata.token); // before spawn or protocol effect
    const initialized = await this.#connect();
    try {
      if (initialized.agentCapabilities?.sessionCapabilities?.resume != null)
        await this.#connection!.agent.request(acp.methods.agent.session.resume, {
          sessionId: metadata.token, cwd: this.context.cwd, mcpServers: this.launch.translation.mcpServers ?? [],
        });
      else if (initialized.agentCapabilities?.loadSession)
        await this.#connection!.agent.request(acp.methods.agent.session.load, {
          sessionId: metadata.token, cwd: this.context.cwd, mcpServers: this.launch.translation.mcpServers ?? [],
        });
      else throw new TypeError('exact ACP restore unsupported');
    } catch (error) { await this.cleanup(); throw error; }
    this.#sessionId = metadata.token; return Object.freeze({ ...metadata });
  }

  async prompt(text: string): Promise<{ stopReason?: string }> {
    if (!this.#connection || !this.#sessionId) throw new TypeError('ACP protocol runtime unavailable');
    return this.#connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: this.#sessionId, prompt: [{ type: 'text', text }],
    }) as Promise<{ stopReason?: string }>;
  }
  async cancel(): Promise<void> { if (!this.#connection || !this.#sessionId) throw new TypeError('ACP protocol runtime unavailable');
    await this.#connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.#sessionId }); }
  async close(forced = false): Promise<void> { this.#forced ||= forced;
    if (this.#connection && this.#sessionId) try {
      await this.#connection.agent.request(acp.methods.agent.session.close, { sessionId: this.#sessionId });
    } catch { /* cleanup below */ } await this.cleanup(); }
  async cleanup(): Promise<void> { const child = this.#child; this.#connection?.close(); this.#connection = undefined;
    this.#child = undefined; if (this.#locatorFd !== undefined) { closeSync(this.#locatorFd); this.#locatorFd = undefined; }
    if (child && child.exitCode === null && child.signalCode === null) child.kill(this.#forced ? 'SIGKILL' : 'SIGTERM'); }

  async #connect(): Promise<{ agentCapabilities?: acp.AgentCapabilities }> {
    const child = spawn(this.launch.argv[0]!, this.launch.argv.slice(1), {
      cwd: this.context.cwd, env: { ...this.launch.env, ...this.context.env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    this.#child = child; child.stderr.on('data', chunk => this.log(String(chunk).trimEnd()));
    child.once('exit', (code, signal) => this.#emit({ kind: 'exit', code: this.#forced ? 'forced'
      : code === 0 && signal === null ? 'clean_exit' : 'lost' }));
    const app = acp.client({ name: 'ours-fleet' })
      .onNotification(acp.methods.client.session.update, ({ params }) => this.#emit({ kind: 'update', update: params.update }))
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => new Promise(resolve => {
        const permissionId = String(params.toolCall.toolCallId);
        this.#emit({ kind: 'permission', permissionId, optionIds: Object.freeze(params.options.map(value => value.optionId)),
          settle: optionId => resolve({ outcome: { outcome: 'selected', optionId } }),
          reject: () => resolve({ outcome: { outcome: 'cancelled' } }) });
      }));
    this.#connection = app.connect(acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    return this.#initialize();
  }
  async #initialize(): Promise<{ agentCapabilities?: acp.AgentCapabilities }> {
    return this.#connection!.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {}, clientInfo: { name: 'ours-fleet', version: '1' } }) as Promise<{ agentCapabilities?: acp.AgentCapabilities }>;
  }
  #authenticateSessionFile(locator: string): void {
    const before = lstatSync(this.#sessionFile, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || (Number(before.mode) & 0o777) !== 0o600 || before.size > 1024n)
      throw new TypeError('unsafe ACP session locator');
    let fd: number | undefined;
    try { this.securityHooks.beforeLocatorOpen?.();
      fd = openSync(this.#sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(fd, { bigint: true });
      if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size
          || before.mtimeNs !== opened.mtimeNs) throw new TypeError('unsafe ACP session locator');
      const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
      while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) throw new TypeError('ACP session locator mismatch'); offset += count; }
      const afterFd = fstatSync(fd, { bigint: true }); const after = lstatSync(this.#sessionFile, { bigint: true });
      if (opened.dev !== afterFd.dev || opened.ino !== afterFd.ino || opened.size !== afterFd.size
          || opened.mtimeNs !== afterFd.mtimeNs || opened.dev !== after.dev || opened.ino !== after.ino
          || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs
          || bytes.toString('utf8') !== `${locator}\n`) throw new TypeError('ACP session locator mismatch');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  #reserveSessionFile(): void {
    this.#locatorFd = openSync(this.#sessionFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.securityHooks.afterLocatorReserveOpen?.();
    const opened = fstatSync(this.#locatorFd, { bigint: true });
    const path = lstatSync(this.#sessionFile, { bigint: true });
    if (!opened.isFile() || opened.dev !== path.dev || opened.ino !== path.ino
        || (Number(opened.mode) & 0o777) !== 0o600 || opened.size !== 0n)
      throw new TypeError('unsafe ACP session locator');
  }
  #publishSessionId(locator: string): void {
    if (this.#locatorFd === undefined) throw new TypeError('ACP session locator unavailable');
    const fd = this.#locatorFd; const before = fstatSync(fd, { bigint: true });
    const path = lstatSync(this.#sessionFile, { bigint: true });
    if (before.dev !== path.dev || before.ino !== path.ino || before.size !== 0n)
      throw new TypeError('unsafe ACP session locator');
    const bytes = Buffer.from(`${locator}\n`); let offset = 0;
    while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new TypeError('ACP session locator write failed'); offset += count; }
    ftruncateSync(fd, bytes.length); fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== BigInt(bytes.length))
      throw new TypeError('unsafe ACP session locator');
    closeSync(fd); this.#locatorFd = undefined;
    const dirFd = openSync(dirname(this.#sessionFile), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }
}
