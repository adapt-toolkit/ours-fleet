import {afterEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse,stringify} from 'yaml';
import {loadConfig,splitRootFor} from '../../src/config.js';
import {ensureMinimalSetup} from '../../src/minimal-setup.js';
import {checkWorkspaceConfiguration,enrollWorkspace,removeEnrollmentContact,type AttachDaemonClient,type WorkspacePayload} from '../../src/workspace-enrollment.js';
import {WebAccessStore} from '../../src/web/access.js';

// The person's own Messenger identity is reported in mixed case; the daemon lists it in upper case.
const ROOT='A'.repeat(64),CHILD='c0FFee'+'d'.repeat(58),SERVER='B'.repeat(64);
const undo:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const step of undo.splice(0).reverse())await step();});

type Row=Record<string,unknown>;
const tree=():Row[]=>[{name:'alice@home',cid:ROOT,kind:'root',temp:null,session:null},{name:'Alice Tester',cid:CHILD.toUpperCase(),kind:'role',temp:null,session:'other-live'},{name:'Developer',cid:'E'.repeat(64),kind:'role',temp:null,session:null}];

/** A host whose Messenger runs as the person's own identity, and a daemon that records what is done as the root. */
async function host(rows:Row[]=tree()) {
  const dir=mkdtempSync(join(tmpdir(),'fleet-child-')),prior={...process.env};
  const messenger:Array<{path:string;body?:unknown}>=[];const daemon:Array<[string,unknown?]>=[];
  const behaviour={choose:():unknown=>({name:'alice@home',cid:ROOT,switchedFrom:null}),peer:SERVER,contacts:[SERVER],sent:true,messengerCid:CHILD,messengerRoot:ROOT.toLowerCase() as string|undefined,releaseFailed:0,preserveProfile:true};
  const server:Server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');const path=new URL(req.url!,'http://host').pathname.replace(/^\/messenger\/api\//,'');
    if(req.method==='GET'){messenger.push({path});
      if(path==='contacts'){res.end(JSON.stringify({contacts:behaviour.contacts.map(container_id=>({container_id})),pending:[]}));return;}
      // Messenger names the root the daemon describes for the identity it runs as.
      res.end(JSON.stringify({cid:behaviour.messengerCid,rootCid:behaviour.messengerRoot,...(behaviour.preserveProfile?{preserveProfile:true}:{})}));return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);messenger.push({path,body:JSON.parse(Buffer.concat(chunks).toString())});
    res.end(JSON.stringify(path==='invites'?{blob:'fixture-child-public-invite'}:path==='workspace/unregister'?{submitted:true,rootCid:behaviour.messengerCid}:path==='contacts/add'?{cid:behaviour.peer}:{}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  undo.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);rmSync(dir,{recursive:true,force:true});});
  for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH'])delete process.env[key];process.env.OURS_FLEET_HOME=dir;
  const endpoint='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const credential=join(dir,'credential');writeFileSync(credential,'fixture-credential',{mode:0o600});
  const profile=join(dir,'profile.json');writeFileSync(profile,JSON.stringify({serverUrl:endpoint,endpoint:endpoint+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
  new WebAccessStore().write({version:1,mode:'pairing'});
  const attach=(async(options:{leaseToken?:string})=>{daemon.push(['attach',options.leaseToken]);return {
    async listIdentities(){daemon.push(['listIdentities']);return rows;},
    chooseIdentity(args:unknown){daemon.push(['chooseIdentity',args]);try{return Promise.resolve(behaviour.choose());}catch(error){return Promise.reject(error);}},
    async addContact(args:unknown){daemon.push(['addContact',args]);return {cid:behaviour.peer};},
    async listContacts(){daemon.push(['listContacts']);return {contacts:behaviour.contacts.map(container_id=>({container_id}))};},
    async sendCommand(args:unknown){daemon.push(['sendCommand',args]);return {sent:behaviour.sent};},
    async removeContact(args:unknown){daemon.push(['removeContact',args]);return {};},
    async releaseLease(){daemon.push(['releaseLease']);return {released:1,failed:behaviour.releaseFailed};},
    async close(){daemon.push(['close']);},
  };}) as unknown as AttachDaemonClient;
  const config=join(dir,'fleet.yaml'),workspace=join(dir,'.ours-fleet','workspace'),invite=join(workspace,'owner.invite');
  const payload:WorkspacePayload={version:1,appOrigin:'https://app.ours-tunnel.com',hostname:'alice-home.ours-tunnel.com',rootName:'alice@home',name:'Alice',surname:'Tester',connectorToken:'fixture-scoped',invitation:'fixture-invite',serverCid:SERVER.toLowerCase(),challenge:{nonce:'n'.repeat(43),accountId:'c'.repeat(43),workspaceId:'w'.repeat(43),expiresAt:Date.now()+600000}};
  const did=(name:string)=>daemon.filter(([call])=>call===name);
  const posted=(path:string)=>messenger.filter(call=>call.path===path && call.body!==undefined);
  return {dir,config,workspace,invite,payload,messenger,daemon,behaviour,attach,did,posted,enroll:(extra:Parameters<typeof enrollWorkspace>[2]={})=>enrollWorkspace(payload,config,{preserveProfile:true,attach,contactWaitMs:300,...extra})};
}
/** A configured host that was enrolled while Messenger still ran as the Human root. */
const enrolledAsRoot=(h:Awaited<ReturnType<typeof host>>,owner:Record<string,unknown>={},binding:Record<string,unknown>={})=>{
  mkdirSync(h.workspace,{recursive:true,mode:0o700});writeFileSync(h.invite,'fixture-root-public-invite\n',{mode:0o600});
  writeFileSync(join(h.workspace,'binding.json'),JSON.stringify({workspaceId:'w'.repeat(43),hostWorkspaceId:'h'.repeat(43),appOrigin:'https://app.ours-tunnel.com',serverCid:SERVER,...binding}),{mode:0o600});
  writeFileSync(h.config,'api_version: ours.network/fleet/v2\n\n# kept comment\nvars:\n  kept: value\n'+stringify({rooms:{owner:{provider:'messenger-server',expected_cid:ROOT,public_invite_file:h.invite,role:'Owner',...owner},defaults:{attach_owner:true,close_when_task_done:true}}}),{mode:0o600});
  mkdirSync(join(splitRootFor(h.config),'agents'),{recursive:true,mode:0o700});
};

describe('tunnel setup when Messenger runs as the person\'s own identity under the Human root',()=>{
  it('binds the workspace with the root and makes the person\'s identity the room Owner',async()=>{
    const h=await host();await checkWorkspaceConfiguration(h.config,h.attach);await ensureMinimalSetup(h.config);
    const result=await h.enroll();
    expect(result.rootCid).toBe(ROOT);
    // The root signs the same binding command Messenger sends when it is the root, and is given back.
    expect(h.did('chooseIdentity')).toEqual([['chooseIdentity',{name:'alice@home',force:false}]]);
    expect(h.did('addContact')).toEqual([['addContact',{invite:'fixture-invite'}]]);
    expect(h.did('sendCommand')).toEqual([['sendCommand',{contact:SERVER,command:'bind-workspace',arguments:{type:'ours.app.bind-workspace.v1',accountId:'c'.repeat(43),workspaceId:'w'.repeat(43),nonce:'n'.repeat(43),hostWorkspaceId:result.hostWorkspaceId}}]]);
    expect(h.did('releaseLease')).toHaveLength(1);expect(h.did('close')).toHaveLength(h.did('attach').length);
    expect(h.daemon.findIndex(([call])=>call==='releaseLease')).toBeGreaterThan(h.daemon.findIndex(([call])=>call==='sendCommand'));
    // Messenger is asked only who it is and for the Owner invitation; it never sends the binding.
    expect(h.posted('workspace/enroll')).toEqual([]);expect(h.posted('invites')).toEqual([{path:'invites',body:{mode:'public'}}]);
    expect(readFileSync(h.invite,'utf8')).toBe('fixture-child-public-invite\n');
    const loaded=loadConfig(h.config,{yamlMode:'strict'});
    expect(loaded.rooms?.owner.expected_cid.toLowerCase()).toBe(CHILD.toLowerCase());expect(loaded.rooms?.owner.expected_cid.toLowerCase()).not.toBe(ROOT.toLowerCase());
    expect(loaded.ownerInvite).toBe('fixture-child-public-invite');
    // Running setup again keeps the same Owner and configuration.
    const settled=readFileSync(h.config,'utf8');await checkWorkspaceConfiguration(h.config,h.attach);
    expect((await h.enroll()).rootCid).toBe(ROOT);expect(readFileSync(h.config,'utf8')).toBe(settled);expect(h.did('releaseLease')).toHaveLength(2);
  });

  const notUnderRoot:Array<[string,Row[]]>=[
    ['an identity the daemon does not list',tree().filter(row=>row.name!=='Alice Tester')],
    ['a temporary identity',tree().map(row=>row.name==='Alice Tester'?{...row,temp:{state:'other-live',ownerPid:1}}:row)],
    ['a quarantined identity',tree().map(row=>row.name==='Alice Tester'?{name:'Alice Tester',status:'awaiting-root'}:row)],
    ['a host without a Human root',tree().filter(row=>row.kind!=='root')],
    ['a second root rather than a role',tree().map(row=>row.name==='Alice Tester'?{...row,kind:'root'}:row).filter(row=>row.name!=='alice@home')],
    ['two Human roots beside the identity',[...tree(),{name:'other@host',cid:'9'.repeat(64),kind:'root',temp:null,session:null}]],
    ['a host whose only root is not the one Messenger names',tree().map(row=>row.kind==='root'?{...row,cid:'9'.repeat(64)}:row)],
  ];
  it.each(notUnderRoot)('refuses %s as the Messenger identity and changes nothing',async(_name,rows)=>{
    const h=await host(rows);await ensureMinimalSetup(h.config);const before=readFileSync(h.config,'utf8');
    await expect(h.enroll()).rejects.toThrow(/not a permanent identity under this host's Human root/);
    expect(h.did('chooseIdentity')).toEqual([]);expect(h.posted('invites')).toEqual([]);expect(h.did('close')).toHaveLength(h.did('attach').length);
    expect(readFileSync(h.config,'utf8')).toBe(before);expect(existsSync(h.invite)).toBe(false);expect(existsSync(join(h.workspace,'binding.json'))).toBe(false);
  });

  const failures:Array<[string,(h:Awaited<ReturnType<typeof host>>)=>void,RegExp]>=[
    ['the root is held by another session',h=>{h.behaviour.choose=()=>{throw Object.assign(Error('held'),{code:'IDENTITY_IN_USE'});};},/Human root cannot be used right now \(IDENTITY_IN_USE\)/],
    ['the daemon binds another root',h=>{h.behaviour.choose=()=>({name:'alice@home',cid:'F'.repeat(64),switchedFrom:null});},/Human root changed/],
    ['the invitation belongs to another server',h=>{h.behaviour.peer='F'.repeat(64);},/Enrollment server identity mismatch/],
    ['the binding is not sent',h=>{h.behaviour.sent=false;},/Workspace proof was not sent/],
  ];
  it('refuses a Messenger that names itself or nothing usable as its root',async()=>{
    for(const named of [CHILD,'not-a-cid','']){
      const h=await host();await ensureMinimalSetup(h.config);const before=readFileSync(h.config,'utf8');h.behaviour.messengerRoot=named;
      await expect(h.enroll()).rejects.toThrow();expect(h.did('chooseIdentity')).toEqual([]);expect(readFileSync(h.config,'utf8')).toBe(before);
    }
  });

  it('requires the profile-preservation answer from Messenger for an existing host',async()=>{
    const h=await host();await ensureMinimalSetup(h.config);h.behaviour.preserveProfile=false;
    await expect(h.enroll()).rejects.toThrow('requires Messenger profile-preservation support');expect(h.did('chooseIdentity')).toEqual([]);
  });

  it('gives the root back when the enrollment contact does not appear in time',async()=>{
    const h=await host();await ensureMinimalSetup(h.config);const before=readFileSync(h.config,'utf8');h.behaviour.contacts=[];
    await expect(h.enroll()).rejects.toThrow('Enrollment contact is not ready');
    expect(h.did('listContacts').length).toBeGreaterThan(1);expect(h.did('sendCommand')).toEqual([]);expect(h.did('releaseLease')).toHaveLength(1);
    expect(h.posted('invites')).toEqual([]);expect(readFileSync(h.config,'utf8')).toBe(before);expect(existsSync(h.invite)).toBe(false);
  });

  it('tries to give the root back exactly once, and reports what failed first',async()=>{
    const h=await host();await ensureMinimalSetup(h.config);const before=readFileSync(h.config,'utf8');
    const rejecting=(async(options:Parameters<AttachDaemonClient>[0])=>{const client=await h.attach(options);return {...client,async releaseLease(){await client.releaseLease();throw Error('release refused');}};}) as unknown as AttachDaemonClient;
    // The release itself fails after a successful proof: that failure is the one reported, and it is not retried.
    await expect(h.enroll({attach:rejecting})).rejects.toThrow('release refused');expect(h.did('releaseLease')).toHaveLength(1);
    // The proof fails and the release fails too: the proof failure is reported, after one release attempt.
    h.behaviour.sent=false;await expect(h.enroll({attach:rejecting})).rejects.toThrow('Workspace proof was not sent');expect(h.did('releaseLease')).toHaveLength(2);
    expect(h.did('close')).toHaveLength(h.did('attach').length);expect(readFileSync(h.config,'utf8')).toBe(before);expect(existsSync(h.invite)).toBe(false);
  });

  it('does not report setup done while the root may still be held',async()=>{
    const h=await host();await ensureMinimalSetup(h.config);const before=readFileSync(h.config,'utf8');h.behaviour.releaseFailed=1;
    await expect(h.enroll()).rejects.toThrow('Human root was not given back completely');
    expect(h.did('releaseLease')).toHaveLength(1);expect(h.did('close')).toHaveLength(h.did('attach').length);
    expect(h.posted('invites')).toEqual([]);expect(readFileSync(h.config,'utf8')).toBe(before);expect(existsSync(h.invite)).toBe(false);expect(existsSync(join(h.workspace,'binding.json'))).toBe(false);
  });

  it.each(failures)('gives the root back and changes nothing when %s',async(_name,arrange,message)=>{
    const h=await host();await ensureMinimalSetup(h.config);const before=readFileSync(h.config,'utf8');arrange(h);
    await expect(h.enroll()).rejects.toThrow(message);
    expect(h.did('releaseLease')).toHaveLength(1);expect(h.did('close')).toHaveLength(h.did('attach').length);
    expect(h.posted('invites')).toEqual([]);expect(readFileSync(h.config,'utf8')).toBe(before);expect(existsSync(h.invite)).toBe(false);expect(existsSync(join(h.workspace,'binding.json'))).toBe(false);
  });

  it('records nothing when Messenger changes identity while setup runs',async()=>{
    const h=await host();await ensureMinimalSetup(h.config);const before=readFileSync(h.config,'utf8');
    const attach=(async(options:Parameters<AttachDaemonClient>[0])=>{const client=await h.attach(options);return {...client,async sendCommand(args:never){h.behaviour.messengerCid='E'.repeat(64);return client.sendCommand(args);}};}) as unknown as AttachDaemonClient;
    await expect(enrollWorkspace(h.payload,h.config,{preserveProfile:true,attach})).rejects.toThrow(/Messenger identity changed while setup was running/);
    expect(readFileSync(h.config,'utf8')).toBe(before);expect(existsSync(h.invite)).toBe(false);
  });

  it('moves the managed Owner entry of a host enrolled as the root to the person\'s identity, and only that entry',async()=>{
    const h=await host();enrolledAsRoot(h);const before=readFileSync(h.config,'utf8');
    await checkWorkspaceConfiguration(h.config,h.attach);expect(readFileSync(h.config,'utf8')).toBe(before);
    await h.enroll();
    const after=readFileSync(h.config,'utf8');
    expect(after).toContain('# kept comment');expect(parse(after)).toEqual({...parse(before),rooms:{...parse(before).rooms,owner:{...parse(before).rooms.owner,expected_cid:CHILD}}});
    expect(readFileSync(h.invite,'utf8')).toBe('fixture-child-public-invite\n');
    // Once moved, another run changes nothing.
    await h.enroll();expect(readFileSync(h.config,'utf8')).toBe(after);
    expect(JSON.parse(readFileSync(join(h.workspace,'binding.json'),'utf8')).proofRootCid).toBe(ROOT);
  });

  it('finishes a move that stopped between the invitation and the Owner entry on the next run',async()=>{
    const h=await host();enrolledAsRoot(h);const before=readFileSync(h.config,'utf8');
    // The invitation and the entry are two files. Stop after the first: the entry still names the root.
    await expect(h.enroll({afterInvitation(){throw Error('stopped here');}})).rejects.toThrow('stopped here');
    expect(readFileSync(h.invite,'utf8')).toBe('fixture-child-public-invite\n');expect(readFileSync(h.config,'utf8')).toBe(before);
    // That is the same recognised case again, so setup can simply be run once more.
    await checkWorkspaceConfiguration(h.config,h.attach);await h.enroll();
    expect(parse(readFileSync(h.config,'utf8')).rooms.owner.expected_cid).toBe(CHILD);expect(readFileSync(h.invite,'utf8')).toBe('fixture-child-public-invite\n');
    expect(loadConfig(h.config,{yamlMode:'strict'}).rooms?.owner.expected_cid.toLowerCase()).toBe(CHILD.toLowerCase());
  });

  const kept:Array<[string,(h:Awaited<ReturnType<typeof host>>)=>void]>=[
    ['an Owner entry with its own invitation file',h=>{const own=join(h.dir,'own.invite');enrolledAsRoot(h,{public_invite_file:own});writeFileSync(own,'own-invite\n',{mode:0o600});}],
    ['an Owner entry naming someone else',h=>enrolledAsRoot(h,{expected_cid:'E'.repeat(64)})],
    ['an Owner entry with another role',h=>enrolledAsRoot(h,{role:'Lead'})],
    ['a binding to another enrollment server',h=>enrolledAsRoot(h,{},{serverCid:'F'.repeat(64)})],
    ['room defaults someone changed',h=>{enrolledAsRoot(h);writeFileSync(h.config,readFileSync(h.config,'utf8').replace('close_when_task_done: true','close_when_task_done: false'),{mode:0o600});}],
    ['room defaults someone removed',h=>{enrolledAsRoot(h);writeFileSync(h.config,readFileSync(h.config,'utf8').replace(/\n\s+close_when_task_done: true/,''),{mode:0o600});}],
    ['a rooms section with more than setup writes',h=>{enrolledAsRoot(h);writeFileSync(h.config,readFileSync(h.config,'utf8')+'  provider: messenger-server\n',{mode:0o600});}],
  ];
  it.each(kept)('keeps %s exactly as it is and refuses',async(_name,arrange)=>{
    const h=await host();arrange(h);const before=readFileSync(h.config,'utf8'),invite=readFileSync(h.invite,'utf8');
    await expect(h.enroll()).rejects.toThrow();
    expect(h.did('sendCommand')).toEqual([]);expect(h.posted('invites')).toEqual([]);
    expect(readFileSync(h.config,'utf8')).toBe(before);expect(readFileSync(h.invite,'utf8')).toBe(invite);
  });

  it('removes the enrollment contact from the root that sent the binding, not from Messenger',async()=>{
    const h=await host();enrolledAsRoot(h,{},{proofRootCid:ROOT});
    expect(await removeEnrollmentContact(h.attach)).toBe(true);
    expect(h.did('chooseIdentity')).toEqual([['chooseIdentity',{name:'alice@home',force:false}]]);
    expect(h.did('removeContact')).toEqual([['removeContact',{contact:SERVER}]]);expect(h.did('releaseLease')).toHaveLength(1);
    expect(h.posted('contacts/remove')).toEqual([]);
    h.behaviour.choose=()=>{throw Object.assign(Error('held'),{code:'IDENTITY_IN_USE'});};
    await expect(removeEnrollmentContact(h.attach)).rejects.toThrow('the Human root did not remove it');expect(h.did('releaseLease')).toHaveLength(2);
    expect(h.messenger).toEqual([]);
  });

  it('leaves the contact of a binding the root did not send to Messenger, as before',async()=>{
    const h=await host();enrolledAsRoot(h);
    expect(await removeEnrollmentContact(h.attach)).toBe(true);
    expect(h.posted('contacts/remove')).toEqual([{path:'contacts/remove',body:{contact:SERVER}}]);expect(h.daemon).toEqual([]);
  });
});

describe('signed registration retirement from an existing installation',()=>{
  it.each([404,'legacy'])('refuses replacement preparation against %s receipts without consuming an invitation or saving recovery',async version=>{
    const {beginWorkspaceReplacement}=await import('../../src/workspace-replacement.js');const {unregisterWorkspace}=await import('../../src/workspace-enrollment.js');
    const h=await host();await ensureMinimalSetup(h.config);await h.enroll();const before=readFileSync(join(h.workspace,'binding.json'),'utf8'),previous=JSON.parse(before),sent=h.did('sendCommand').length,contacts=h.did('addContact').length;
    h.payload.challenge.workspaceId='r'.repeat(43);
    const request=(async()=>version===404?new Response(null,{status:404}):Response.json({deleted:false,retired:false})) as typeof fetch;
    await expect(beginWorkspaceReplacement(previous,h.payload,h.config,{attach:h.attach,preflight:(a,b,c,d,opts)=>unregisterWorkspace(a,b,c,d,{...opts,request})})).rejects.toThrow('does not support replacing');
    expect(existsSync(join(h.workspace,'replacement.json'))).toBe(false);expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toBe(before);expect(h.did('sendCommand')).toHaveLength(sent);expect(h.did('addContact')).toHaveLength(contacts);
  });
  it('waits for signed absence confirmation when the migrated service has no old registration',async()=>{
    const {unregisterWorkspace}=await import('../../src/workspace-enrollment.js');const h=await host();await ensureMinimalSetup(h.config);await h.enroll();
    const previous=JSON.parse(readFileSync(join(h.workspace,'binding.json'),'utf8')),before=readFileSync(join(h.workspace,'binding.json'),'utf8');
    h.payload.challenge.workspaceId='r'.repeat(43);
    const sent=h.did('sendCommand').length;let polls=0;
    const request=(async()=>{
      expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toBe(before);
      if(++polls===1)return new Response(null,{status:404});
      expect(h.did('sendCommand')).toHaveLength(sent+1);
      return new Response(JSON.stringify({deleted:true,retired:true}));
    }) as typeof fetch;
    expect(await unregisterWorkspace(previous,h.payload,'q'.repeat(43),h.attach,{request,waitMs:1000})).toBe(ROOT);
    expect(polls).toBe(2);
    expect(h.did('sendCommand').at(-1)?.[1]).toMatchObject({contact:SERVER,command:'unregister-workspace',arguments:{workspaceId:previous.workspaceId,hostWorkspaceId:previous.hostWorkspaceId,replacement:{workspaceId:'r'.repeat(43)}}});
    expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toBe(before);
  });
  it('uses the bound Messenger root without taking a second root lease',async()=>{
    const {unregisterWorkspace}=await import('../../src/workspace-enrollment.js');const h=await host();await ensureMinimalSetup(h.config);const installed=await h.enroll();
    const previous=JSON.parse(readFileSync(join(h.workspace,'binding.json'),'utf8'));h.behaviour.messengerCid=ROOT;h.behaviour.messengerRoot=undefined;
    h.payload.challenge.workspaceId='r'.repeat(43);h.behaviour.contacts=[];
    const choices=h.did('chooseIdentity').length,releases=h.did('releaseLease').length;
    h.behaviour.choose=()=>{throw Error('Root lease held by Messenger');};
    let polls=0;const request=(async()=>new Response(JSON.stringify(++polls===1?{deleted:false,retired:false}:{deleted:true,retired:true}))) as typeof fetch;
    // The root-held Messenger answers with its ready pinned contact after reconnect.
    const nativeFetch=globalThis.fetch;const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const response=await nativeFetch(input,init);if(String(input).endsWith('/contacts/add'))h.behaviour.contacts=[SERVER];return response;
    });undo.push(()=>spy.mockRestore());
    expect(await unregisterWorkspace(previous,h.payload,'q'.repeat(43),h.attach,{request,waitMs:1000})).toBe(ROOT);
    expect(h.did('chooseIdentity')).toHaveLength(choices);expect(h.did('releaseLease')).toHaveLength(releases);
    expect(h.posted('contacts/add').at(-1)?.body).toEqual({invite:'fixture-invite'});
    expect(h.posted('workspace/unregister').at(-1)?.body).toEqual({serverCid:SERVER,rootCid:ROOT,type:'ours.app.unregister-workspace.v1',workspaceId:previous.workspaceId,hostWorkspaceId:installed.hostWorkspaceId,operationNonce:'q'.repeat(43),replacement:{workspaceId:'r'.repeat(43),accountId:'c'.repeat(43),nonce:'n'.repeat(43)}});
  });
  it('signs an exact same-service replacement challenge and reuses the ready contact for proof',async()=>{
    const {unregisterWorkspace}=await import('../../src/workspace-enrollment.js');const h=await host();await ensureMinimalSetup(h.config);await h.enroll();
    const previous=JSON.parse(readFileSync(join(h.workspace,'binding.json'),'utf8'));
    h.payload.challenge={...h.payload.challenge,workspaceId:'r'.repeat(43),nonce:'s'.repeat(43)};
    let polls=0;const request=(async()=>new Response(JSON.stringify(++polls===1?{deleted:false,retired:false}:{deleted:true,retired:true}))) as typeof fetch;
    await unregisterWorkspace(previous,h.payload,'q'.repeat(43),h.attach,{request,waitMs:1000});
    expect(h.did('sendCommand').at(-1)?.[1]).toEqual({contact:SERVER,command:'unregister-workspace',arguments:{type:'ours.app.unregister-workspace.v1',workspaceId:previous.workspaceId,hostWorkspaceId:previous.hostWorkspaceId,operationNonce:'q'.repeat(43),replacement:{workspaceId:'r'.repeat(43),accountId:'c'.repeat(43),nonce:'s'.repeat(43)}}});
    const nativeFetch=globalThis.fetch;
    const spy=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input)===h.payload.appOrigin+'/account-api/workspace-proof'?Promise.resolve(new Response(JSON.stringify({verified:false}))):nativeFetch(input,init));
    undo.push(()=>spy.mockRestore());
    const invitationCount=h.did('addContact').length;
    const attach=(async(options:Parameters<AttachDaemonClient>[0])=>{const client=await h.attach(options);return {...client,async addContact(){throw Error('One-time invitation already consumed');}};}) as AttachDaemonClient;
    const result=await h.enroll({replacingWorkspace:previous.workspaceId,attach});
    expect(result.rootCid).toBe(ROOT);expect(h.did('addContact')).toHaveLength(invitationCount);
    expect(h.did('sendCommand').at(-1)?.[1]).toMatchObject({command:'bind-workspace',arguments:{workspaceId:'r'.repeat(43),nonce:'s'.repeat(43),hostWorkspaceId:previous.hostWorkspaceId}});
    expect(JSON.parse(readFileSync(join(h.workspace,'binding.json'),'utf8')).workspaceId).toBe('r'.repeat(43));
  });
  it('does not authorize a replacement challenge at a different account service',async()=>{
    const {unregisterWorkspace}=await import('../../src/workspace-enrollment.js');const h=await host();await ensureMinimalSetup(h.config);await h.enroll();
    const previous=JSON.parse(readFileSync(join(h.workspace,'binding.json'),'utf8'));h.payload.appOrigin='https://app.ours.network';h.payload.challenge.workspaceId='r'.repeat(43);
    let polls=0;const request=(async()=>new Response(JSON.stringify(++polls===1?{deleted:false,retired:false}:{deleted:true,retired:true}))) as typeof fetch;
    await unregisterWorkspace(previous,h.payload,'q'.repeat(43),h.attach,{request,waitMs:1000});
    expect((h.did('sendCommand').at(-1)?.[1] as {arguments:object}).arguments).not.toHaveProperty('replacement');
  });
  it('signs only the original workspace/host, releases the root, and waits for exact retirement',async()=>{
    const {unregisterWorkspace}=await import('../../src/workspace-enrollment.js');const h=await host();await ensureMinimalSetup(h.config);await h.enroll();
    const previous=JSON.parse(readFileSync(join(h.workspace,'binding.json'),'utf8'));const before=readFileSync(join(h.workspace,'binding.json'),'utf8');
    let polls=0;const receipts:Array<Record<string,unknown>>=[];
    const request=(async(url:string,init:RequestInit)=>{expect(url).toBe(h.payload.appOrigin+'/account-api/workspace-unregister-receipt');receipts.push(JSON.parse(init.body as string));return new Response(JSON.stringify(++polls===1?{deleted:false,retired:false}:{deleted:true,retired:true}));}) as typeof fetch;
    expect(await unregisterWorkspace(previous,h.payload,'q'.repeat(43),h.attach,{request,waitMs:1000})).toBe(ROOT);
    expect(h.did('sendCommand').at(-1)).toEqual(['sendCommand',{contact:SERVER,command:'unregister-workspace',arguments:{type:'ours.app.unregister-workspace.v1',workspaceId:previous.workspaceId,hostWorkspaceId:previous.hostWorkspaceId,operationNonce:'q'.repeat(43)}}]);
    expect(receipts).toHaveLength(2);expect(receipts[0]).toEqual({workspaceId:previous.workspaceId,hostWorkspaceId:previous.hostWorkspaceId,operationNonce:'q'.repeat(43),rootCid:ROOT});
    expect(h.did('releaseLease')).toHaveLength(2);expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toBe(before);
  });
  it('retries a completed remote retirement without resending the signed command or redeeming an invitation',async()=>{
    const {unregisterWorkspace}=await import('../../src/workspace-enrollment.js');const h=await host();await ensureMinimalSetup(h.config);await h.enroll();const previous=JSON.parse(readFileSync(join(h.workspace,'binding.json'),'utf8'));const commands=h.did('sendCommand').length,contacts=h.did('addContact').length;
    const request=(async()=>new Response(JSON.stringify({deleted:true,retired:true}))) as typeof fetch;
    expect(await unregisterWorkspace(previous,h.payload,'q'.repeat(43),h.attach,{request})).toBe(ROOT);expect(h.did('sendCommand')).toHaveLength(commands);expect(h.did('addContact')).toHaveLength(contacts);
  });
  it('refuses mismatched host/root and unavailable original server without local cleanup',async()=>{
    const {unregisterWorkspace}=await import('../../src/workspace-enrollment.js');const h=await host();await ensureMinimalSetup(h.config);await h.enroll();const previous=JSON.parse(readFileSync(join(h.workspace,'binding.json'),'utf8'));const request=(async()=>new Response(JSON.stringify({deleted:false,retired:false}))) as typeof fetch;
    await expect(unregisterWorkspace({...previous,hostWorkspaceId:'x'.repeat(43)},h.payload,'q'.repeat(43),h.attach,{request})).rejects.toThrow('host ID differs');
    await expect(unregisterWorkspace({...previous,proofRootCid:'f'.repeat(64)},h.payload,'q'.repeat(43),h.attach,{request})).rejects.toThrow('proof root differs');
    h.behaviour.contacts=[];await expect(unregisterWorkspace(previous,{...h.payload,serverCid:'f'.repeat(64)},'q'.repeat(43),h.attach,{request})).rejects.toThrow('Original enrollment server contact is unavailable');expect(h.did('sendCommand')).toHaveLength(1);expect(existsSync(join(h.workspace,'connector'))).toBe(true);
  });
});


