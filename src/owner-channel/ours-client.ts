import { randomUUID } from 'node:crypto';

import { OursClient, OursError, type OursClientOptions } from '@ours.network/sdk/client';

import { resolveApiToken, resolveEndpoint } from '../monitor.js';

/** Any failure of a daemon operation. Never carries a message body or a token. */
export class OursDaemonError extends Error {}

/**
 * The daemon accepted the call and answered "not sent". The MCP surface reported
 * exactly these verdicts as tool errors, so they must keep throwing here: the
 * owner channel books a resolved send as delivered, and a silently-swallowed
 * refusal would be recorded as a delivered message that never left the host.
 */
export class OursSendRefusedError extends OursDaemonError {}

type Res<M extends keyof OursClient> =
  OursClient[M] extends (...args: never[]) => infer R ? Awaited<R> : never;

export type OursContactsView = Res<'listContacts'>;
export type OursInviteResult = Res<'generateInvite'>;
export type OursAddContactResult = Res<'addContact'>;
export type OursMessagesPayload = Res<'getMessages'>;
export type OursInboundMessage = OursMessagesPayload['messages'][number];
export type OursIncomingFile = Res<'listIncomingFiles'>[number];
export type OursRetrievedFiles = Res<'getFiles'>;
export type OursRetrievedFile = OursRetrievedFiles['files'][number];

/**
 * The daemon operations the owner channel needs, one typed method each.
 *
 * This interface deliberately has no generic `callTool(name, args): unknown`
 * escape hatch. The MCP surface had one, and because ours-mcp answers every
 * tool with `{content:[{type:'text',...}]}` and no `structuredContent`, the
 * transport fell back to returning the daemon's English sentence — which the
 * channel then pattern-matched (an invite blob sliced out of a prose sentence,
 * a bind conflict detected with /currently bound to another live session/i).
 * With no untyped result there is nothing left to pattern-match.
 */
export interface OursOps {
  /** Prepare the transport. Must be called before any operation. */
  start(): Promise<void>;
  /** Bind this session's identity. Throws `BOUND_ELSEWHERE` when it is held live. */
  bindIdentity(name: string): Promise<void>;
  listContacts(): Promise<OursContactsView>;
  generateInvite(name?: string): Promise<OursInviteResult>;
  addContact(a: { invite: string; name?: string }): Promise<OursAddContactResult>;
  getMessages(): Promise<OursMessagesPayload>;
  deferMessages(msgIds: number[]): Promise<void>;
  listIncomingFiles(): Promise<OursIncomingFile[]>;
  getFiles(wireIds: string[]): Promise<OursRetrievedFiles>;
  /**
   * The bytes of an already-retrieved file. Transport only — the caller owns
   * where they land, so path safety stays with the attachment code that already
   * enforces it (`writeRecoveredAttachment`).
   */
  fetchFile(wireId: string): Promise<Uint8Array>;
  sendMessage(a: { contact: string; text: string; replyToWireId?: string }): Promise<void>;
  sendFile(
    a: { contact: string; path: string; filename: string; replyToWireId?: string },
  ): Promise<void>;
  /** Release the daemon lease and stop. Never throws. */
  close(): Promise<void>;
}

/**
 * The typed error code of a daemon operation, or undefined when the failure was
 * not one (transport, abort, programming error). `instanceof` is checked first;
 * the structural fallback keeps a duplicated SDK copy in a consumer's tree from
 * silently demoting a real daemon verdict to "unknown transport failure".
 */
