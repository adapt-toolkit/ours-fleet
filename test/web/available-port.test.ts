import { it, expect } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { availableWebPort } from '../../src/web/available-port.js';
it('keeps a free preferred port and avoids an occupied listener without stopping it',async()=>{
 const occupied=createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
 const preferred=(occupied.address() as {port:number}).port;
 try{
   const selected=await availableWebPort(preferred);expect(selected).not.toBe(preferred);expect(occupied.listening).toBe(true);
   expect(await availableWebPort(selected)).toBe(selected);
 }finally{await new Promise<void>(resolve=>occupied.close(()=>resolve()));}
});
