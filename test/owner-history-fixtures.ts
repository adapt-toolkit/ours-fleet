import type {
  OursHistoryFile, OursHistoryMessage, OursIncomingMessage,
} from '../src/owner-channel/ours-client.js';

/** Complete a deliberately partial test message as an inbound history row. */
export function historyMessage(value: unknown, defaultSeq = 1): OursHistoryMessage {
  const row = value as Record<string, unknown>;
  const from = (row.from ?? { id: '', name: '' }) as { id: string; name?: string };
  const seq = Number(row.seq ?? row.msg_id ?? defaultSeq);
  const date = String(row.date ?? '2026-08-21T00:00:00.000Z');
  const text = String(row.text ?? row.body ?? '');
  return {
    seq, msg_id: Number(row.msg_id ?? seq), wire_id: String(row.wire_id ?? `wire-${seq}`),
    from: { id: String(from.id ?? ''), name: String(from.name ?? '') },
    peer: { id: String(from.id ?? ''), name: String(from.name ?? '') },
    direction: 'in', text, body: text, occurred_at_ms: Number(row.occurred_at_ms ?? seq), date,
    message_kind: row.message_kind === 'command' || row.message_kind === 'command_result'
      ? row.message_kind : 'text',
    encryption: 'e2e', transport: 'double_ratchet', inbox_state: 'read', status: 'read',
    delivery_state: null, human_read_at_ms: null,
    reply_to: (row.reply_to ?? null) as OursHistoryMessage['reply_to'],
  };
}

/** Produce the body-free unread row returned by listIncomingMessages. */
export function incomingMessage(value: unknown, defaultSeq = 1): OursIncomingMessage {
  const item = historyMessage(value, defaultSeq);
  return {
    seq: item.seq, msg_id: item.msg_id, wire_id: item.wire_id, from: item.from,
    message_kind: item.message_kind,
    occurred_at_ms: item.occurred_at_ms, date: item.date, encryption: item.encryption,
    inbox_state: 'unread', status: 'unread', reply_to: item.reply_to,
  };
}

/** Complete a deliberately partial test file as an inbound persistent-history row. */
export function historyFile(value: unknown, defaultSeq = 1): OursHistoryFile {
  const row = value as Record<string, unknown>;
  const from = (row.from ?? { id: '', name: '' }) as { id: string; name?: string };
  const seq = Number(row.seq ?? row.file_id ?? defaultSeq);
  const status = row.status === 'unread' ? 'unread' : 'read';
  return {
    seq, file_id: Number(row.file_id ?? seq), wire_id: String(row.wire_id ?? `file-${seq}`),
    from: { id: String(from.id ?? ''), name: String(from.name ?? '') },
    peer: { id: String(from.id ?? ''), name: String(from.name ?? '') }, direction: 'in',
    filename: String(row.filename ?? 'file.bin'), mime: String(row.mime ?? 'application/octet-stream'),
    size: Number(row.size ?? row.byte_length ?? 0), byte_length: Number(row.byte_length ?? row.size ?? 0),
    sha256: String(row.sha256 ?? ''), occurred_at_ms: Number(row.occurred_at_ms ?? seq),
    date: String(row.date ?? '2026-08-21T00:00:00.000Z'), encryption: 'e2e',
    inbox_state: status, status, delivery_state: null, human_read_at_ms: null,
    reply_to: (row.reply_to ?? null) as OursHistoryFile['reply_to'],
    blob_path: String(row.blob_path ?? row.path ?? ''),
    kind: row.kind === 'voice_message' ? 'voice_message' : 'file',
  };
}
