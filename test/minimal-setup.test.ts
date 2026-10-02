import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, splitRootFor } from '../src/config.js';
import { ensureMinimalSetup } from '../src/minimal-setup.js';

test('minimal setup loads a valid web manifest with no chosen roles/models and is repeatable', async t => {
 const root=mkdtempSync(join(tmpdir(),'fleet-minimal-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,'fleet.yaml');await ensureMinimalSetup(config);
 const before=readFileSync(config,'utf8');assert.equal(loadConfig(config).roles.length,0);
 await ensureMinimalSetup(config);assert.equal(readFileSync(config,'utf8'),before);
});

test('partial existing split setup is retained without manufacturing an unrelated manifest',async t=>{
 const root=mkdtempSync(join(tmpdir(),'fleet-minimal-partial-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,'fleet.yaml'),split=splitRootFor(config);mkdirSync(split,{mode:0o700});
 writeFileSync(join(split,'retained.txt'),'retained',{mode:0o600});
 await assert.rejects(ensureMinimalSetup(config),/without its manifest/);
 assert.equal(readFileSync(join(split,'retained.txt'),'utf8'),'retained');
});
