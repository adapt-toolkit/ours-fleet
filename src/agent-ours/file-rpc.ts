import { randomUUID } from 'node:crypto';
import type { FileExecutionContext } from '@ours.network/mcp/server';
import type { ToolRequestExtra } from '@ours.network/mcp/dist/types/mcp/tool.js';
import { MAX_CHUNK_BYTES, type Wire } from './wire.js';

/** Call-scoped callbacks carry no daemon credentials or upload receipts. */
export class FileCallbacks implements FileExecutionContext {
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(private readonly wire: Wire) {}
  receive(frame: any): void {
    if (frame?.kind !== 'fs-result' || typeof frame.id !== 'string')
      throw Error('INVALID_FILE_RESPONSE');
    const p = this.pending.get(frame.id);
    if (!p) throw Error('UNSOLICITED_FILE_RESPONSE');
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.error) p.reject(Error('AGENT_FILE_OPERATION_FAILED'));
    else p.resolve(frame.value);
  }
  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error('FILE_BRIDGE_DISCONNECTED'));
    }
    this.pending.clear();
  }
  private async rpc(call: string, op: string, args: unknown, signal: AbortSignal): Promise<any> {
    signal.throwIfAborted();
    if (this.pending.size >= 64) throw Error('FILE_CALLBACK_LIMIT');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (f: (v: any) => void) => (value: any) => {
        signal.removeEventListener('abort', abort);
        f(value);
      };
      const fail = (reason: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        finish(reject)(reason);
      };
      const abort = () => fail(Error('FILE_CALLBACK_ABORTED'));
      const timer = setTimeout(() => fail(Error('FILE_CALLBACK_TIMEOUT')), 30_000);
      timer.unref();
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject), timer });
      signal.addEventListener('abort', abort, { once: true });
      void this.wire
        .send({ kind: 'fs', id, call, op, args })
        .catch(() => fail(Error('FILE_BRIDGE_DISCONNECTED')));
    });
  }
  async canRead(path: string, extra: ToolRequestExtra): Promise<boolean> {
    return (await this.rpc(String(extra.requestId), 'probe', { path }, extra.signal)) === true;
  }
  async read(path: string, extra: ToolRequestExtra) {
    const call = String(extra.requestId),
      handle = randomUUID();
    const meta = await this.rpc(call, 'read-open', { path, handle }, extra.signal);
    if (
      !meta ||
      typeof meta.filename !== 'string' ||
      !Number.isSafeInteger(meta.size) ||
      meta.size < 0
    )
      throw Error('INVALID_FILE_METADATA');
    const close = async () => {
      await this.rpc(call, 'close', { handle }, new AbortController().signal).catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await this.rpc(call, 'read', { handle }, extra.signal);
          if (chunk === null) {
            controller.close();
            return;
          }
          if (typeof chunk !== 'string' || chunk.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4)
            throw Error('INVALID_FILE_CHUNK');
          const bytes = Buffer.from(chunk, 'base64');
          if (bytes.length > MAX_CHUNK_BYTES) throw Error('FILE_CHUNK_TOO_LARGE');
          controller.enqueue(bytes);
        } catch (error) {
          controller.error(error);
          await close();
        }
      },
      cancel: close,
    });
    return { filename: meta.filename, size: meta.size, body, close };
  }
  async write(path: string, body: ReadableStream<Uint8Array>, extra: ToolRequestExtra) {
    const call = String(extra.requestId),
      handle = randomUUID();
    const reader = body.getReader();
    try {
      const resolved = await this.rpc(call, 'write-open', { path, handle }, extra.signal);
      if (typeof resolved !== 'string') throw Error('INVALID_FILE_PATH');
      let size = 0;
      for (;;) {
        extra.signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        for (let offset = 0; offset < chunk.value.length; offset += MAX_CHUNK_BYTES) {
          const bytes = chunk.value.subarray(offset, offset + MAX_CHUNK_BYTES);
          size += bytes.length;
          await this.rpc(
            call,
            'write',
            { handle, data: Buffer.from(bytes).toString('base64') },
            extra.signal,
          );
        }
      }
      await this.rpc(call, 'close', { handle }, extra.signal);
      return { path: resolved, size };
    } finally {
      await reader.cancel().catch(() => {});
      await this.rpc(call, 'close', { handle }, new AbortController().signal).catch(() => {});
    }
  }
}