describe('credential-free same-registration renewal',()=>{
  it('keeps the existing private connector byte-identical while renewing root proof',async()=>{
    const h=await host();await ensureMinimalSetup(h.config);await h.enroll();
    const connector=join(h.workspace,'connector'),before=readFileSync(connector,'utf8');
    delete h.payload.connectorToken;
    await h.enroll();expect(readFileSync(connector,'utf8')).toBe(before);
  });
  it('refuses missing credentials on initial setup, a different target or an unsafe retained file before sends or writes',async()=>{
    const h=await host();await ensureMinimalSetup(h.config);const token=h.payload.connectorToken;delete h.payload.connectorToken;
    await expect(h.enroll()).rejects.toThrow('remove and re-create');expect(h.did('sendCommand')).toEqual([]);expect(h.posted('workspace/enroll')).toEqual([]);
    h.payload.connectorToken=token;await h.enroll();const binding=readFileSync(join(h.workspace,'binding.json'),'utf8'),sent=h.did('sendCommand').length;
    delete h.payload.connectorToken;h.payload.challenge.workspaceId='r'.repeat(43);
    await expect(h.enroll({replacingWorkspace:JSON.parse(binding).workspaceId})).rejects.toThrow('remove and re-create');expect(h.did('sendCommand')).toHaveLength(sent);
    h.payload.challenge.workspaceId=JSON.parse(binding).workspaceId;
    chmodSync(join(h.workspace,'connector'),0o644);await expect(h.enroll()).rejects.toThrow('remove and re-create');
    expect(readFileSync(join(h.workspace,'binding.json'),'utf8')).toBe(binding);expect(h.did('sendCommand')).toHaveLength(sent);
  });
});
