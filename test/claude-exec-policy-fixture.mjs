import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {makeClaudeCodeAdapter} from '../dist/harness/claude-code.js';
import {AcpSession} from '../dist/session/acp.js';
export async function executeClaudeWithRules({claude,root,cwd,env,prefixes,command,exclude=true,allowProbe=false}) {
  const configHome=join(root,'claude-fixture'); mkdirSync(configHome,{recursive:true});
  const patterns=prefixes.map(p=>p.join(' ')+(p.at(-1)==='--'?' *':''));
  const settings={sandbox:{...(process.env.FLEET_TEST_NESTED_SANDBOX==='1'?{enableWeakerNestedSandbox:true}:{}),enabled:true,failIfUnavailable:true,autoAllowBashIfSandboxed:true,allowUnsandboxedCommands:false,excludedCommands:exclude?patterns:[]},permissions:{allow:[...patterns.map(p=>`Bash(${p})`),...(allowProbe?[`Bash(${command})`]:[])]}};
  const settingsFile=join(configHome,'settings.json');writeFileSync(settingsFile,JSON.stringify(settings));
  let result, calls=0, error;
  const server=createServer(async(req,res)=>{
    try {
      let body='';for await(const b of req)body+=b;
      if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'}).end('{"input_tokens":10}');return;}
      if(!req.url.includes('/messages')){res.writeHead(404).end();return;}
      const input=JSON.parse(body);
      for(const m of input.messages??[])for(const c of Array.isArray(m.content)?m.content:[])if(c.type==='tool_result'&&c.tool_use_id==='tool_fixture')result=c;
      // Ignore auxiliary requests which cannot execute the Bash fixture.
      const runnable=input.tools?.some(t=>t.name==='Bash');
      const call=runnable&&!result&&calls++===0;
      const content=call?{type:'tool_use',id:'tool_fixture',name:'Bash',input:{command,timeout:120000,description:'Isolated Fleet permission fixture'}}:{type:'text',text:'Fixture complete.'};
      const message={id:'msg_fixture',type:'message',role:'assistant',model:input.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}};
      if(!input.stream){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({...message,content:[content],stop_reason:call?'tool_use':'end_turn'}));return;}
      res.writeHead(200,{'content-type':'text/event-stream'});
      const emit=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify({type:event,...data})}\n\n`);
      emit('message_start',{message});
      emit('content_block_start',{index:0,content_block:call?{...content,input:{}}:{type:'text',text:''}});
      emit('content_block_delta',{index:0,delta:call?{type:'input_json_delta',partial_json:JSON.stringify(content.input)}:{type:'text_delta',text:content.text}});
      emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:call?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:20}});emit('message_stop',{});res.end();
    }catch(e){error=e;res.writeHead(500).end(String(e));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  // Fresh HOME/settings, fake key and local endpoint prevent production auth/state use.
  const launchEnv={PATH:env.PATH,HOME:root,CLAUDE_CONFIG_DIR:configHome,ANTHROPIC_API_KEY:'fixture-unused',ANTHROPIC_AUTH_TOKEN:'',CLAUDE_CODE_OAUTH_TOKEN:'',CLAUDE_CODE_USE_BEDROCK:'0',CLAUDE_CODE_USE_VERTEX:'0',CLAUDE_CODE_USE_FOUNDRY:'0',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',...Object.fromEntries(Object.entries(env).filter(([k])=>k.startsWith('OURS_')))};
  let child,session,timer,log='';
  try{
    if(process.env.FLEET_TEST_SESSION==='claude-acp'){
      const adapter=makeClaudeCodeAdapter(undefined, options => AcpSession.start({...options, inheritEnvironment:false}));
      const stateDir=join(root,'claude-session-'+randomUUID());mkdirSync(stateDir);
      const role={name:'Fixture',identity:'Fixture',harness:'claude-code',session:'acp',sourceFile:'fixture',
        model:'claude-sonnet-4-6',permissions:{approval:'auto',filesystem:'workspace',unattended:'deny'},env:launchEnv};
      // pretrust runs in the host process; keep its home private as well.
      const oldHome=process.env.HOME;let prep;
      try{process.env.HOME=root;prep=await adapter.prepareSession(role,{stateDir,runCwd:cwd});}
      finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;}
      prep.env={...prep.env,...launchEnv,CLAUDE_CODE_EXECUTABLE:claude};prep.settingsOverlay=settingsFile;
      const launch=adapter.agentSession.prepareLaunch(role,prep);
      session=await adapter.agentSession.start({role,prep,launch,cwd,stateDir,mode:'fresh',permissions:role.permissions,
        permissionMode:adapter.effectivePermissionMode(role),log:line=>{log+=line+'\n';}});
      timer=setTimeout(()=>session.close(),120000);
      const outcome=await session.submitPrompt('Run the isolated Fleet fixture command.');
      assert.equal(outcome.succeeded,true,JSON.stringify(outcome)+log);
    }else{
      child=spawn(claude,['-p','--verbose','--output-format','stream-json','--permission-mode','acceptEdits','--settings',settingsFile,'--setting-sources','user','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--','Run the isolated Fleet fixture command.'],{cwd,env:launchEnv,stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
      timer=setTimeout(()=>child.kill('SIGKILL'),120000);
      await new Promise((r,j)=>{child.once('close',r);child.once('error',j);});
      assert.equal(child.exitCode,0,log);
    }
    assert.ifError(error);assert(result,'No real Bash result: '+log);
    const output=typeof result.content==='string'?result.content:JSON.stringify(result.content);
    return {exitCode:result.is_error?1:0,output};
  }finally{clearTimeout(timer);await session?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
