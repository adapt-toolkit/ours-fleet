/** Public App Server inventory of the exact thread, before each opt-in turn. */
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = (line: string): ObjectValue | undefined => { try { const v: unknown = JSON.parse(line); return object(v) ? v : undefined; } catch { return undefined; } };
interface Check { request: ObjectValue; threadId: string; servers: ObjectValue[]; cursors: Set<string>; timer: ReturnType<typeof setTimeout>; }
export class CodexFileInventory {
  private checks = new Map<string, Check>();
  private sequence = 0;
  constructor(private readonly sendToCodex: (line: string) => void, private readonly emitToClient: (line: string) => void) {}
  /** Hold only a turn/start; unrelated tools/configuration are preserved. */
  observeClientLine(line: string): boolean {
    const message = parse(line);
    if (message?.method !== 'turn/start') return true;
    const threadId = object(message.params) ? message.params.threadId : undefined;
    if (typeof threadId !== 'string' || !threadId || message.id === undefined || this.checks.size >= 8) {
      this.reject(message); return false;
    }
    const check: Check = { request: message, threadId, servers: [], cursors: new Set(), timer: setTimeout(() => {
      for (const [id, c] of this.checks) if (c === check) this.checks.delete(id);
      this.reject(message);
    }, 30_000) };
    this.query(check); return false;
  }
  observeServerLine(line: string): boolean {
    const message = parse(line), id = message?.id;
    if (typeof id !== 'string') return true;
    const check = this.checks.get(id); if (!check) return true;
    this.checks.delete(id);
    const result = message?.result;
    if (!object(result) || !Array.isArray(result.data) || result.data.some(s => !object(s)) || check.servers.length + result.data.length > 1000) {
      this.finish(check, false); return false;
    }
    check.servers.push(...result.data as ObjectValue[]);
    if (result.nextCursor !== null) {
      const cursor = result.nextCursor;
      if (typeof cursor !== 'string' || !cursor || check.cursors.has(cursor) || check.cursors.size >= 10) this.finish(check, false);
      else { check.cursors.add(cursor); this.query(check, cursor); }
      return false;
    }
    this.finish(check, this.qualified(check.servers)); return false;
  }
  close(): void { for (const c of this.checks.values()) clearTimeout(c.timer); this.checks.clear(); }
  private query(check: Check, cursor?: string): void {
    const id = `ours-fleet-file-inventory-${++this.sequence}`; this.checks.set(id, check);
    this.sendToCodex(JSON.stringify({ id, method: 'mcpServerStatus/list', params: { threadId: check.threadId, detail: 'full', limit: 100, ...(cursor ? {cursor} : {}) } }));
  }
  private qualified(servers: ObjectValue[]): boolean {
    let managed = 0;
    for (const server of servers) {
      // Unknown or failed discovery cannot establish absence of another connector.
      if (server.toolsError !== null || !object(server.tools)) return false;
      if (!object(server.serverInfo) || typeof server.serverInfo.name !== 'string') return false;
      const tools = Object.values(server.tools).filter(object);
      const names = new Set(tools.map(t => t.name));
      if (server.name !== 'ours') {
        if (server.serverInfo.name === 'ours') return false;
        if (tools.some(t => t.name === 'send_file' && object(t.inputSchema) && object(t.inputSchema.properties) && 'contact' in t.inputSchema.properties)) return false;
        if (names.has('current_identity') && names.has('send_file') && names.has('get_messages')) return false;
        continue;
      }
      managed++;
      if (server.serverInfo.name !== 'ours' || server.runtimeStatus !== 'connected') return false;
      const files = tools.filter(t => t.name === 'send_file');
      if (files.length !== 1 || !object(files[0].inputSchema)) return false;
      const schema = files[0].inputSchema;
      if (!object(schema.properties) || !object(schema.properties.contact) || schema.additionalProperties !== false
          || (Array.isArray(schema.required) && schema.required.includes('contact'))) return false;
    }
    return managed === 1;
  }
  private finish(check: Check, allowed: boolean): void {
    clearTimeout(check.timer);
    if (allowed) this.sendToCodex(JSON.stringify(check.request)); else this.reject(check.request);
  }
  private reject(request: ObjectValue): void {
    this.emitToClient(JSON.stringify({id: request.id, error: {code: -32000, message: 'CURRENT_CHAT_DELIVERY_UNAVAILABLE: unqualified MCP inventory'}}));
  }
}
