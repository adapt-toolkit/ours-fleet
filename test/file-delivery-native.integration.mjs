// Actual bundled ACP adapters + managed daemon/bridge. Only model intents are scripted.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {mkdirSync,writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {attachOursClient} from '@ours.network/sdk/client';
import {prepareManagedAgent,storeTemporaryLaunch} from '../dist/agent-ours/service.js';
import {prepareManagedHarness} from '../dist/agent-ours/harness.js';
import {makeCodexAdapter} from '../dist/harness/codex.js';
import {makeClaudeCodeAdapter} from '../dist/harness/claude-code.js';
import {AcpSession} from '../dist/session/acp.js';
import {readDeliveredFile} from '../dist/file-delivery/store.js';
const variant=process.env.FLEET_FILE_NATIVE_VARIANT ?? 'normal';
const [harnessName,rootArg,runtimeArg]=process.argv.slice(2);assert(['codex','claude-code'].includes(harnessName));assert(rootArg&&runtimeArg);
const root=resolve(rootArg), runtime=resolve(runtimeArg),claude=harnessName==='claude-code';mkdirSync(root,{mode:0o700});
const daemonState=join(root,'d'),stateDir=join(root,'a'),configHome=join(root,'c');for(const p of[daemonState,stateDir,configHome,join(root,'deliverables')])mkdirSync(p,{mode:0o700});
const bytes=Buffer.from([0,255,128,42,10,0,64]);writeFileSync(join(root,'deliverables','test.bin'),bytes);writeFileSync(join(stateDir,'.session-id'),randomUUID());
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r)),pause=ms=>new Promise(r=>setTimeout(r,ms));
const portProbe=tcpServer();await listen(portProbe);const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
const instance=randomUUID(),endpoint=`http://127.0.0.1:${port}`,profile=join(root,'profile.json'),credentialPath=join(root,'token'),config=join(root,'daemon.json');
writeFileSync(config,JSON.stringify({stateDir:daemonState,port,apiVisibility:'owner'}),{mode:0o600});
const daemon=spawn(process.execPath,[resolve('node_modules/@ours.network/daemon/dist/cli.js'),'daemon','serve','--managed'],{env:{PATH:process.env.PATH,HOME:root,OURS_STATE_DIR:daemonState,OURS_PORT:String(port),OURS_DAEMON_ID:instance,OURS_API_VISIBILITY:'owner',OURS_CONFIG:config,OURS_BROKER_URL:'ws://127.0.0.1:1'},stdio:['ignore','pipe','pipe']});
let log='',session,managed,control,providerError;for(const s of[daemon.stdout,daemon.stderr])s.on('data',b=>log=(log+b).slice(-5000));
process.env.OURS_FLEET_HOME=join(root,'f');let sequence=0,sends=0;const outputs=[];
const provider=createServer(async(req,res)=>{try{
 let body='';for await(const b of req)body+=b;
 if(req.url.startsWith('/daemon/')){const upstream=await fetch(endpoint+req.url.slice('/daemon'.length),{method:req.method,headers:req.headers,body:body||undefined});res.writeHead(upstream.status,Object.fromEntries(upstream.headers));return res.end(Buffer.from(await upstream.arrayBuffer()));}
 const input=body?JSON.parse(body):{};
 if(req.url.includes('count_tokens'))return res.writeHead(200,{'content-type':'application/json'}).end('{"input_tokens":1}');
 if(claude){
  if(!req.url.includes('/messages'))return res.writeHead(404).end();
  const results=(input.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result');outputs.push(...results);
  const tools=input.tools??[],name=tools.find(t=>t.name.endsWith('send_file'))?.name;
  const send=name&&sends<1;if(send)sends++;
  const content=send?{type:'tool_use',id:'file_fixture',name,input:{path:'deliverables/test.bin'}}:{type:'text',text:'Done.'};
  const message={id:'msg_'+(++sequence),type:'message',role:'assistant',model:input.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}};
  if(!input.stream)return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({...message,content:[content],stop_reason:send?'tool_use':'end_turn'}));
  res.writeHead(200,{'content-type':'text/event-stream'});const emit=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify({type:event,...data})}\n\n`);
  emit('message_start',{message});emit('content_block_start',{index:0,content_block:send?{...content,input:{}}:{type:'text',text:''}});
  emit('content_block_delta',{index:0,delta:send?{type:'input_json_delta',partial_json:JSON.stringify(content.input)}:{type:'text_delta',text:content.text}});
  emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:send?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}});emit('message_stop',{});return res.end();
 }
 if(!req.url.endsWith('/responses'))return res.writeHead(404).end();
 outputs.push(...(input.input??[]).filter(i=>i.type==='custom_tool_call_output'));
 const send=sends<1;if(send)sends++;const id='resp_'+(++sequence);
 const output=send?{type:'custom_tool_call',id:'fc_'+sequence,call_id:'file_fixture',name:'exec',namespace:'functions',input:'text(await tools.mcp__ours__send_file({path:"deliverables/test.bin"}));'}:{type:'message',id:'msg_'+sequence,role:'assistant',status:'completed',content:[{type:'output_text',text:'Done.'}]};
 res.writeHead(200,{'content-type':'text/event-stream'});const emit=v=>res.write(`data: ${JSON.stringify(v)}\n\n`);
 emit({type:'response.created',response:{id,status:'in_progress',output:[]}});emit({type:'response.output_item.added',output_index:0,item:send?{...output,input:''}:output});emit({type:'response.output_item.done',output_index:0,item:output});emit({type:'response.completed',response:{id,status:'completed',output:[output],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
 }catch(e){providerError=e;res.writeHead(400).end(String(e));}});
await listen(provider);const modelUrl=`http://127.0.0.1:${provider.address().port}`;
const timeout=setTimeout(()=>{daemon.kill('SIGKILL');console.error('bounded native fixture timeout');process.exit(1);},120_000);
try{
 let ready=false;for(let i=0;i<200;i++){assert.equal(daemon.exitCode,null,log);try{const r=await fetch(endpoint+'/selection',{signal:AbortSignal.timeout(100)});if(r.ok&&(await r.json()).instanceId===instance){ready=true;break;}}catch{}await pause(100);}assert(ready,log);
 copyFileSync(join(daemonState,'daemon-token'),credentialPath);writeFileSync(profile,JSON.stringify({serverUrl:modelUrl,endpoint:modelUrl+'/daemon',expectedInstanceId:instance,credentialPath}),{mode:0o600});
 control=await attachOursClient({endpoint,expectedInstanceId:instance,credentialPath,sessionMode:'local',requiredCapabilities:['local-pid-v1']});await control.createRootIdentity({skipIfRootExists:true,name:'TestRoot',exposeLocal:true,localAutoAccept:true});
 const role={name:'Agent',identity:'Agent',harness:harnessName,session:'acp',model:claude?'claude-sonnet-4-6':'gpt-5.6-sol',cwd:root,sourceFile:'fixture',file_delivery:{enabled:true,directory:'deliverables'},permissions:{approval:'ask',filesystem:'workspace',unattended:'deny'},harness_options:claude?{mem_palace:false,mcp_servers_only:true,mcp_servers:{ours:{command:'ours-mcp',args:['proxy']}}}:{sandbox:'workspace-write'},env:{OURS_CONFIG:profile,...(claude?{CLAUDE_CODE_EXECUTABLE:runtime}:{CODEX_PATH:runtime})}};
 storeTemporaryLaunch(role,'file-fixture');managed=await prepareManagedAgent(role,stateDir,true);
 const transport=variant==='alias' ? options=>AcpSession.start({...options,mcpServers:[...(options.mcpServers??[]),{name:'ours_alias',command:process.execPath,args:[resolve('dist/agent-ours/bridge.js')],env:[{name:'FLEET_OURS_BRIDGE_DESCRIPTOR',value:managed.descriptor}]}]}) : undefined;
 const adapter=claude?makeClaudeCodeAdapter():makeCodexAdapter(undefined,transport),prep=await adapter.prepareSession(role,{stateDir,runCwd:root});
 const override={model:role.model,model_provider:'fixture',model_providers:{fixture:{name:'fixture',base_url:modelUrl+'/v1',wire_api:'responses',requires_openai_auth:false}},features:{shell_tool:false,js_repl:false}};
 if(variant==='alias')override.mcp_servers={ours_alias:{command:process.execPath,args:[resolve('dist/agent-ours/bridge.js')],env:{FLEET_OURS_BRIDGE_DESCRIPTOR:managed.descriptor}}};
 if(variant==='disabled')override.mcp_servers={ours:{enabled:false}};
 writeFileSync(join(configHome,'config.toml'),`model_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url=${JSON.stringify(modelUrl+'/v1')}\nwire_api="responses"\nrequires_openai_auth=false\n`);
 const prepared=prepareManagedHarness(role,stateDir,root,managed.descriptor,{...prep.env,HOME:root,CODEX_HOME:configHome,CLAUDE_CONFIG_DIR:configHome,CODEX_CONFIG:JSON.stringify(override),OPENAI_API_KEY:'fixture-unused',OPENAI_BASE_URL:modelUrl+'/v1',ANTHROPIC_API_KEY:'fixture-unused',ANTHROPIC_BASE_URL:modelUrl,CLAUDE_CODE_EXECUTABLE:runtime,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',NO_PROXY:'127.0.0.1,localhost',DEFAULT_AUTH_REQUEST:JSON.stringify({methodId:'api-key',_meta:{'api-key':{apiKey:'fixture-unused'}}})});
 const allow=['PATH','HOME','TMPDIR','CODEX_HOME','CLAUDE_CONFIG_DIR','CODEX_CONFIG','CODEX_PATH','FLEET_OURS_MANAGED','FLEET_CURRENT_CHAT_FILES','DISABLE_MCP_CONFIG_FILTERING','OPENAI_API_KEY','OPENAI_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','CLAUDE_CODE_EXECUTABLE','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','DEFAULT_AUTH_REQUEST'];
 const env=Object.fromEntries(Object.entries(prepared.env).filter(([k])=>allow.includes(k)||k.startsWith('OURS_FLEET_CODEX_')||k==='OURS_FLEET_REAL_CODEX_PATH'));
 const launch=adapter.agentSession.prepareLaunch(role,{...prep,env});await managed.runtime.startHarness(async()=>session=await adapter.agentSession.start({role,prep,launch,managedOurs:prepared.ours,cwd:root,stateDir,mode:'fresh',permissions:role.permissions,permissionMode:adapter.effectivePermissionMode(role),log:l=>writeFileSync(join(root,'adapter.log'),l+'\n',{flag:'a'})}));
 managed.setFileDelivery(session.sendFileToChat.bind(session));session.setControllerAttached(true);
 const approve=setInterval(()=>{for(const e of session.conversationPage({}).events.filter(e=>e.kind==='permission.requested')){const options=e.payload.options??[];const option=options.find(o=>o.kind==='allow_once')??options.find(o=>o.optionId==='send');if(option)session.respondPermission(e.permissionId,option.optionId);}},20);
 let outcome;try{outcome=await session.submitPrompt('Send the fixture file to this chat.');}finally{clearInterval(approve);}
 assert.ifError(providerError);const events=session.conversationPage({}).events,files=events.filter(e=>e.kind==='file.attached');
 if(variant==='alias'){assert.equal(outcome.succeeded,false);assert.equal(files.length,0);assert.equal(sends,0);writeFileSync(join(root,'summary.json'),JSON.stringify({harness:harnessName,variant,noModelRequest:true,noCopy:true,published:0,outcome},null,2));console.log('PASS native alias rejected by exact-thread inventory before model execution');}
 else {assert(outcome.succeeded,JSON.stringify(outcome));assert.equal(files.length,1,JSON.stringify({outcome,outputs,events:events.map(e=>({kind:e.kind,payload:e.payload}))}));
 const attachment=files[0].payload.attachment;assert.equal(attachment.acpSessionId,session.snapshot().sessionId);assert.equal(attachment.turnId,files[0].turnId);assert.deepEqual((await readDeliveredFile(stateDir,attachment.id)).bytes,bytes);
 assert.equal(sends,1);const permissions=events.filter(e=>e.kind==='permission.requested');assert(permissions.some(e=>e.payload.title?.includes('Send file to this ACP chat')));
 writeFileSync(join(root,'summary.json'),JSON.stringify({harness:harnessName,oneAttempt:true,actualSession:attachment.acpSessionId,actualTurn:attachment.turnId,exactBinary:true,permissions:permissions.map(e=>({title:e.payload.title,toolCallId:e.toolCallId})),published:1,scriptedProviderOnly:true},null,2));console.log('PASS',harnessName,'actual native MCP call, approval, bridge copy, bound publication and exact binary'); }
}catch(error){if(variant!=='disabled')throw error;assert.match(error.message,/CURRENT_CHAT_DELIVERY_UNAVAILABLE: ours MCP disabled/);console.log('PASS explicit disabled MCP rejected before replacement');writeFileSync(join(root,'summary.json'),JSON.stringify({harness:harnessName,variant,noModelRequest:true,noCopy:true,published:0},null,2));}finally{clearTimeout(timeout);await session?.close();await managed?.close(false);await control?.close();daemon.kill('SIGTERM');await Promise.race([new Promise(r=>daemon.once('exit',r)),pause(3000).then(()=>daemon.kill('SIGKILL'))]);provider.closeAllConnections();await new Promise(r=>provider.close(r));delete process.env.OURS_FLEET_HOME;}
