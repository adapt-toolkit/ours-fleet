#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { access, mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CHUNK_BYTES, MAX_FRAME_BYTES, Wire } from './wire.js';

/** Runs inside exactly the harness OS sandbox. Only this process opens agent paths. */
export async function runBridge(descriptorPath: string): Promise<void> {
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  if (
    typeof descriptor.socket !== 'string' ||
    typeof descriptor.capability !== 'string' ||
    !Number.isInteger(descriptor.generation)
  )
    throw Error('INVALID_BRIDGE_DESCRIPTOR');
  if (process.env.FLEET_OURS_BRIDGE_EXPECTED) {
    const expected = JSON.parse(process.env.FLEET_OURS_BRIDGE_EXPECTED);
    const digest = createHash('sha256').update(JSON.stringify([descriptor.socket, descriptor.capability, descriptor.generation])).digest('hex');
    if (expected.transportDigest !== digest) throw Error('SUPERVISOR_TRANSPORT_CHANGED');
    if (['role', 'identity', 'cid', 'generation'].some(key => descriptor[key] !== expected[key]))
      throw Error('SUPERVISOR_SELECTION_CHANGED');
  }
  const wire = new Wire(connect(descriptor.socket));
  const handles = new Map<string, { file: FileHandle; call: string; write: boolean }>();
  const cleanup = async () => {
    for (const row of handles.values()) await row.file.close().catch(() => {});
    handles.clear();
  };
  let admitted = false;
  let stdin = Buffer.alloc(0);
  let chain = Promise.resolve();
  const fail = () => {
    wire.close();
    process.stdin.pause();
    void cleanup();
  };
  wire.onClose = fail;
  wire.onFrame = (raw: any) => {
    if (raw?.kind === 'ready') {
      if (admitted) throw Error('DUPLICATE_READY');
      admitted = true;
      process.stdin.resume();
      return;
    }
    if (!admitted) throw Error('BRIDGE_NOT_READY');
    if (raw?.kind === 'mcp') {
      const line = JSON.stringify(raw.value) + '\n';
      if (!process.stdout.write(line)) {
        wire.socket.pause();
        process.stdout.once('drain', () => wire.socket.resume());
      }
      return;
    }
    if (raw?.kind !== 'fs' || typeof raw.id !== 'string' || typeof raw.call !== 'string')
      throw Error('INVALID_BRIDGE_FRAME');
    chain = chain
      .then(async () => {
        try {
          const { op, args, call } = raw;
          let value: unknown;
          if (op === 'probe') {
            try {
              await access(args.path, constants.R_OK);
              value = true;
            } catch {
              value = false;
            }
          } else if (op === 'read-open' || op === 'write-open') {
            if (
              handles.size >= 32 ||
              typeof args.handle !== 'string' ||
              handles.has(args.handle) ||
              typeof args.path !== 'string'
            )
              throw Error('FILE_LIMIT');
            const path = resolve(args.path);
            if (op === 'write-open') await mkdir(dirname(path), { recursive: true });
            const file = await open(path, op === 'write-open' ? 'w' : 'r');
            handles.set(args.handle, { file, call, write: op === 'write-open' });
            value =
              op === 'write-open'
                ? path
                : { filename: basename(path), size: (await file.stat()).size };
          } else {
            const row = handles.get(args.handle);
            if (!row) {
              if (op === 'close') {
                value = null;
              } else throw Error('UNKNOWN_FILE_HANDLE');
            } else {
              if (row.call !== call) throw Error('FOREIGN_FILE_CALL');
              if (op === 'close') {
                handles.delete(args.handle);
                await row.file.close();
                value = null;
              } else if (op === 'read' && !row.write) {
                const buffer = Buffer.alloc(MAX_CHUNK_BYTES);
                const { bytesRead } = await row.file.read(buffer);
                value = bytesRead ? buffer.subarray(0, bytesRead).toString('base64') : null;
              } else if (op === 'write' && row.write) {
                if (
                  typeof args.data !== 'string' ||
                  args.data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4
                )
                  throw Error('FILE_CHUNK_LIMIT');
                const buffer = Buffer.from(args.data, 'base64');
                let offset = 0;
                while (offset < buffer.length) {
                  const r = await row.file.write(buffer, offset, buffer.length - offset);
                  if (!r.bytesWritten) throw Error('SHORT_WRITE');
                  offset += r.bytesWritten;
                }
                value = null;
              } else throw Error('INVALID_FILE_OPERATION');
            }
          }
          await wire.send({ kind: 'fs-result', id: raw.id, value });
        } catch {
          await wire.send({ kind: 'fs-result', id: raw.id, error: 'FILE_OPERATION_FAILED' });
        }
      })
      .catch(fail);
  };
  process.stdin.pause();
  process.stdin.on('data', (chunk: Buffer) => {
    stdin = Buffer.concat([stdin, chunk]);
    for (;;) {
      const end = stdin.indexOf(10);
      if (end < 0) {
        if (stdin.length > MAX_FRAME_BYTES) fail();
        return;
      }
      if (end > MAX_FRAME_BYTES) {
        fail();
        return;
      }
      const line = stdin.subarray(0, end);
      stdin = stdin.subarray(end + 1);
      try {
        const value = JSON.parse(line.toString('utf8'));
        process.stdin.pause();
        void wire.send({ kind: 'mcp', value }).then(() => process.stdin.resume(), fail);
      } catch {
        fail();
        return;
      }
    }
  });
  process.stdin.on('end', fail);
  process.stdout.on('error', fail);
  await wire.send({
    kind: 'hello',
    capability: descriptor.capability,
    generation: descriptor.generation,
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBridge(process.env.FLEET_OURS_BRIDGE_DESCRIPTOR ?? '').catch(() => {
    process.stderr.write('Fleet ours bridge unavailable\n');
    process.exitCode = 1;
  });
}
