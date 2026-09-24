import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-sync-lock-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const moduleUrl = pathToFileURL(resolve('dist/atomic-file.js')).href;
function worker(body: string) {
  const code = `import {withSynchronousFileLock as lock} from ${JSON.stringify(moduleUrl)}; import fs from 'node:fs'; const root=${JSON.stringify(root)}; ${body}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  const done = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => code === 0 || signal === 'SIGKILL' ? resolve() : reject(new Error(error || `exit ${code}`))); });
  return { child, done };
}
it('serializes simultaneous writers and concurrent dead-claim reapers without losing increments', async () => {
  mkdirSync(join(root, 'lock')); writeFileSync(join(root, 'count'), '0');
  writeFileSync(join(root, 'lock', `2147483647-${randomUUID()}.json`), JSON.stringify({ pid: 2147483647, choosing: false, ticket: 1 }));
  const workers = Array.from({ length: 10 }, () => worker(`for(let i=0;i<10;i++) lock(root+'/lock',()=>{const n=Number(fs.readFileSync(root+'/count','utf8')); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1); fs.writeFileSync(root+'/count',String(n+1));});`));
  await Promise.all(workers.map(w => w.done));
  expect(readFileSync(join(root, 'count'), 'utf8')).toBe('100');
});
it('recovers a killed holder without allowing contenders into a live successor', async () => {
  writeFileSync(join(root, 'count'), '0');
  const holder = worker(`lock(root+'/lock',()=>{process.stdout.write('held');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);});`);
  await new Promise<void>(resolve => holder.child.stdout.once('data', () => resolve()));
  const contenders = Array.from({ length: 5 }, () => worker(`lock(root+'/lock',()=>{if(fs.existsSync(root+'/inside'))throw Error('overlap');fs.writeFileSync(root+'/inside','yes');const n=Number(fs.readFileSync(root+'/count','utf8'));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);fs.writeFileSync(root+'/count',String(n+1));fs.unlinkSync(root+'/inside');});`));
  holder.child.kill('SIGKILL'); await holder.done; await Promise.all(contenders.map(c => c.done));
  expect(readFileSync(join(root, 'count'), 'utf8')).toBe('5');
});