export function oursErrorCode(error: unknown): string | undefined {
  if (error instanceof OursError) return error.code;
  if (error instanceof Error && error.name === 'OursError') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The identity is bound by another live session; a predecessor may still be releasing it. */
export const OURS_BOUND_ELSEWHERE = 'BOUND_ELSEWHERE';

export interface OursSdkClientDeps {
  /** Test seam; production builds an `OursClient` from the resolved endpoint. */
  createClient?(options: OursClientOptions): OursClient;
}

/**
 * The owner-channel's daemon client: one `OursClient` over the local ours HTTP
 * API, owning exactly one identity binding.
 *
 * Lease lifetime. The lease token IS the session, so each channel instance mints
 * its own and hands it back in `close()`. That replaces the `ours-mcp proxy`
 * shell-PID fence, which existed because a supervised attempt had to make its
 * lease reclaimable while the supervisor itself stayed alive: an explicit
 * release does that deterministically, and `clientPid` still covers the case
 * where the whole supervisor dies without unwinding.
 */
export class OursSdkClient implements OursOps {
  private client?: OursClient;
  private readonly leaseToken = `ours-fleet-owner-${process.pid}-${randomUUID()}`;

  constructor(
    private readonly env: Record<string, string> = {},
    private readonly log: (line: string) => void = () => undefined,
    private readonly deps: OursSdkClientDeps = {},
  ) {}

  async start(): Promise<void> {
    if (this.client) return;
    const environment = { ...process.env, ...this.env };
    // Reuse fleet's own daemon resolution so this client and the notification
    // watch loop can never disagree about which daemon they are talking to.
    const endpoint = resolveEndpoint(environment);
    const apiToken = resolveApiToken(environment);
    const options: OursClientOptions = {
      url: endpoint.origin,
      leaseToken: this.leaseToken,
      clientPid: process.pid,
      ...(apiToken ? { apiToken } : {}),
    };
    this.client = this.deps.createClient?.(options) ?? new OursClient(options);
  }

  async bindIdentity(name: string): Promise<void> {
    // force is pinned off: the owner channel never evicts another live session
    // from an identity, it waits for the bounded handoff window and then fails.
    await this.ops().chooseIdentity({ name, force: false });
  }

  async listContacts(): Promise<OursContactsView> {
    return this.ops().listContacts();
  }

  async generateInvite(name?: string): Promise<OursInviteResult> {
    return this.ops().generateInvite(name ? { name } : {});
  }

  async addContact(a: { invite: string; name?: string }): Promise<OursAddContactResult> {
    return this.ops().addContact({ invite: a.invite, ...(a.name ? { name: a.name } : {}) });
  }

  async getMessages(): Promise<OursMessagesPayload> {
    return this.ops().getMessages();
  }

  async deferMessages(msgIds: number[]): Promise<void> {
    await this.ops().deferMessages({ msg_ids: msgIds });
  }

  async listIncomingFiles(): Promise<OursIncomingFile[]> {
    return this.ops().listIncomingFiles();
  }

  async getFiles(wireIds: string[]): Promise<OursRetrievedFiles> {
    return this.ops().getFiles({ wire_ids: wireIds });
  }

  async fetchFile(wireId: string): Promise<Uint8Array> {
    // save_file has no SDK operation on purpose: that daemon route only reports
    // that a too-old connector reached it. The bytes of a retrieved file are
    // already on disk, so read them back and let the caller write them as this
    // process's own OS user.
    return this.ops().fetchFile(wireId);
  }

  async sendMessage(a: { contact: string; text: string; replyToWireId?: string }): Promise<void> {
    const verdict = await this.ops().sendMessage({
      contact: a.contact, text: a.text,
      ...(a.replyToWireId ? { reply_to_wire_id: a.replyToWireId } : {}),
    });
    // Parity with ours-mcp 0.16.0: only `refused` was a tool error. `migrating`,
    // `deferred` and `e2e` are accepted-and-queued outcomes that it reported as
    // success, so they must not become failures here.
    if (verdict.kind === 'refused')
      throw new OursSendRefusedError(
        'the daemon refused the message: the contact\'s end-to-end session must be '
        + 're-established after an upgrade; it was not sent and not downgraded');
  }

  async sendFile(
    a: { contact: string; path: string; filename: string; replyToWireId?: string },
  ): Promise<void> {
    const verdict = await this.ops().sendFile({
      contact: a.contact, path: a.path, filename: a.filename,
      ...(a.replyToWireId ? { reply_to_wire_id: a.replyToWireId } : {}),
    });
    // Parity with ours-mcp 0.16.0, which treated `migrating` as an error for
    // files and as success for messages: files are not auto-queued behind a
    // migration, so "queued" would be a false delivery claim.
    if (verdict.kind === 'refused' || verdict.kind === 'migrating')
      throw new OursSendRefusedError(
        `the daemon did not send the file (${verdict.kind}): the contact's end-to-end `
        + 'session must be re-established after an upgrade; files are not queued');
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    // Handing the lease back is what lets a successor bind this identity without
    // waiting for the supervisor to exit. A failure here is not fatal — the
    // daemon still reclaims the lease when this process dies.
    try { await client.releaseLease(); }
    catch (error) {
      this.log(`lease release failed: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  private ops(): OursClient {
    if (!this.client) throw new OursDaemonError('ours daemon client is not started');
    return this.client;
  }
}
