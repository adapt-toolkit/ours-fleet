import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export class OursMcpError extends Error {}

export interface OursToolClient {
  start(): Promise<void>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Minimal MCP stdio client. One instance owns exactly one ours identity binding. */
export class OursMcpClient implements OursToolClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly command = 'ours-mcp',
    private readonly env: Record<string, string> = {},
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    const child = spawn(this.command, ['proxy'], {
      env: {
        ...process.env,
        ...this.env,
        // Bindings are keyed by this value. Sharing it would silently rebind a
        // role's normal mailbox or another owner channel.
        CLAUDE_CODE_SESSION_ID: `ours-fleet-owner-${process.pid}-${randomUUID()}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    this.child = child;
    child.stdin.on('error', error => this.log(`ours-mcp stdin: ${error.message}`));
    createInterface({ input: child.stderr }).on('line', line => this.log(`ours-mcp: ${line}`));
    try {
      await this.request('initialize', {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'ours-fleet-owner-channel', version: '1' },
      });
      await this.notify('notifications/initialized', {});
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.request('tools/call', { name, arguments: args }) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = (result.content ?? [])
      .filter(item => item.type === 'text').map(item => item.text ?? '').join('\n').trim();
    if (result.isError) throw new OursMcpError(text || `ours tool ${name} failed`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (!text) return {};
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const run = this.tail.then(() => this.requestNow(method, params));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async requestNow(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new OursMcpError('ours-mcp proxy is not running');
    const id = ++this.nextId;
    await this.write(child, { jsonrpc: '2.0', id, method, params });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let response: { id?: number; result?: unknown; error?: unknown };
        try { response = JSON.parse(line) as typeof response; } catch { continue; }
        if (response.id !== id) continue;
        if (response.error !== undefined) throw new OursMcpError(JSON.stringify(response.error));
        return response.result ?? {};
      }
      throw new OursMcpError('ours-mcp proxy closed its output');
    } finally {
      lines.close();
    }
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new OursMcpError('ours-mcp proxy is not running');
    await this.write(child, { jsonrpc: '2.0', method, params });
  }

  private write(child: ChildProcessWithoutNullStreams, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      child.stdin.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve());
    });
  }
}
