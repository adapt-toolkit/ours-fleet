import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import {
  OursClient, OursError, attachOursClient, type AttachOursClientOptions,
  type NotificationEvent,
} from '@ours.network/sdk/client';

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
export type OursIncomingMessage = Res<'listIncomingMessages'>[number];
export type OursMessagesPayload = Res<'getMessages'>;
export type OursInboundMessage = OursMessagesPayload['messages'][number];
export type OursHistoryMessage = NonNullable<Res<'getHistoryItem'>>;
export type OursIncomingFile = Res<'listIncomingFiles'>[number];
export type OursRetrievedFiles = Res<'getFiles'>;
export type OursRetrievedFile = OursRetrievedFiles['files'][number];
export type OursHistoryFile = NonNullable<Res<'getFileInfo'>>;
export type OursNotificationEvent = NotificationEvent;

export type OursJsonValue = null | boolean | number | string | OursJsonValue[]
  | { [key: string]: OursJsonValue };
export interface OursCommandContext {
  readonly sender_cid: string;
  readonly sender_name: string;
  readonly request_wire_id: string;
}
export interface OursRegisteredCommand {
  name: string;
  description?: string;
  input_schema: { [key: string]: OursJsonValue };
  handler(
    argumentsValue: OursJsonValue, context: Readonly<OursCommandContext>,
  ): OursJsonValue | Promise<OursJsonValue>;
}

// The daemon normally returns a quiet long-poll within 25 seconds. Keep the
// client-side fence comfortably above it so ordinary quiet periods do not
// recycle a healthy stream, while a half-open socket still heals on its own.
const NOTIFICATION_REQUEST_DEADLINE_MS = 120_000;

// SDK sendFile({path}) inferred these common types before reading the path in
// the daemon process. Staged uploads move that read into fleet, so preserve the
// same advertised MIME rather than silently turning every attachment into an
// octet stream. Importing the SDK root just for its helper would also pull the
// daemon runtime into this client-only process.
const FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html',
  '.xml': 'application/xml', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.tar': 'application/x-tar', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

function mimeFromFilename(filename: string): string {
  return FILE_MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export class OursWatchDeadlineError extends OursDaemonError {}

function notificationRequest(input: Parameters<typeof globalThis.fetch>[0]): boolean {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  return /\/identities\/[^/]+\/notifications(?:\?|$)/.test(url);
}

function notificationDeadlineFetch(
  fetchImpl: typeof globalThis.fetch, deadlineMs: number,
): typeof globalThis.fetch {
  return async (input, init) => {
    if (!notificationRequest(input)) return fetchImpl(input, init);
    const ctrl = new AbortController();
    const upstream = init?.signal;
    let rejectFence!: (error: unknown) => void;
    const fence = new Promise<never>((_resolve, reject) => { rejectFence = reject; });
    const abortUpstream = () => {
      const reason = upstream?.reason
        ?? new DOMException('ours notification request aborted', 'AbortError');
      ctrl.abort(reason);
      // Shutdown must not wait for the deadline when a custom fetch ignores
      // AbortSignal either.
      rejectFence(reason);
    };
    if (upstream?.aborted) abortUpstream();
    else upstream?.addEventListener('abort', abortUpstream, { once: true });
    const timer = setTimeout(() => {
      const error = new OursWatchDeadlineError('ours notification request deadline exceeded');
      ctrl.abort(error);
      // Do not rely on a custom or half-open fetch implementation to honor
      // AbortSignal: the fence itself must always settle the request.
      rejectFence(error);
    }, deadlineMs);
    timer.unref?.();
    try {
      return await Promise.race([
        fetchImpl(input, { ...init, signal: ctrl.signal }),
        fence,
      ]);
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', abortUpstream);
    }
  };
}

/**
 * The daemon operations the owner channel needs, one typed method each.
 *
 * This interface deliberately has no generic `callTool(name, args): unknown`
 * escape hatch. The legacy MCP connector answered every
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
  /** Replace the bound identity's advertised typed-command catalog and handlers. */
  registerCommands(commands: OursRegisteredCommand[]): Promise<void>;
  listContacts(): Promise<OursContactsView>;
  generateInvite(name?: string): Promise<OursInviteResult>;
  addContact(a: { invite: string; name?: string }): Promise<OursAddContactResult>;
  listIncomingMessages(): Promise<OursIncomingMessage[]>;
  getMessages(limit: number): Promise<OursMessagesPayload>;
  getHistoryItem(wireId: string): Promise<OursHistoryMessage | null>;
  watchNotifications(
    identity: string,
    options?: { since?: number | 'tip'; signal?: AbortSignal },
  ): AsyncGenerator<OursNotificationEvent, void, undefined>;
  listIncomingFiles(): Promise<OursIncomingFile[]>;
  getFileInfo(wireId: string): Promise<OursHistoryFile | null>;
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
  /** Test seam; production uses the SDK's coherence-checking application attach path. */
  attachClient?(options: AttachOursClientOptions): OursClient | Promise<OursClient>;
  /** Underlying transport and deadline seams for deterministic half-open tests. */
  fetch?: typeof globalThis.fetch;
  notificationRequestDeadlineMs?: number;
  readFile?(path: string): Promise<Uint8Array>;
}

