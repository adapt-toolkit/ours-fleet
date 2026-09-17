import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
const helper = join(dirname(fileURLToPath(import.meta.url)), 'review-sdk-install.mjs');
const sha = 'a'.repeat(40);
function fixture(t, { workspace = false, fail = false, tamper = false, lock = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-install-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OURS_') && !k.toLowerCase().startsWith('npm_config_'))), HOME: join(dir, 'home'), GITHUB_EVENT_NAME: 'pull_request', npm_config_registry: 'http://127.0.0.1:9', npm_config_offline: 'true', npm_config_userconfig: join(dir, 'user.npmrc'), npm_config_globalconfig: join(dir, 'global.npmrc') };
  mkdirSync(env.HOME); writeFileSync(env.npm_config_userconfig, ''); writeFileSync(env.npm_config_globalconfig, '');
  function pack(name, deps = {}) {
    const where = join(dir, name.split('/').pop()); mkdirSync(where);
    writeFileSync(join(where, 'package.json'), JSON.stringify({name, version: '9.0.0', dependencies: deps}));
    const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json'], {cwd:where,env,encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return join(where, JSON.parse(result.stdout)[0].filename);
  }
  const sdk = pack('@ours.network/sdk');
  const cli = pack('@ours.network/cli', {'@ours.network/sdk':'1.0.0'});
  const wrapper = pack('nested-old-sdk', {'@ours.network/sdk':'0.0.1'});
  const root = join(dir, 'consumer'); mkdirSync(root);
  const scripts = { postinstall: `node -e "require('fs').writeFileSync('lifecycle-ran','yes')"` };
  if (fail) scripts.preinstall = 'node -e "process.exit(23)"';
  if (tamper) scripts.postinstall = `node -e "const f=require('fs');const p=JSON.parse(f.readFileSync('package-lock.json'));p.packages['node_modules/@ours.network/sdk'].integrity='sha512-invalid';f.writeFileSync('package-lock.json',JSON.stringify(p))"`;
  const manifest = { name:'consumer-fixture',version:'1.0.0',private:true,scripts,dependencies:{'nested-old-sdk':`file:${wrapper}`} };
  const saved = new Map();
  if (workspace) {
    manifest.workspaces = ['packages/*'];
    mkdirSync(join(root,'packages','child'),{recursive:true});
    saved.set(join(root,'packages','child','package.json'),JSON.stringify({name:'child-fixture',version:'1.0.0',dependencies:{'@ours.network/sdk':'2.0.0','@ours.network/cli':'2.0.0'}},null,3)+'\n');
  } else manifest.dependencies['@ours.network/sdk'] = '2.0.0';
  saved.set(join(root,'package.json'),JSON.stringify(manifest,null,4)+'\n');
  if (lock) saved.set(join(root,'package-lock.json'),'{"name":"consumer-fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n');
  for (const [path,bytes] of saved) writeFileSync(path,bytes);
  return {root,sdk,cli,env,run(extra={}) {return spawnSync(process.execPath,[helper,root,sdk,cli,sha],{env:{...env,...extra},encoding:'utf8'});},restored(){for(const [path,bytes] of saved)assert.equal(readFileSync(path,'utf8'),bytes,path);if(!lock)assert.equal(existsSync(join(root,'package-lock.json')),false);}};
}
test('refuses non-PR use before touching manifests',t=>{const f=fixture(t);const r=f.run({GITHUB_EVENT_NAME:'push'});assert.notEqual(r.status,0);assert.match(r.stderr,/pull_request/);f.restored();});
test('installs reviewed artifacts over incompatible nested versions and restores manifests',t=>{const f=fixture(t);const r=f.run();assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/sha512-/);assert.equal(readFileSync(join(f.root,'lifecycle-ran'),'utf8'),'yes');assert.equal(JSON.parse(readFileSync(join(f.root,'node_modules/@ours.network/sdk/package.json'))).version,'9.0.0');f.restored();});
test('rewrites workspace dependencies and restores existing lock byte-for-byte',t=>{const f=fixture(t,{workspace:true,lock:true});const r=f.run();assert.equal(r.status,0,r.stdout+r.stderr);f.restored();});
test('restores original lock and manifests when lifecycle installation fails',t=>{const f=fixture(t,{workspace:true,lock:true,fail:true});const r=f.run();assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/23/);f.restored();});
test('rejects a resolved graph integrity mismatch and restores manifests',t=>{const f=fixture(t,{tamper:true});const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/integrity|mismatch/i);f.restored();});
