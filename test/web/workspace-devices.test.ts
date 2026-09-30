import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { WorkspaceDeviceStore } from '../../src/web/workspace-devices.js';
import { WebAuth } from '../../src/web/auth.js';
import type { FastifyRequest } from 'fastify';
const origin='https://alice-home.ours-tunnel.com',appOrigin='https://app.ours.network';
describe('workspace devices',()=>{
  it('consumes links once, persists only hashes, bounds expiry and preserves other devices on revoke',()=>{
    let now=100000;const dir=mkdtempSync(join(tmpdir(),'fleet-workspace-'));const store=new WorkspaceDeviceStore(dir,()=>now);
    try {
      const link=store.mint();expect(()=>store.enroll(link.enrollment,'foreign','phone')).toThrow();
      const one=store.enroll(link.enrollment,link.workspaceId,'phone');expect(()=>store.enroll(link.enrollment,link.workspaceId,'phone')).toThrow();
      const next=store.mint(one.device.id),two=store.enroll(next.enrollment,next.workspaceId,'laptop');
      const outstanding=store.mint(one.device.id);store.revoke(one.device.id);
      expect(()=>store.authenticate(one.token)).toThrow();expect(store.authenticate(two.token).id).toBe(two.device.id);
      expect(()=>store.enroll(outstanding.enrollment,outstanding.workspaceId,'other')).toThrow();
      const old=store.mint();now+=300001;expect(()=>store.enroll(old.enrollment,old.workspaceId,'expired')).toThrow();
      const bytes=Buffer.concat([readFileSync(join(dir,'workspace-devices.db')),readFileSync(join(dir,'workspace-devices.db-wal'))]).toString();expect(bytes).not.toContain(two.token);expect(bytes).not.toContain(next.enrollment);
      store.close();const reopened=new WorkspaceDeviceStore(dir,()=>now);expect(reopened.workspaceId).toBe(link.workspaceId);expect(reopened.authenticate(two.token).id).toBe(two.device.id);reopened.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('authorizes actual bearer requests and closes revoked transports without closing another device',()=>{
    const dir=mkdtempSync(join(tmpdir(),'fleet-workspace-auth-'));const store=new WorkspaceDeviceStore(dir);
    const auth=new WebAuth(origin,new URL(origin).host,Date.now,undefined,undefined,store,appOrigin);
    const issue=()=>{const l=store.mint();return store.enroll(l.enrollment,l.workspaceId,'device');};const one=issue(),two=issue();
    const request=(token:string,requestOrigin=appOrigin)=>({headers:{host:new URL(origin).host,origin:requestOrigin,authorization:`Bearer ${token}`,'sec-fetch-site':'cross-site'},url:'/api/v1/devices',method:'GET'} as unknown as FastifyRequest);
    try {
      const session=auth.authenticate(request(one.token));expect(auth.authenticate(request(two.token)).id).not.toBe(session.id);
      expect(()=>auth.authenticate(request(one.token,'https://attacker.invalid'))).toThrow();
      let closed=0;const cleanup=auth.bindTransport(session.id,()=>closed++);
      auth.revokeWorkspaceDevice(one.device.id);expect(closed).toBe(1);expect(()=>auth.authenticate(request(one.token))).toThrow();expect(auth.authenticate(request(two.token)).id).toContain(two.device.id);cleanup();
    } finally {auth.shutdown();rmSync(dir,{recursive:true,force:true});}
  });
});