/**
 * The owner-channel's daemon client: one `OursClient` over the local ours HTTP
 * API, owning exactly one identity binding.
 *
 * Lease lifetime. The lease token IS the session, so each channel instance mints
 * its own and hands it back in `close()`. That replaces the connector proxy's
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
    // SDK 2's supported application path resolves endpoint, state root, and
    // token as one coherent selection, proves the daemon's state root before
    // sending credentials, and only then constructs the client.
    const options: AttachOursClientOptions = {
      env: environment,
      leaseToken: this.leaseToken,
      clientPid: process.pid,
      fetch: notificationDeadlineFetch(
        this.deps.fetch ?? globalThis.fetch,
        this.deps.notificationRequestDeadlineMs ?? NOTIFICATION_REQUEST_DEADLINE_MS,
      ),
    };
    this.client = await (this.deps.attachClient?.(options) ?? attachOursClient(options));
  }

  async bindIdentity(name: string): Promise<void> {
    // force is pinned off: the owner channel never evicts another live session
    // from an identity, it waits for the bounded handoff window and then fails.
    await this.ops().chooseIdentity({ name, force: false });
  }

  async registerCommands(commands: OursRegisteredCommand[]): Promise<void> {
    await this.ops().registerCommands(commands);
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

  async listIncomingMessages(): Promise<OursIncomingMessage[]> {
    return this.ops().listIncomingMessages();
  }

  async getMessages(limit: number): Promise<OursMessagesPayload> {
    return this.ops().getMessages({ limit });
  }

  async getHistoryItem(wireId: string): Promise<OursHistoryMessage | null> {
    return this.ops().getHistoryItem({ wire_id: wireId });
  }

  watchNotifications(
    identity: string,
    options?: { since?: number | 'tip'; signal?: AbortSignal },
  ): AsyncGenerator<OursNotificationEvent, void, undefined> {
    return this.ops().watchNotifications(identity, options);
  }

  async listIncomingFiles(): Promise<OursIncomingFile[]> {
    return this.ops().listIncomingFiles();
  }

  async getFileInfo(wireId: string): Promise<OursHistoryFile | null> {
    return this.ops().getFileInfo({ wire_id: wireId });
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
    // Legacy parity: only `refused` was a tool error. `migrating`,
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
    // The shared daemon may be owned by a different OS process/user and must
    // never be expected to open fleet-private outbox paths. SDK 2 stages bytes
    // read by THIS process, then sends only the opaque upload receipt.
    const bytes = await (this.deps.readFile?.(a.path) ?? readFile(a.path));
    const staged = await this.ops().uploadFile(bytes, {
      filename: a.filename, mime: mimeFromFilename(a.filename),
    });
    const verdict = await this.ops().sendFile({
      contact: a.contact, upload_id: staged.upload_id, filename: a.filename,
      ...(a.replyToWireId ? { reply_to_wire_id: a.replyToWireId } : {}),
    });
    // Legacy parity treated `migrating` as an error for
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
