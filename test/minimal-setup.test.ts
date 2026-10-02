import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, splitRootFor } from '../src/config.js';
import { ensureMinimalSetup } from '../src/minimal-setup.js';

const cleanup: string[] = [];
afterEach(()=>{for(const root of cleanup.splice(0))rmSync(root,{recursive:true,force:true});});

test('minimal setup loads a valid web manifest with no chosen roles/models and is repeatable', async () => {
 const root=mkdtempSync(join(tmpdir(),'fleet-minimal-'));cleanup.push(root);
 const config=join(root,'fleet.yaml');await ensureMinimalSetup(config);
 const before=readFileSync(config,'utf8');assert.equal(loadConfig(config).roles.length,0);
 await ensureMinimalSetup(config);assert.equal(readFileSync(config,'utf8'),before);
});

test('partial existing split setup is retained without manufacturing an unrelated manifest',async ()=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-minimal-partial-'));cleanup.push(root);
 const config=join(root,'fleet.yaml'),split=splitRootFor(config);mkdirSync(split,{mode:0o700});
 writeFileSync(join(split,'retained.txt'),'retained',{mode:0o600});
 await assert.rejects(ensureMinimalSetup(config),/without its manifest/);
 assert.equal(readFileSync(join(split,'retained.txt'),'utf8'),'retained');
});
