import {it,expect,vi,afterEach} from 'vitest';
import {validateAccountOrigin, validateConfiguredAccountOrigin, validateConfiguredWorkspaceHost} from '../src/account-origin.js';
import {decodeWorkspacePayload} from '../src/workspace-enrollment.js';
import {readTunnelSetupArgument} from '../src/tunnel-setup-input.js';
afterEach(()=>vi.unstubAllEnvs());
it('uses exact operator authorities for two independent deployments and rejects a third',()=>{
 for(const origin of ['https://accounts.example.test','https://relocated.example.test']) {
  vi.stubEnv('OURS_ACCOUNT_ORIGIN',origin);vi.stubEnv('OURS_WORKSPACE_HOST','desk.workspaces.example.test');
  expect(validateConfiguredAccountOrigin(origin)).toBe(origin);
  expect(()=>validateConfiguredAccountOrigin('https://third.example.test')).toThrow();
  expect(validateConfiguredWorkspaceHost('desk.workspaces.example.test')).toBe(true);
  expect(validateConfiguredWorkspaceHost('other.workspaces.example.test')).toBe(false);
  const grant=(appOrigin:string)=>Buffer.from(JSON.stringify({version:2,appOrigin,code:'c'.repeat(43),expiresAt:Date.now()+600000})).toString('base64url');
  const encoded=grant(origin);
  expect(readTunnelSetupArgument(encoded)).toBe(encoded);
  const payload={version:1,appOrigin:origin,hostname:'desk.workspaces.example.test',rootName:'alice@home',connectorToken:'private',invitation:'invite',serverCid:'a'.repeat(64),challenge:{nonce:'n'.repeat(43),accountId:'a'.repeat(43),workspaceId:'w'.repeat(43),expiresAt:Date.now()+600000}};
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  expect(decodeWorkspacePayload(encode(payload)).hostname).toBe(payload.hostname);
  expect(()=>decodeWorkspacePayload(encode({...payload,hostname:'other.workspaces.example.test'}))).toThrow();
  expect(()=>decodeWorkspacePayload(encode({...payload,appOrigin:'https://third.example.test'}))).toThrow();
  expect(()=>readTunnelSetupArgument(grant('https://third.example.test'))).toThrow();
 }
});
it('requires trusted deployment configuration before accepting an incoming authority',()=>{
 vi.stubEnv('OURS_ACCOUNT_ORIGIN',undefined);vi.stubEnv('OURS_WORKSPACE_HOST',undefined);vi.stubEnv('OURS_WORKSPACE_DOMAIN',undefined);
 expect(()=>validateConfiguredAccountOrigin('https://app.ours.network')).toThrow();
 expect(validateConfiguredWorkspaceHost('desk.ours-tunnel.com')).toBe(false);
});
it('validates stored private origins without inventing a default or accepting malformed authorities',()=>{
 expect(validateAccountOrigin('https://private.example.test')).toBe('https://private.example.test');
 for(const value of [undefined,'http://remote.example.test','https://example.test:443','https://example.test/','https://user@example.test','https://example.test/path'])expect(()=>validateAccountOrigin(value)).toThrow();
});
