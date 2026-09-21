import type { Socket } from 'node:net';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024;
/** One bounded framed channel. No request replay after disconnect. */
export class Wire {
  private buffer = Buffer.alloc(0);
  private ended = false;
  onFrame: (frame: unknown) => void = () => {};
  onClose: () => void = () => {};
  constructor(readonly socket: Socket) {
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const end = this.buffer.indexOf(10);
        if (end < 0) {
          if (this.buffer.length > MAX_FRAME_BYTES) socket.destroy();
          return;
        }
        if (end > MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const line = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        try {
          this.onFrame(JSON.parse(line.toString('utf8')));
        } catch {
          socket.destroy();
          return;
        }
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (!this.ended) {
        this.ended = true;
        this.onClose();
      }
    });
  }
  async send(frame: unknown): Promise<void> {
    if (this.ended || this.socket.destroyed) throw Error('BRIDGE_DISCONNECTED');
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (bytes.length > MAX_FRAME_BYTES) throw Error('FRAME_TOO_LARGE');
    await new Promise<void>((resolve, reject) =>
      this.socket.write(bytes, (error) => (error ? reject(error) : resolve())),
    );
  }
  close(): void {
    this.socket.destroy();
  }
}
