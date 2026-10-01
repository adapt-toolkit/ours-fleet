import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const pin=JSON.parse(readFileSync(new URL('../web-source.json',import.meta.url)));
const pack=readFileSync(new URL('../assets/web-source.pack',import.meta.url));
if(createHash('sha256').update(pack).digest('hex')!==pin.packSha256)throw Error('Pinned frontend source pack integrity mismatch');
const root=resolve('.web-source');
mkdirSync(root,{recursive:true});
if(!existsSync(resolve(root,'.git')))execFileSync('git',['init'],{cwd:root,stdio:'ignore'});
execFileSync('git',['index-pack','--stdin'],{cwd:root,input:pack,stdio:['pipe','ignore','inherit']});
execFileSync('git',['checkout','--detach',pin.commit],{cwd:root,stdio:'inherit'});
// Only this commit/tree is bundled: no ancestors, credentials or private runtime state.
execFileSync('npm',['ci'],{cwd:root,stdio:'inherit'});
execFileSync('npm',['run','build'],{cwd:root,stdio:'inherit'});
