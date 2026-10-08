import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socketPath } from '../src/socket-path.js';
const before = process.env.OURS_FLEET_SOCKET_ROOT;
let root: string;
afterEach(() => { if(before === undefined) delete process.env.OURS_FLEET_SOCKET_ROOT; else process.env.OURS_FLEET_SOCKET_ROOT=before; if(root) rmSync(root,{recursive:true,force:true}); });
it('maps deep logical paths to stable distinct private sockets and rejects unsafe roots', () => {
 root=mkdtempSync(join(tmpdir(),'f-'));process.env.OURS_FLEET_SOCKET_ROOT=root;
 const logical='/deep/'.repeat(30)+'role/.bridge/g1.sock'; const path=socketPath(logical);
 expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103); expect(socketPath(logical)).toBe(path);
 expect(socketPath(logical+'2')).not.toBe(path); chmodSync(root,0o777);expect(()=>socketPath(logical)).toThrow(/owner-only/);
});
