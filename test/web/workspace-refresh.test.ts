import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  WorkspaceDeviceStore, WorkspaceRefreshReuseError, WorkspaceDeviceAuthError,
  ACCESS_TTL, REFRESH_IDLE_TTL, FAMILY_TTL, LEGACY_BEARER_WINDOW,
} from '../../src/web/workspace-devices.js';
import { WebAuth } from '../../src/web/auth.js';
import type { FastifyRequest } from 'fastify';

const origin='https://alice-home.ours-tunnel.com',appOrigin='https://app.ours.network',host=new URL(origin).host;
const { DatabaseSync }=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const sha=(value: string)=>createHash('sha256').update(value).digest('hex');
const dirs: string[]=[];
afterEach(()=>{vi.useRealTimers();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function open(start=1_000_000) {
  const dir=mkdtempSync(join(tmpdir(),'fleet-workspace-refresh-'));dirs.push(dir);
  const clock={now:start};
  const store=new WorkspaceDeviceStore(dir,()=>clock.now);
  const link=(issuer: string | null=null)=>{const code=store.mint(issuer);return store.enroll(code.enrollment,code.workspaceId,'browser',true);};
  return {dir,clock,store,link,reopen:()=>new WorkspaceDeviceStore(dir,()=>clock.now)};
}
const disk=(dir: string)=>Buffer.concat(['workspace-devices.db','workspace-devices.db-wal'].map(name=>join(dir,name)).filter(existsSync).map(path=>readFileSync(path))).toString('latin1');

describe('workspace link lifetimes',()=>{
  it('uses the documented lifetimes',()=>{
    expect([ACCESS_TTL,REFRESH_IDLE_TTL,FAMILY_TTL]).toEqual([5*60_000,7*86_400_000,30*86_400_000]);
  });
  it('issues credentials that are stored only as hashes',()=>{
    const {dir,store,link,clock}=open();
    const issued=link();
    expect(issued.accessExpiresAt).toBe(clock.now+ACCESS_TTL);
    expect(issued.refreshExpiresAt).toBe(clock.now+REFRESH_IDLE_TTL);
    expect(issued.familyExpiresAt).toBe(clock.now+FAMILY_TTL);
    const next=store.refresh(issued.refreshToken);
    const bytes=disk(dir);
    for(const secret of [issued.accessToken,issued.refreshToken,next.accessToken,next.refreshToken])expect(bytes).not.toContain(secret.slice(4));
    store.close();
  });
  it('ends an access credential exactly at its deadline while the link continues',()=>{
    const {store,link,clock}=open();
    const issued=link();
    clock.now=issued.accessExpiresAt-1;
    expect(store.authenticate(issued.accessToken)).toMatchObject({id:issued.device.id,authorizedUntil:issued.accessExpiresAt,rotating:true});
    clock.now=issued.accessExpiresAt;
    expect(()=>store.authenticate(issued.accessToken)).toThrow(WorkspaceDeviceAuthError);
    expect(store.valid(issued.device.id)).toBe(true);
    expect(store.authenticate(store.refresh(issued.refreshToken).accessToken).id).toBe(issued.device.id);
    store.close();
  });
  it('ends an unused refresh credential exactly at its idle deadline',()=>{
    const {store,link,clock}=open();
    const kept=link(),lapsed=link();
    clock.now=kept.refreshExpiresAt-1;
    const renewed=store.refresh(kept.refreshToken);
    expect(renewed.refreshExpiresAt).toBe(clock.now+REFRESH_IDLE_TTL);
    clock.now=lapsed.refreshExpiresAt;
    expect(()=>store.refresh(lapsed.refreshToken)).toThrow(WorkspaceDeviceAuthError);
    expect(store.valid(lapsed.device.id)).toBe(false);
    expect(store.valid(kept.device.id)).toBe(true);
    store.close();
  });
  it('never moves a link past the family deadline fixed when it was linked',()=>{
    const {store,link,clock}=open();
    let current=link();const familyExpiresAt=current.familyExpiresAt;
    while(clock.now+6*86_400_000<familyExpiresAt) {
      clock.now+=6*86_400_000;
      current=store.refresh(current.refreshToken);
      store.authenticate(current.accessToken);
      expect(current.familyExpiresAt).toBe(familyExpiresAt);
      expect(current.refreshExpiresAt).toBe(Math.min(clock.now+REFRESH_IDLE_TTL,familyExpiresAt));
    }
    expect(current.refreshExpiresAt).toBe(familyExpiresAt);
    clock.now=familyExpiresAt-1;
    const last=store.refresh(current.refreshToken);
    expect(last.accessExpiresAt).toBe(familyExpiresAt);
    expect(last.refreshExpiresAt).toBe(familyExpiresAt);
    expect(store.authenticate(last.accessToken).authorizedUntil).toBe(familyExpiresAt);
    clock.now=familyExpiresAt;
    expect(()=>store.authenticate(last.accessToken)).toThrow(WorkspaceDeviceAuthError);
    expect(()=>store.refresh(last.refreshToken)).toThrow(WorkspaceDeviceAuthError);
    expect(store.valid(current.device.id)).toBe(false);
    store.close();
  });
});

describe('workspace refresh rotation',()=>{
  it('answers a spent credential with the same successor until that successor is in use',()=>{
    const {store,link,clock}=open();
    const issued=link();
    const first=store.refresh(issued.refreshToken);
    expect(first.refreshToken).not.toBe(issued.refreshToken);
    clock.now+=3*86_400_000;
    const retried=store.refresh(issued.refreshToken),again=store.refresh(issued.refreshToken);
    // One canonical successor, and retrying extends nothing.
    expect([retried.refreshToken,again.refreshToken]).toEqual([first.refreshToken,first.refreshToken]);
    expect([retried.refreshExpiresAt,again.refreshExpiresAt]).toEqual([first.refreshExpiresAt,first.refreshExpiresAt]);
    expect(store.list().find(device=>device.id===issued.device.id)!.expiresAt).toBe(first.refreshExpiresAt);
    expect(retried.familyExpiresAt).toBe(issued.familyExpiresAt);
    clock.now=first.refreshExpiresAt;
    expect(()=>store.refresh(issued.refreshToken)).toThrow(WorkspaceDeviceAuthError);
    store.close();
  });
  it('treats a spent credential as a replay once an access credential of its successor was used',()=>{
    const {store,link}=open();
    const issued=link(),first=store.refresh(issued.refreshToken);
    store.authenticate(first.accessToken);
    expect(()=>store.refresh(issued.refreshToken)).toThrow(WorkspaceRefreshReuseError);
    // The whole link is gone: successor, earlier and later access credentials.
    expect(store.valid(issued.device.id)).toBe(false);
    expect(()=>store.refresh(first.refreshToken)).toThrow(WorkspaceDeviceAuthError);
    expect(()=>store.authenticate(first.accessToken)).toThrow(WorkspaceDeviceAuthError);
    expect(()=>store.authenticate(issued.accessToken)).toThrow(WorkspaceDeviceAuthError);
    expect(store.list().find(device=>device.id===issued.device.id)!.revokedAt).not.toBeNull();
  });
  it('treats a spent credential as a replay once its successor was itself presented',()=>{
    const {store,link}=open();
    const issued=link(),first=store.refresh(issued.refreshToken),second=store.refresh(first.refreshToken);
    expect(()=>store.refresh(issued.refreshToken)).toThrow(WorkspaceRefreshReuseError);
    expect(()=>store.refresh(second.refreshToken)).toThrow(WorkspaceDeviceAuthError);
    store.close();
  });
  it('does not let a wrong or expired access credential confirm a successor',()=>{
    const {store,link,clock}=open();
    const issued=link(),first=store.refresh(issued.refreshToken);
    expect(()=>store.authenticate('owa.'+'x'.repeat(43))).toThrow(WorkspaceDeviceAuthError);
    clock.now=first.accessExpiresAt;
    expect(()=>store.authenticate(first.accessToken)).toThrow(WorkspaceDeviceAuthError);
    expect(store.refresh(issued.refreshToken).refreshToken).toBe(first.refreshToken);
    store.close();
  });
  it('converges on one successor when answers arrive in any order or a restart intervenes',()=>{
    const {store,link,reopen}=open();
    const issued=link();
    const answers=[store.refresh(issued.refreshToken),store.refresh(issued.refreshToken)];
    store.close();
    const restarted=reopen();
    answers.push(restarted.refresh(issued.refreshToken));
    expect(new Set(answers.map(answer=>answer.refreshToken)).size).toBe(1);
    // Whichever answer the browser keeps last, the cookie value is the same and still works.
    const later=restarted.refresh(answers[0].refreshToken);
    expect(restarted.authenticate(later.accessToken).id).toBe(issued.device.id);
    for(const answer of answers)expect(restarted.authenticate(answer.accessToken).id).toBe(issued.device.id);
    restarted.close();
  });
  it('ends links issued from a replayed link, but not on an ordinary revoke',()=>{
    const {store,link}=open();
    const parent=link(),child=link(parent.device.id),grandchild=link(child.device.id),unrelated=link();
    const sibling=link(),siblingChild=link(sibling.device.id);
    store.revoke(sibling.device.id);
    expect(store.valid(siblingChild.device.id)).toBe(true);
    const next=store.refresh(parent.refreshToken);store.authenticate(next.accessToken);
    let error: unknown;
    try {store.refresh(parent.refreshToken);} catch(caught) {error=caught;}
    expect(error).toBeInstanceOf(WorkspaceRefreshReuseError);
    expect((error as WorkspaceRefreshReuseError).revoked.sort()).toEqual([parent.device.id,child.device.id,grandchild.device.id].sort());
    expect([parent,child,grandchild].map(issued=>store.valid(issued.device.id))).toEqual([false,false,false]);
    expect(()=>store.authenticate(grandchild.accessToken)).toThrow(WorkspaceDeviceAuthError);
    expect(store.authenticate(unrelated.accessToken).id).toBe(unrelated.device.id);
    store.close();
  });
  it('revokes by the hash of any credential of a link, spent or current',()=>{
    const {store,link}=open();
    const issued=link(),other=link();
    const next=store.refresh(issued.refreshToken);
    expect(store.revokeByRefreshHash(sha('owr.unknown'))).toBeUndefined();
    expect(store.revokeByRefreshHash(issued.refreshToken)).toBeUndefined();
    // The hash of a spent credential still names its link after rotation.
    expect(store.revokeByRefreshHash(sha(issued.refreshToken))).toBe(issued.device.id);
    expect(()=>store.authenticate(next.accessToken)).toThrow(WorkspaceDeviceAuthError);
    expect(()=>store.refresh(next.refreshToken)).toThrow(WorkspaceDeviceAuthError);
    expect(store.valid(other.device.id)).toBe(true);
    store.close();
  });
  it('issues a link code only for the current refresh credential, rotating it and counting the successor as used',()=>{
    const {store,link}=open();
    const issued=link();
    expect(()=>store.link(issued.accessToken)).toThrow(WorkspaceDeviceAuthError);
    const minted=store.link(issued.refreshToken);
    expect(minted.refreshToken).not.toBe(issued.refreshToken);
    expect(minted.device.id).toBe(issued.device.id);
    const child=store.enroll(minted.enrollment,minted.workspaceId,'second browser',true);
    expect(store.authenticate(child.accessToken).id).toBe(child.device.id);
    // The link goes on with the successor it was handed.
    const later=store.refresh(minted.refreshToken);
    expect(store.authenticate(later.accessToken).id).toBe(issued.device.id);
    expect(store.valid(child.device.id)).toBe(true);
    store.close();
  });
  it('ends the link and the link made from its code when the credential spent on that code comes back',()=>{
    // A copied credential was used to make a link for someone else; the owner's browser still holds it.
    const {store,link}=open();
    const issued=link(),copied=issued.refreshToken;
    const minted=store.link(copied),child=store.enroll(minted.enrollment,minted.workspaceId,'not the owner',true);
    let error: unknown;
    try {store.refresh(issued.refreshToken);} catch(caught) {error=caught;}
    expect(error).toBeInstanceOf(WorkspaceRefreshReuseError);
    expect((error as WorkspaceRefreshReuseError).revoked.sort()).toEqual([issued.device.id,child.device.id].sort());
    expect(()=>store.authenticate(child.accessToken)).toThrow(WorkspaceDeviceAuthError);
    expect(()=>store.refresh(child.refreshToken)).toThrow(WorkspaceDeviceAuthError);
    expect(()=>store.refresh(minted.refreshToken)).toThrow(WorkspaceDeviceAuthError);
    store.close();
  });
  it('ends the link and a pending code when a copied credential is refreshed first and then used for a code',()=>{
    const {store,link}=open();
    const issued=link();
    // The copy is refreshed to T1 and T1 makes a code; the owner then presents T0.
    const stolen=store.refresh(issued.refreshToken),minted=store.link(stolen.refreshToken);
    expect(()=>store.refresh(issued.refreshToken)).toThrow(WorkspaceRefreshReuseError);
    expect(()=>store.enroll(minted.enrollment,minted.workspaceId,'not the owner',true)).toThrow();
    expect(store.valid(issued.device.id)).toBe(false);
    store.close();
  });
  it('does not repeat a link code for a credential already spent',()=>{
    const {store,link}=open();
    const issued=link();
    store.link(issued.refreshToken);
    expect(()=>store.link(issued.refreshToken)).toThrow(WorkspaceRefreshReuseError);
    expect(store.valid(issued.device.id)).toBe(false);
    // Nor for one whose refresh answer may still be on its way.
    const other=link();store.refresh(other.refreshToken);
    expect(()=>store.link(other.refreshToken)).toThrow(WorkspaceRefreshReuseError);
    store.close();
  });
});

describe('fixed bearer transition',()=>{
  it('exchanges a fixed bearer once, keeping the device and never lengthening its life',()=>{
    const {store,clock}=open();
    const legacy=()=>{const code=store.mint();return store.enroll(code.enrollment,code.workspaceId,'old browser');};
    const old=legacy(),short=legacy();
    expect(store.authenticate(old.token)).toMatchObject({id:old.device.id,rotating:false});
    const issued=store.exchange(old.token);
    expect(issued.device.id).toBe(old.device.id);
    expect(issued.familyExpiresAt).toBe(clock.now+FAMILY_TTL);
    expect(()=>store.authenticate(old.token)).toThrow(WorkspaceDeviceAuthError);
    expect(()=>store.exchange(old.token)).toThrow(WorkspaceDeviceAuthError);
    expect(store.authenticate(issued.accessToken).id).toBe(old.device.id);
    expect(store.refresh(issued.refreshToken).device.id).toBe(old.device.id);
    expect(short.device.expiresAt).toBe(clock.now+90*86_400_000);
    store.close();
  });
  it('caps an exchanged link at the bearer\'s remaining life',()=>{
    const {dir,store,clock,reopen}=open();
    const code=store.mint(),old=store.enroll(code.enrollment,code.workspaceId,'old browser');
    store.close();
    // A bearer issued long before this version: ten days of its ninety are left.
    const raw=new DatabaseSync(join(dir,'workspace-devices.db'));
    raw.prepare('UPDATE devices SET expiresAt=? WHERE id=?').run(clock.now+10*86_400_000,old.device.id);raw.close();
    const reopened=reopen(),issued=reopened.exchange(old.token);
    expect(issued.familyExpiresAt).toBe(clock.now+10*86_400_000);
    expect(issued.refreshExpiresAt).toBe(clock.now+REFRESH_IDLE_TTL);
    clock.now=issued.familyExpiresAt-1;
    expect(()=>reopened.refresh(issued.refreshToken)).toThrow(WorkspaceDeviceAuthError);
    reopened.close();
  });
  it('stops accepting and issuing fixed bearers when the legacy window closes',()=>{
    const {store,clock,link}=open();
    const code=store.mint(),old=store.enroll(code.enrollment,code.workspaceId,'old browser'),pending=store.mint();
    clock.now=store.legacySunsetAt-1;
    expect(store.authenticate(old.token)).toMatchObject({id:old.device.id,authorizedUntil:store.legacySunsetAt});
    expect(store.valid(old.device.id)).toBe(true);
    clock.now=store.legacySunsetAt;
    expect(()=>store.authenticate(old.token)).toThrow(WorkspaceDeviceAuthError);
    expect(()=>store.exchange(old.token)).toThrow(WorkspaceDeviceAuthError);
    expect(store.valid(old.device.id)).toBe(false);
    const fresh=store.mint();
    expect(()=>store.enroll(fresh.enrollment,fresh.workspaceId,'old app')).toThrow(/no longer issues fixed device credentials/);
    expect(pending.expiresAt).toBeLessThan(clock.now);
    // Rotating links are unaffected by the window.
    const rotating=store.enroll(fresh.enrollment,fresh.workspaceId,'new app',true);
    expect(store.refresh(store.refresh(rotating.refreshToken).refreshToken).device.id).toBe(rotating.device.id);
    expect(link().device.id).not.toBe(rotating.device.id);
    store.close();
  });
  it('keeps the window fixed across restarts',()=>{
    const {store,clock,reopen}=open();
    const sunset=store.legacySunsetAt;store.close();
    clock.now+=10*86_400_000;
    const reopened=reopen();
    expect(reopened.legacySunsetAt).toBe(sunset);
    reopened.close();
  });
});

describe('workspace link authorization',()=>{
  function boot() {
    const opened=open(Date.now());
    vi.useFakeTimers({now:opened.clock.now});
    const now=()=>Date.now();
    const store=new WorkspaceDeviceStore(mkdtempSync(join(tmpdir(),'fleet-workspace-refresh-')),now);
    opened.store.close();
    const auth=new WebAuth(origin,host,now,undefined,undefined,store,appOrigin);
    const link=()=>{const code=store.mint();return store.enroll(code.enrollment,code.workspaceId,'browser',true);};
    const browser=(token: string)=>({headers:{host,origin:appOrigin,authorization:`Bearer ${token}`,'sec-fetch-site':'cross-site'},url:'/api/v1/devices',method:'GET'} as unknown as FastifyRequest);
    const machine=(headers: Record<string,string>={})=>({headers:{host,...headers},url:'/api/v1/devices/refresh',method:'POST'} as unknown as FastifyRequest);
    return {store,auth,link,browser,machine};
  }
  it('closes each transport at the deadline of the credential that opened it',()=>{
    const {store,auth,link,browser}=boot();
    try {
      const issued=link(),other=link();
      const old=auth.authenticate(browser(issued.accessToken));
      expect(old.absoluteExpiresAt).toBe(issued.accessExpiresAt);
      let oldClosed=0,freshClosed=0,otherClosed=0;
      auth.bindTransport(old,()=>oldClosed++);
      vi.advanceTimersByTime(4*60_000);
      const renewed=store.refresh(issued.refreshToken);
      // A newer credential of the same device, used by the same or another tab.
      const fresh=auth.authenticate(browser(renewed.accessToken));
      expect(fresh.id).toBe(old.id);
      auth.bindTransport(fresh,()=>freshClosed++);
      auth.bindTransport(auth.authenticate(browser(other.accessToken)),()=>otherClosed++);
      vi.advanceTimersByTime(60_000-1500);
      expect([oldClosed,freshClosed]).toEqual([0,0]);
      vi.advanceTimersByTime(3000);
      expect([oldClosed,freshClosed]).toEqual([1,0]);
      expect(auth.authenticate(browser(renewed.accessToken)).id).toBe(old.id);
      vi.advanceTimersByTime(4*60_000);
      expect(freshClosed).toBe(1);
      expect(otherClosed).toBe(1);
    } finally {auth.shutdown();}
  });
  it('closes every transport of a link at once on replay, leaving other links open',()=>{
    const {store,auth,link,browser,machine}=boot();
    try {
      const issued=link(),other=link();
      let closed=0,otherClosed=0;
      auth.bindTransport(auth.authenticate(browser(issued.accessToken)),()=>closed++);
      auth.bindTransport(auth.authenticate(browser(other.accessToken)),()=>otherClosed++);
      const renewed=auth.refreshWorkspace(machine(),issued.refreshToken);
      auth.bindTransport(auth.authenticate(browser(renewed.accessToken)),()=>closed++);
      expect(()=>auth.refreshWorkspace(machine(),issued.refreshToken)).toThrow(WorkspaceRefreshReuseError);
      expect([closed,otherClosed]).toEqual([2,0]);
      expect(()=>auth.authenticate(browser(renewed.accessToken))).toThrow(WorkspaceDeviceAuthError);
      expect(store.valid(other.device.id)).toBe(true);
    } finally {auth.shutdown();}
  });
  it('revokes by hash and closes what the link had open',()=>{
    const {auth,link,browser,machine}=boot();
    try {
      const issued=link();let closed=0;
      auth.bindTransport(auth.authenticate(browser(issued.accessToken)),()=>closed++);
      expect(auth.revokeWorkspaceRefresh(machine(),sha('owr.nothing'))).toBe(false);
      expect(auth.revokeWorkspaceRefresh(machine(),sha(issued.refreshToken))).toBe(true);
      expect(closed).toBe(1);
      expect(()=>auth.authenticate(browser(issued.accessToken))).toThrow(WorkspaceDeviceAuthError);
    } finally {auth.shutdown();}
  });
  it('refuses refresh material to anything that identifies itself as a browser',()=>{
    const {auth,link,machine}=boot();
    try {
      const issued=link();
      for(const headers of [{origin:appOrigin},{origin},{'sec-fetch-site':'same-origin'},{'sec-fetch-mode':'cors'},{cookie:'ofs_session=x'}]) {
        expect(()=>auth.refreshWorkspace(machine(headers),issued.refreshToken)).toThrow(/does not accept browser requests/);
        expect(()=>auth.linkWorkspaceDevice(machine(headers),issued.refreshToken)).toThrow(/does not accept browser requests/);
        expect(()=>auth.revokeWorkspaceRefresh(machine(headers),sha(issued.refreshToken))).toThrow(/does not accept browser requests/);
      }
      // A refused request spends nothing.
      const minted=auth.linkWorkspaceDevice(machine(),issued.refreshToken);
      expect(minted.enrollment).toMatch(/^[\w-]{43}$/);
      expect(auth.refreshWorkspace(machine(),minted.refreshToken).device.id).toBe(issued.device.id);
      expect(()=>auth.refreshWorkspace(machine({host:'attacker.invalid'}),issued.refreshToken)).toThrow();
    } finally {auth.shutdown();}
  });
  it('renews a named transport only for its own device, with a live newer credential, while it is still open',()=>{
    const {store,auth,link,browser}=boot();
    const renew=(token: string)=>({...browser(token),method:'POST',url:'/api/v1/transports/x/renew'} as unknown as FastifyRequest);
    try {
      const issued=link(),other=link();
      let closed=0,copyClosed=0;
      auth.bindTransport(auth.authenticate(browser(issued.accessToken)),()=>closed++,'voice-stream-name');
      // The same credential, copied, opened a stream of its own.
      auth.bindTransport(auth.authenticate(browser(issued.accessToken)),()=>copyClosed++,'copied-stream-name');
      expect(()=>auth.renewTransport(renew(other.accessToken),'voice-stream-name')).toThrow(/transport is not open/);
      expect(()=>auth.renewTransport(renew(issued.accessToken),'unknown-name')).toThrow(/transport is not open/);
      vi.advanceTimersByTime(4*60_000);
      const renewed=store.refresh(issued.refreshToken);
      // Renewing with the credential that opened it gains nothing.
      expect(auth.renewTransport(renew(issued.accessToken),'voice-stream-name').authorizedUntil).toBe(issued.accessExpiresAt);
      expect(auth.renewTransport(renew(renewed.accessToken),'voice-stream-name').authorizedUntil).toBe(renewed.accessExpiresAt);
      vi.advanceTimersByTime(62_000);
      // The page's stream lives on; the copy, which has no newer credential, ended at its deadline and cannot come back.
      expect([closed,copyClosed]).toEqual([0,1]);
      expect(()=>auth.renewTransport(renew(renewed.accessToken),'copied-stream-name')).toThrow(/transport is not open/);
      vi.advanceTimersByTime(4*60_000);
      expect(closed).toBe(1);
      expect(()=>auth.renewTransport(renew(store.refresh(renewed.refreshToken).accessToken),'voice-stream-name')).toThrow(/transport is not open/);
    } finally {auth.shutdown();}
  });
  it('gives a socket ticket the deadline of the credential that minted it, whatever is refreshed meanwhile',()=>{
    const {store,auth,link,browser}=boot();
    const mutation=(token: string)=>({...browser(token),method:'POST',url:'/api/v1/ws-tickets'} as unknown as FastifyRequest);
    const upgrade={headers:{host,origin:appOrigin},url:'/api/v1/events',method:'GET'} as unknown as FastifyRequest;
    try {
      const issued=link();
      // Own-origin sockets are what consumeTicket admits; the deadline rule is the same for any caller.
      auth.setBoundary(origin,host,{origins:[appOrigin]});
      vi.advanceTimersByTime(ACCESS_TTL-10_000);
      const early=auth.mintTicket(mutation(issued.accessToken),'events'),late=auth.mintTicket(mutation(issued.accessToken),'events');
      expect(Date.parse(early.expiresAt)).toBe(issued.accessExpiresAt);
      // Another tab refreshes and uses its new credential: the shared session entry now runs five minutes longer.
      vi.advanceTimersByTime(5_000);
      const renewed=store.refresh(issued.refreshToken);
      expect(auth.authenticate(browser(renewed.accessToken)).absoluteExpiresAt).toBe(renewed.accessExpiresAt);
      const session=auth.consumeTicket(upgrade,early.ticket,'events');
      expect(session.absoluteExpiresAt).toBe(issued.accessExpiresAt);
      let closed: number | undefined;
      const socket={close:(code: number)=>{closed=code;},once:()=>{}} as unknown as import('ws').WebSocket;
      auth.bindSocket(session,socket);
      vi.advanceTimersByTime(4_000);
      expect(closed).toBeUndefined();
      vi.advanceTimersByTime(2_000);
      expect(closed).toBe(4401);
      // After the minting credential's deadline the other ticket opens nothing.
      expect(()=>auth.consumeTicket(upgrade,late.ticket,'events')).toThrow(/WebSocket ticket/);
      const fresh=auth.consumeTicket(upgrade,auth.mintTicket(mutation(renewed.accessToken),'events').ticket,'events');
      expect(fresh.absoluteExpiresAt).toBe(renewed.accessExpiresAt);
    } finally {auth.shutdown();}
  });
});
