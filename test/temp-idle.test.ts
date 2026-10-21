import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TemporaryChatIdle,TEMP_CHAT_IDLE_MS,readChatIdle} from '../src/temp-idle.js';
import type {SessionSnapshot} from '../src/session/types.js';
it('persists standalone idle activity across restart and never retires active/unknown work',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-chat-idle-'));
 try{
 const t=100000;const idle:SessionSnapshot={backend:'acp',alive:true,readiness:'idle',activity:{activeToolCalls:0}};
 let clock=new TemporaryChatIdle(dir,t);
 expect(clock.observe(idle,0,t+TEMP_CHAT_IDLE_MS-1)).toBe(false);
 clock=new TemporaryChatIdle(dir,t+TEMP_CHAT_IDLE_MS-1);
 expect(clock.observe(idle,0,t+TEMP_CHAT_IDLE_MS)).toBe(true);
 expect(clock.observe({...idle,readiness:'running'},1,t+TEMP_CHAT_IDLE_MS+1)).toBe(false);
 const end=t+TEMP_CHAT_IDLE_MS+1000;
 expect(clock.observe(idle,0,end)).toBe(false);
 expect(readChatIdle(dir)?.lastActivityAt).toBe(end);
 expect(new TemporaryChatIdle(dir,end+1).observe(idle,0,end+TEMP_CHAT_IDLE_MS)).toBe(true);
 expect(clock.observe({...idle,activity:undefined},0,end+TEMP_CHAT_IDLE_MS)).toBe(false);
 expect(clock.observe({...idle,pendingPermissionId:'pending'},0,end+2*TEMP_CHAT_IDLE_MS)).toBe(false);
 expect(clock.observe(idle,1,end+3*TEMP_CHAT_IDLE_MS)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
