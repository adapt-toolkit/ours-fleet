import { describe, it, expect } from 'vitest';
import { redeemTunnelSetup, readTunnelSetupStdin, readTunnelSetupArgument, inspectTunnelSetup, verifyTunnelSetupTarget } from '../src/tunnel-setup-input.js';
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const payload={version:1,appOrigin:'https://app.ours.network',hostname:'home.ours-tunnel.com',rootName:'human@home',name:'Name',surname:'Surname',connectorToken:'connector-secret',invitation:'invite-secret',serverCid:'A'.repeat(64),challenge:{nonce:'n'.repeat(43),workspaceId:'w'.repeat(43),accountId:'a'.repeat(43),expiresAt:Date.now()+600000}};
const grant={version:2,appOrigin:payload.appOrigin,code:'c'.repeat(43),expiresAt:Date.now()+600000};
describe('tunnel setup input',()=>{
  it('accepts only minimal v2 arguments and never echoes rejected input',()=>{
    expect(readTunnelSetupArgument(encode(grant))).toBe(encode(grant));
    for(const value of [payload,{...grant,expiresAt:0},{...grant,appOrigin:'https://evil.example'},{...grant,connectorToken:'long-lived-secret'},null]){
      const input=encode(value);let message='';try{readTunnelSetupArgument(input);}catch(error){message=(error as Error).message;}
      expect(message).toMatch(/invalid|expired/i);expect(message).not.toContain(input);expect(message).not.toContain('long-lived-secret');
    }
  });
  it('redeems a minimal grant over POST body without credentials in URL',async()=>{
    const calls:any[]=[];
    const result=await redeemTunnelSetup(encode(grant),(async(url:any,init:any)=>{calls.push([url,init]);return new Response(JSON.stringify({payload:encode(payload)}));}) as typeof fetch);
    expect(result).toEqual(payload);expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(grant.appOrigin+'/account-api/workspace-install-redeem');
    expect(calls[0][1]).toMatchObject({method:'POST',redirect:'error',credentials:'omit',body:JSON.stringify({code:grant.code})});
  });
  it('keeps legacy input and refuses invalid/expired grants before network',async()=>{
    expect(await redeemTunnelSetup(encode(payload))).toEqual(payload);
    for(const value of [{...grant,expiresAt:0},{...grant,appOrigin:'https://evil.example'},{...grant,code:'bad'},null])await expect(redeemTunnelSetup(encode(value),async()=>{throw Error('NETWORK MUST NOT RUN');})).rejects.toThrow(/invalid|expired/i);
  });
  it('refuses replay, redirects, mismatched origin and malformed answers without leaking credentials',async()=>{
    await expect(redeemTunnelSetup(encode(grant),(async()=>new Response('',{status:410})) as typeof fetch)).rejects.toThrow(/already used/);
    await expect(redeemTunnelSetup(encode(grant),(async()=>{throw Error(grant.code);}) as typeof fetch)).rejects.toThrow('Could not reach');
    await expect(redeemTunnelSetup(encode(grant),(async()=>new Response(JSON.stringify({payload:encode({...payload,appOrigin:'https://app.ours-tunnel.com'})}))) as typeof fetch)).rejects.toThrow(/origin mismatch/);
  });
  it('inspects a grant without redeeming and rejects changed targets before any setup',async()=>{
    const calls:string[]=[];const target=await inspectTunnelSetup(encode(grant),(async(url:string)=>{calls.push(url);return new Response(JSON.stringify({workspaceId:payload.challenge.workspaceId,serverCid:payload.serverCid}));}) as typeof fetch);
    expect(calls).toEqual([grant.appOrigin+'/account-api/workspace-install-inspect']);
    expect(()=>verifyTunnelSetupTarget(target,payload)).not.toThrow();
    expect(()=>verifyTunnelSetupTarget(target,{...payload,challenge:{...payload.challenge,workspaceId:'z'.repeat(43)}})).toThrow('differs');
    for(const status of [404,405])expect(await inspectTunnelSetup(encode(grant),(async()=>new Response(null,{status})) as typeof fetch)).toBeUndefined();
    await expect(inspectTunnelSetup(encode(grant),(async()=>{throw Error(grant.code);}) as typeof fetch)).rejects.toThrow('preserved');
    await expect(inspectTunnelSetup(encode(grant),(async()=>new Response(JSON.stringify({workspaceId:payload.challenge.workspaceId,serverCid:payload.serverCid,connectorToken:'secret'}))) as typeof fetch)).rejects.toThrow('Invalid');
  });
  it('bounds stdin',async()=>{
    async function* input(){yield Buffer.from('x'.repeat(32769));}
    await expect(readTunnelSetupStdin(input())).rejects.toThrow(/too large/);
  });
});
