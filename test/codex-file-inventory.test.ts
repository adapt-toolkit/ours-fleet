import { expect, it } from 'vitest';
import { CodexFileInventory } from '../src/harness/codex-file-inventory.js';
const tool={name:'send_file',inputSchema:{type:'object',additionalProperties:false,properties:{contact:{type:'string'},path:{type:'string'}},required:[]}};
const ours={serverInfo:{name:'ours'},name:'ours',runtimeStatus:'connected',toolsError:null,tools:{send_file:tool,current_identity:{name:'current_identity'},get_messages:{name:'get_messages'}}};
function fixture(){const sent:string[]=[],emitted:string[]=[];const gate=new CodexFileInventory(l=>sent.push(l),l=>emitted.push(l));return{gate,sent,emitted};}
const turn=JSON.stringify({id:1,method:'turn/start',params:{threadId:'actual-thread',input:[]}});
it('checks exact native thread inventory across pages before forwarding a turn, preserving unrelated tools',()=>{
 const {gate,sent,emitted}=fixture();try{
 expect(gate.observeClientLine(turn)).toBe(false);const q=JSON.parse(sent[0]);expect(q.params.threadId).toBe('actual-thread');
 expect(gate.observeServerLine(JSON.stringify({id:q.id,result:{data:[ours],nextCursor:'next'}}))).toBe(false);
 const next=JSON.parse(sent[1]);expect(next.params.cursor).toBe('next');
 gate.observeServerLine(JSON.stringify({id:next.id,result:{data:[{serverInfo:{name:'unrelated'},name:'other',toolsError:null,tools:{send_file:{name:'send_file'}}}],nextCursor:null}}));
 expect(sent[2]).toBe(turn);expect(emitted).toHaveLength(0);
 }finally{gate.close();}
});
it.each(['alias','filtered-alias','unknown-identity','disabled','missing','required-contact','unknown-schema','discovery-failure','unsupported-api','repeated-cursor'])('fails closed for %s without starting model turn',mode=>{
 const {gate,sent,emitted}=fixture();try{
 gate.observeClientLine(turn);const q=JSON.parse(sent[0]);let data:any[]=[ours];
 if(mode==='filtered-alias')data.push({...ours,name:'other',tools:{send_file:tool}});
 if(mode==='unknown-identity')data.push({name:'other',toolsError:null,tools:{},serverInfo:null});
 if(mode==='alias')data.push({...ours,name:'different_alias'});
 if(mode==='disabled')data=[{...ours,runtimeStatus:'disabled'}];
 if(mode==='missing')data=[];
 if(mode==='required-contact')data=[{...ours,tools:{send_file:{...tool,inputSchema:{...tool.inputSchema,required:['contact']}}}}];
 if(mode==='unknown-schema')data=[{...ours,tools:{send_file:{...tool,inputSchema:{...tool.inputSchema,additionalProperties:true}}}}];
 if(mode==='discovery-failure')data.push({name:'unknown',toolsError:'failed',tools:{}});
 gate.observeServerLine(JSON.stringify({id:q.id,...(mode==='unsupported-api'?{error:{code:-32601}}:{result:{data,nextCursor:mode==='repeated-cursor'?'same':null}})}));
 if(mode==='repeated-cursor')gate.observeServerLine(JSON.stringify({id:JSON.parse(sent[1]).id,result:{data:[],nextCursor:'same'}}));
 expect(sent.some(l=>JSON.parse(l).method==='turn/start')).toBe(false);expect(emitted).toHaveLength(1);expect(JSON.parse(emitted[0]).id).toBe(1);
 }finally{gate.close();}
});
