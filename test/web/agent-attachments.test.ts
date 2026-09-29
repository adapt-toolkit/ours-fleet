import { mkdtempSync, rmSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attachmentPrompt, storeAgentAttachment, MAX_ATTACHMENT_BYTES } from '../../src/web/agent-attachments.js';
const dirs:string[]=[];const temp=()=>{const dir=mkdtempSync(join(tmpdir(),'fleet-attachments-'));dirs.push(dir);return dir;};
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const input=(name='hello.txt',data=Buffer.from('exact file bytes'))=>({name,mimeType:'application/octet-stream',data:data.toString('base64')});
describe('agent attachment storage',()=>{
 it('preserves bytes, safely names paths, and gives identical IDs and prompts on retry',()=>{
  const dir=temp(),body=input('../../metadata.json'),a=storeAgentAttachment(dir,'gen1',body),b=storeAgentAttachment(dir,'gen1',body);expect(a).toEqual(b);
  const prompt=attachmentPrompt(dir,'gen1',[a.id],'Read this');const files=JSON.parse(prompt.slice(prompt.indexOf('[\n')));expect(readFileSync(files[0].path).toString()).toBe('exact file bytes');expect(files[0].path.startsWith(join(dir,'web-attachments',a.id)+'/')).toBe(true);expect(attachmentPrompt(dir,'gen1',[a.id],'Read this')).toBe(prompt);
  expect(()=>attachmentPrompt(dir,'gen2',[a.id],'')).toThrow(/different agent session/);expect(()=>attachmentPrompt(temp(),'gen1',[a.id],'')).toThrow();
 });
 it('rejects malformed/oversize data and invalid IDs without guessing a file',()=>{
  const dir=temp();expect(()=>storeAgentAttachment(dir,'gen1',{...input(),data:'a=='})).toThrow();expect(()=>storeAgentAttachment(dir,'gen1',input('large',Buffer.alloc(MAX_ATTACHMENT_BYTES+1)))).toThrow(/20 MiB/);expect(() => attachmentPrompt(dir, 'gen1', ['../outside'], '')).toThrow();
 });
 it('detects symlink replacement and changed bytes before a prompt is sent',()=>{
  const dir=temp(),a=storeAgentAttachment(dir,'gen1',input());const file=join(dir,'web-attachments',a.id,'content-hello.txt');const other=join(dir,'other');writeFileSync(other,'private');unlinkSync(file);symlinkSync(other,file);expect(()=>attachmentPrompt(dir,'gen1',[a.id],'')).toThrow();expect(()=>storeAgentAttachment(dir,'gen1',input())).toThrow();expect(readFileSync(other,'utf8')).toBe('private');unlinkSync(file);writeFileSync(file,'changed');expect(()=>attachmentPrompt(dir,'gen1',[a.id],'')).toThrow(/changed/);
 });
 it('allows empty files and refuses symlink storage roots',()=>{
  const dir=temp(),a=storeAgentAttachment(dir,'gen1',input('empty',Buffer.alloc(0)));expect(a.size).toBe(0);expect(attachmentPrompt(dir,'gen1',[a.id],'')).toContain('empty');const other=temp();symlinkSync(dir,join(other,'web-attachments'));expect(()=>storeAgentAttachment(other,'gen1',input())).toThrow(/directory/);
 });
});
