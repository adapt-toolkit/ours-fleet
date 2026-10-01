import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from '../paths.js';
export function startWorkspaceTunnel(origin:string):()=>Promise<void> {
  const dir=join(stateRoot(),'workspace'),file=join(dir,'tunnel.json');
  if(!existsSync(file))return async()=>{};
  const config=JSON.parse(readFileSync(file,'utf8')) as {origin:string;tokenFile:string};
  if(config.origin!==origin)throw Error('Workspace tunnel requires its configured public origin');
  const tokenFile=join(dir,'connector');if(config.tokenFile!==tokenFile)throw Error('Unexpected connector credential path');
  const stat=lstatSync(tokenFile);if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)!==0 || stat.uid!==process.getuid?.())throw Error('Connector credential must be an owned private file');
  let stopped=false,child:ChildProcess|undefined,timer:NodeJS.Timeout|undefined,backoff=1000;
  const launch=()=>{if(stopped)return;child=spawn('cloudflared',['tunnel','--no-autoupdate','run','--token-file',tokenFile],{stdio:'ignore'});let scheduled=false;
    const retry=()=>{if(scheduled || stopped)return;scheduled=true;timer=setTimeout(launch,backoff);backoff=Math.min(30000,backoff*2);};child.once('error',retry);child.once('exit',retry);};launch();
  return async()=>{stopped=true;clearTimeout(timer);const current=child;if(!current || current.exitCode!==null)return;await new Promise<void>(resolve=>{const timeout=setTimeout(()=>{current.kill('SIGKILL');resolve();},5000);current.once('exit',()=>{clearTimeout(timeout);resolve();});current.kill('SIGTERM');});};
}
