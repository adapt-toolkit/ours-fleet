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
});
