import {it,expect} from 'vitest';
import {completeTunnelSetup} from '../src/tunnel-setup-completion.js';
it('prints QR and ordinary code and clears pending only after successful output',async()=>{
 const calls:string[]=[];const link={origin:'https://home.ours-tunnel.com',enrollment:'private-single-use'};
 await completeTunnelSetup({link:async()=>link,qr:async code=>{calls.push('qr');return 'QR:'+code;},write:text=>{calls.push('write');expect(text).toContain(Buffer.from(JSON.stringify(link)).toString('base64url'));expect(text).toContain('QR:');},clear:()=>{calls.push('clear');}});expect(calls).toEqual(['qr','write','clear']);
});
it('retains resume state after connection issue, QR rendering or output failure',async()=>{
 for(const failure of ['link','qr','write']){let cleared=false;
 await expect(completeTunnelSetup({link:async()=>{if(failure==='link')throw Error('unavailable');return {};},qr:async()=>{if(failure==='qr')throw Error('render');return 'QR';},write:()=>{if(failure==='write')throw Error('output');},clear:()=>{cleared=true;}})).rejects.toThrow(/setup-tunnel --resume/);expect(cleared).toBe(false);}
});

it('retains pending record while asynchronous output is unflushed or rejected',async()=>{
 let cleared=false,release!:()=>void;
 const done=completeTunnelSetup({link:async()=>({}),qr:async()=> 'QR',write:()=>new Promise<void>(resolve=>{release=resolve;}),clear:()=>{cleared=true;}});
 await new Promise(resolve=>setImmediate(resolve));expect(cleared).toBe(false);release();await done;expect(cleared).toBe(true);
 cleared=false;await expect(completeTunnelSetup({link:async()=>({}),qr:async()=> 'QR',write:async()=>{throw Error('EPIPE');},clear:()=>{cleared=true;}})).rejects.toThrow(/--resume/);expect(cleared).toBe(false);
});
