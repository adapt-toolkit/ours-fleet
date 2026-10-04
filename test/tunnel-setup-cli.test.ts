import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
describe('setup-tunnel positional grant CLI', () => {
  it('validates arguments before network, preflights before redeem, and never prints the grant', () => {
    const root = mkdtempSync(join(tmpdir(), 'tunnel-argument-'));
    const bin = join(root, 'bin'); mkdirSync(bin);
    const capture = join(root, 'fetch.json');
    const preload = join(root, 'capture.mjs');
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit "${FAIL_PREFLIGHT:-0}"\n', {mode: 0o700});
    writeFileSync(join(bin, 'cloudflared'), '#!/bin/sh\necho --token-file\n', {mode: 0o700});
    writeFileSync(preload, `import {writeFileSync} from 'node:fs';
      globalThis.fetch=async(url,init)=>{writeFileSync(process.env.FETCH_CAPTURE,JSON.stringify({url,init}));
      if(process.env.THROW_FETCH)throw Error(process.env.THROW_FETCH);
      return new Response('',{status:410});};`);
    const grant = {version:2, appOrigin:'https://app.ours.network', code:'c'.repeat(43), expiresAt:Date.now()+600000};
    const run = (argument: string, extra: string[] = [], env: Record<string,string> = {}) => {
      const result = spawnSync(process.execPath, ['--import', preload, resolve('dist/cli.js'), 'setup-tunnel', argument, ...extra, '--configuration', join(root,'fleet.yaml')], {
        env:{...process.env,PATH:bin,OURS_FLEET_HOME:join(root,'state'),FETCH_CAPTURE:capture,...env},encoding:'utf8',timeout:10000,
      });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
      const output=result.stdout+result.stderr;
      expect(output).not.toContain(argument);expect(output).not.toContain(grant.code);
      expect(output).not.toContain('Private single-use connection code');
      expect(existsSync(join(root,'fleet.yaml'))).toBe(false);
      expect(existsSync(join(root,'state','workspace','pending-setup.json'))).toBe(false);
      return output;
    };
    try {
      for(const invalid of [{...grant,version:1,connectorToken:'durable-secret'},{...grant,expiresAt:0},{...grant,appOrigin:'https://foreign.test'},{...grant,invitation:'durable-secret'}]) {
        expect(run(encode(invalid))).toMatch(/invalid|expired/i);expect(existsSync(capture)).toBe(false);
      }
      expect(run(encode(grant),[],{FAIL_PREFLIGHT:'1'})).toContain('Nothing was changed');
      expect(existsSync(capture)).toBe(false);
      expect(run(encode(grant),['--stdin'])).toContain('Use one payload');expect(existsSync(capture)).toBe(false);
      expect(run('--'+encode(grant))).toContain('Invalid setup-tunnel command');expect(existsSync(capture)).toBe(false);
      expect(run(encode(grant))).toContain('already used');
      const request=JSON.parse(readFileSync(capture,'utf8'));
      expect(request.url).toBe(grant.appOrigin+'/account-api/workspace-install-redeem');
      expect(request.init).toMatchObject({method:'POST',credentials:'omit',redirect:'error',body:JSON.stringify({code:grant.code})});
      expect(run(encode(grant),[],{THROW_FETCH:grant.code})).toContain('Could not reach');
    } finally { rmSync(root,{recursive:true,force:true}); }
  }, 20000);
  it('preserves an existing binding and one-use grant without explicit confirmation in a pipe',()=>{
    const root=mkdtempSync(join(tmpdir(),'tunnel-preserve-')),workspace=join(root,'state','.ours-fleet','workspace');mkdirSync(workspace,{recursive:true});
    const binding={workspaceId:'w'.repeat(43),hostWorkspaceId:'h'.repeat(43),serverCid:'a'.repeat(64),appOrigin:'https://app.ours-tunnel.com'};
    writeFileSync(join(workspace,'binding.json'),JSON.stringify(binding),{mode:0o600});writeFileSync(join(workspace,'connector'),'fixture-retained-private-token',{mode:0o600});
    const preload=join(root,'fetch.mjs'),capture=join(root,'fetch-called');writeFileSync(preload,`import {writeFileSync} from 'node:fs';globalThis.fetch=async(url)=>{writeFileSync(process.env.FETCH_CAPTURE,String(url));return new Response(null,{status:404});};`);
    const grant=encode({version:2,appOrigin:binding.appOrigin,code:'c'.repeat(43),expiresAt:Date.now()+600000});
    try{
      const result=spawnSync(process.execPath,['--import',preload,resolve('dist/cli.js'),'setup-tunnel',grant,'--configuration',join(root,'fleet.yaml')],{env:{...process.env,OURS_FLEET_HOME:join(root,'state'),FETCH_CAPTURE:capture},encoding:'utf8',timeout:10000,input:''});
      expect(result.error).toBeUndefined();expect(result.status).toBe(1);expect(result.stderr).toContain('Existing setup preserved');expect(result.stderr).toContain(binding.workspaceId);expect(result.stderr).not.toContain(grant);expect(result.stderr).not.toContain('fixture-retained-private-token');
      expect(readFileSync(capture,'utf8')).toContain('workspace-install-inspect');expect(existsSync(join(root,'fleet.yaml'))).toBe(false);expect(existsSync(join(workspace,'replacement.json'))).toBe(false);expect(readFileSync(join(workspace,'binding.json'),'utf8')).toBe(JSON.stringify(binding));expect(readFileSync(join(workspace,'connector'),'utf8')).toBe('fixture-retained-private-token');
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it('inspects same-workspace reruns without consent and rejects changed identity or dishonest metadata before mutation',()=>{
    const root=mkdtempSync(join(tmpdir(),'tunnel-inspect-')),workspace=join(root,'state','.ours-fleet','workspace'),bin=join(root,'bin');mkdirSync(workspace,{recursive:true});mkdirSync(bin);
    const binding={workspaceId:'w'.repeat(43),hostWorkspaceId:'h'.repeat(43),serverCid:'a'.repeat(64),appOrigin:'https://app.ours-tunnel.com'};
    const before=JSON.stringify(binding);writeFileSync(join(workspace,'binding.json'),before,{mode:0o600});writeFileSync(join(workspace,'connector'),'fixture-retained',{mode:0o600});
    writeFileSync(join(bin,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});writeFileSync(join(bin,'cloudflared'),'#!/bin/sh\necho --token-file\n',{mode:0o700});
    const capture=join(root,'requests.json'),preload=join(root,'fetch.mjs');
    const payload={version:1,appOrigin:binding.appOrigin,hostname:'home-test.ours-tunnel.com',rootName:'alice@home',name:'Alice',surname:'Tester',connectorToken:'fixture-new-private',invitation:'fixture-invite',serverCid:binding.serverCid,challenge:{workspaceId:'z'.repeat(43),accountId:'c'.repeat(43),nonce:'n'.repeat(43),expiresAt:Date.now()+600000}};
    writeFileSync(preload,`import {writeFileSync} from 'node:fs';const calls=[];globalThis.fetch=async(url)=>{calls.push(String(url));writeFileSync(process.env.FETCH_CAPTURE,JSON.stringify(calls));if(String(url).endsWith('workspace-install-inspect'))return Response.json({workspaceId:process.env.INSPECT_WORKSPACE,serverCid:process.env.INSPECT_SERVER});if(process.env.REDEEM_PAYLOAD)return Response.json({payload:process.env.REDEEM_PAYLOAD});return new Response(null,{status:410});};`);
    const run=(origin=binding.appOrigin,extra:string[]=[],env:Record<string,string>={})=>{
      const grant=encode({version:2,appOrigin:origin,code:'g'.repeat(43),expiresAt:Date.now()+600000});
      const result=spawnSync(process.execPath,['--import',preload,resolve('dist/cli.js'),'setup-tunnel',grant,'--configuration',join(root,'fleet.yaml'),...extra],{env:{...process.env,PATH:bin,OURS_FLEET_HOME:join(root,'state'),FETCH_CAPTURE:capture,INSPECT_WORKSPACE:binding.workspaceId,INSPECT_SERVER:binding.serverCid,...env},encoding:'utf8',timeout:10000,input:''});
      expect(result.error).toBeUndefined();expect(result.status).toBe(1);expect(result.stderr).not.toContain(grant);expect(result.stderr).not.toContain('fixture-new-private');
      expect(readFileSync(join(workspace,'binding.json'),'utf8')).toBe(before);expect(readFileSync(join(workspace,'connector'),'utf8')).toBe('fixture-retained');expect(existsSync(join(root,'fleet.yaml'))).toBe(false);expect(existsSync(join(workspace,'replacement.json'))).toBe(false);
      return {output:result.stderr,calls:JSON.parse(readFileSync(capture,'utf8')) as string[]};
    };
    try{
      let result=run();expect(result.calls).toHaveLength(2);expect(result.calls[1]).toContain('workspace-install-redeem');expect(result.output).toContain('already used');expect(result.output).not.toContain('Replacing it');
      result=run(binding.appOrigin,['--replace-registration'],{INSPECT_SERVER:'b'.repeat(64)});expect(result.calls).toHaveLength(1);expect(result.output).toContain('retain the enrollment server');
      result=run('https://app.ours.network',['--replace-registration']);expect(result.calls).toHaveLength(1);expect(result.output).toContain('migrate-app-origin');
      result=run('https://app.ours.network',['--migrate-app-origin']);expect(result.calls).toHaveLength(2);expect(result.output).not.toContain('Replacing it');
      result=run(binding.appOrigin,[],{INSPECT_WORKSPACE:'z'.repeat(43)});expect(result.calls).toHaveLength(1);expect(result.output).toContain('Existing setup preserved');
      result=run(binding.appOrigin,[],{REDEEM_PAYLOAD:encode(payload)});expect(result.calls).toHaveLength(2);expect(result.output).toMatch(/destination|target|inspection/i);
    }finally{rmSync(root,{recursive:true,force:true});}
  },20000);
});
