import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realExec, type Exec } from '../exec.js';
import { assertSecureCloudflaredVersion, cloudflaredUnavailableError, CLOUDFLARED_VERSION_TIMEOUT_MS } from '../security-versions.js';
import { stateRoot } from '../paths.js';
export async function startWorkspaceTunnel(origin:string, exec: Exec = realExec):Promise<()=>Promise<void>> {
  const dir=join(stateRoot(),'workspace'),file=join(dir,'tunnel.json');
  if(!existsSync(file))return async()=>{};
  const config=JSON.parse(readFileSync(file,'utf8')) as {origin:string;tokenFile:string};
  if(config.origin!==origin)throw Error('Workspace tunnel requires its configured public origin');
  const tokenFile=join(dir,'connector');if(config.tokenFile!==tokenFile)throw Error('Unexpected connector credential path');
  const stat=lstatSync(tokenFile);if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)!==0 || stat.uid!==process.getuid?.())throw Error('Connector credential must be an owned private file');
  // The connector is the executable named cloudflared on this process's PATH, the
  // same lookup spawn uses. Its version is verified before the first start and
  // before every reconnect, so a downgrade is refused and an upgrade is picked up.
  const verify=async()=>{
    const result=await exec('cloudflared',['--version'],{timeout:CLOUDFLARED_VERSION_TIMEOUT_MS});
    if(result.code!==0)throw Error(cloudflaredUnavailableError(result.code===127?'not found':'version check failed'));
    assertSecureCloudflaredVersion(result.stdout);
  };
  await verify();
  let stopped=false,child:ChildProcess|undefined,timer:NodeJS.Timeout|undefined,backoff=1000,reported='';
  const schedule=()=>{if(stopped)return;timer=setTimeout(reconnect,backoff);backoff=Math.min(30000,backoff*2);};
  // A refused or unverifiable connector is never started; retry after the backoff.
  const reconnect=()=>{timer=undefined;void verify().then(()=>{reported='';launch();},(error:Error)=>{
    if(stopped)return;
    if(error.message!==reported)console.error(`Workspace tunnel not restarted: ${error.message}`);
    reported=error.message;schedule();
  });};
  const launch=()=>{if(stopped)return;child=spawn('cloudflared',['tunnel','--no-autoupdate','run','--token-file',tokenFile],{stdio:'ignore'});let scheduled=false;
    // Keep an error listener for the child's whole lifetime, including shutdown.
    const retry=()=>{if(scheduled || stopped)return;scheduled=true;schedule();};child.on('error',retry);child.once('exit',retry);};launch();
  // A failed spawn has no pid and reports error/close rather than exit.
  return async()=>{stopped=true;clearTimeout(timer);const current=child;if(!current?.pid || current.exitCode!==null || current.signalCode!==null)return;await new Promise<void>(resolve=>{const timeout=setTimeout(()=>{current.kill('SIGKILL');resolve();},5000);current.once('close',()=>{clearTimeout(timeout);resolve();});current.kill('SIGTERM');});};
}
