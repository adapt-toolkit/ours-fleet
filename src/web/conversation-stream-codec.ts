/** Public v1 wire contract. Kept free of Node APIs so browser consumers can share it. */
export const MAX_FRAME_BYTES = 512 * 1024;
export const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
export const MAX_PENDING_BYTES = 8 * 1024 * 1024;
export type ConversationRecordType = 'ready' | 'ledger' | 'state' | 'role' | 'resync' | 'keepalive';
export interface ConversationStreamRecord { version: 1; type: ConversationRecordType; payload: unknown }
const utf8 = new TextEncoder();
const types = new Set(['ready','ledger','state','role','resync','keepalive']);
const frame = (value: unknown) => `event: conversation\ndata: ${JSON.stringify(value)}\n\n`;
const identity = (payload: any) => ({ generation: payload?.sessionGeneration ?? payload?.snapshot?.sessionGeneration,
  revision: payload?.stateRevision ?? payload?.snapshot?.stateRevision ?? payload?.roleRevision });

/** A payload is the logical record; SSE/JSON envelopes do not consume its assembly budget. */
export function* encodeConversationRecord(type: ConversationRecordType, payload: unknown, id: string): Generator<string> {
  const json = JSON.stringify(payload), totalBytes = utf8.encode(json).byteLength;
  if (totalBytes > MAX_ASSEMBLY_BYTES) throw new Error('conversation record exceeds assembly limit');
  const direct = frame({version:1,type,payload});
  if (utf8.encode(direct).byteLength <= MAX_FRAME_BYTES) { yield direct; return; }
  const position = identity(payload);
  yield frame({version:1,type:'start',id,recordType:type,totalBytes,...position});
  // At most 48K UTF-16 units: even worst-case JSON escapes fit a 512 KiB frame.
  let index = 0;
  for (let offset=0;offset<json.length;) {
    let end = Math.min(json.length, offset + 48 * 1024);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json[end-1])) end--;
    yield frame({version:1,type:'chunk',id,index:index++,data:json.slice(offset,end)});
    offset=end;
  }
  yield frame({version:1,type:'commit',id,totalBytes,...position});
}

/** Strict incremental decoder: one assembly, no partial publication, UTF-8 split safe. */
export class ConversationStreamDecoder {
  private decoder = new TextDecoder('utf-8', {fatal:true});
  private pending = '';
  private assembly?: {id:string;type:ConversationRecordType;total:number;bytes:number;index:number;parts:string[];generation?:string;revision?:number};
  constructor(private readonly publish: (record: ConversationStreamRecord) => void) {}
  push(bytes: Uint8Array): void {
    try {
      this.pending += this.decoder.decode(bytes, {stream:true});
      for (;;) {
        const end = this.pending.indexOf('\n\n');
        if (end < 0) break;
        const text=this.pending.slice(0,end+2); this.pending=this.pending.slice(end+2);
        if (utf8.encode(text).byteLength>MAX_FRAME_BYTES) throw new Error('frame limit exceeded');
        if (!text.startsWith('event: conversation\ndata: ')) throw new Error('invalid conversation frame');
        this.accept(JSON.parse(text.slice(26,-2)));
      }
      if (utf8.encode(this.pending).byteLength>MAX_FRAME_BYTES) throw new Error('frame limit exceeded');
    } catch (error) { this.pending=''; this.assembly=undefined; throw error; }
  }
  finish(): void {
    const rest=this.decoder.decode();
    if (rest || this.pending || this.assembly) throw new Error('incomplete conversation stream');
  }
  private accept(value: any): void {
    if (value?.version!==1) throw new Error('unsupported conversation version');
    if (types.has(value.type)) {
      if (this.assembly) throw new Error('overlapping assembly');
      this.publish(value); return;
    }
    if (value.type==='start') {
      if (this.assembly) throw new Error('overlapping assembly');
      if (typeof value.id!=='string' || !types.has(value.recordType) || !Number.isSafeInteger(value.totalBytes) || value.totalBytes<1 || value.totalBytes>MAX_ASSEMBLY_BYTES) throw new Error('invalid assembly length/type');
      this.assembly={id:value.id,type:value.recordType,total:value.totalBytes,bytes:0,index:0,parts:[],generation:value.generation,revision:value.revision}; return;
    }
    const assembly=this.assembly;
    if (!assembly || value.id!==assembly.id) throw new Error('assembly identity mismatch');
    if (value.type==='chunk') {
      if (value.index!==assembly.index++ || typeof value.data!=='string') throw new Error('assembly chunk order');
      if (!value.data.length) throw new Error('assembly empty chunk');
      assembly.bytes+=utf8.encode(value.data).byteLength;
      if (assembly.bytes>assembly.total) throw new Error('assembly length exceeded');
      assembly.parts.push(value.data); return;
    }
    if (value.type!=='commit' || value.totalBytes!==assembly.total || assembly.bytes!==assembly.total) throw new Error('assembly length mismatch');
    const payload=JSON.parse(assembly.parts.join('')), position=identity(payload);
    if (value.generation!==assembly.generation || value.revision!==assembly.revision || position.generation!==assembly.generation || position.revision!==assembly.revision) throw new Error('assembly revision mismatch');
    this.assembly=undefined; this.publish({version:1,type:assembly.type,payload});
  }
}
