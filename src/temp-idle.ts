import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from './atomic-file.js';
import type { SessionSnapshot } from './session/types.js';
export const TEMP_CHAT_IDLE_MS = 24 * 60 * 60_000;
const FILE = 'chat-idle.json';
export type ChatIdlePolicy = {version:1; timeoutMs:number; lastActivityAt:number};
export function readChatIdle(dir:string):ChatIdlePolicy | undefined {
  if(!existsSync(join(dir,FILE))) return undefined;
  const value=JSON.parse(readFileSync(join(dir,FILE),'utf8'));
  if(value.version!==1 || !Number.isSafeInteger(value.lastActivityAt) || value.timeoutMs!==TEMP_CHAT_IDLE_MS) throw new Error('Invalid persisted chat idle policy');
  return value;
}
/** Only a standalone temporary supervisor owns this clock; browser reads never touch it. */
export class TemporaryChatIdle {
  private value:ChatIdlePolicy;
  private busy=false;
  constructor(private dir:string, now:number) {
    this.value=readChatIdle(dir)??{version:1,timeoutMs:TEMP_CHAT_IDLE_MS,lastActivityAt:now};
    this.save();
  }
  private save(){replaceFileAtomically(join(this.dir,FILE),JSON.stringify(this.value)+'\n',0o600);}
  observe(snapshot:SessionSnapshot, queueDepth:number, now:number):boolean {
    // Unknown activity evidence never grants permission to retire a session.
    const idle=snapshot.alive && snapshot.readiness==='idle' && !snapshot.pendingPermissionId && queueDepth===0 && snapshot.activity?.activeToolCalls===0;
    const update=Date.parse(snapshot.activity?.lastUpdateAt??'');
    let next=this.value.lastActivityAt;
    if(Number.isFinite(update)&&update<=now) next=Math.max(next,update);
    if(!idle || this.busy) next=Math.max(next,now);
    this.busy=!idle;
    // Active work checkpoints at most once a minute, with an immediate idle boundary write.
    if(next>this.value.lastActivityAt && (idle || next-this.value.lastActivityAt>=60_000)) {this.value.lastActivityAt=next;this.save();}
    return idle && now>=this.value.lastActivityAt && now-this.value.lastActivityAt>=this.value.timeoutMs;
  }
}
