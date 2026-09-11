import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const COMMIT = 'd15ed4445207dda418b984e8bda0f68f48b8c6f3';
type Wire = Record<string, any>;

export async function createNativeHermesFixture() {
  const source = resolve(process.env.HERMES_ACP_TEST_SOURCE ?? join(homedir(), '.hermes/hermes-agent'));
  const executable = process.env.HERMES_ACP_TEST_EXECUTABLE ?? join(source, 'venv/bin/hermes-acp');
  try {
    await access(executable);
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== COMMIT)
      throw new Error(`Expected tested Hermes commit ${COMMIT}`);
    if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8' }).trim())
      throw new Error('Hermes source has tracked changes');
    try { await lstat(join(source, '.env')); throw new Error('Hermes checkout .env must be absent to isolate credentials'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } catch (error) {
    throw new Error(`Required native Hermes fixture unavailable or incompatible: ${String(error)}. Set HERMES_ACP_TEST_SOURCE and HERMES_ACP_TEST_EXECUTABLE to the tested installed artifact.`);
  }
  const root = await mkdtemp(join(tmpdir(), 'fleet-hermes-conformance-'));
  const home = join(root, 'hermes'); const userHome = join(root, 'user'); const cwd = join(root, 'project');
  await Promise.all([home, userHome, cwd].map(path => mkdir(path, { mode: 0o700 })));
  const requests: Wire[] = []; const children: NativeChild[] = [];
  let terminalCommand: string | undefined;
  let nextTool: { name: string; arguments: Record<string, unknown> } | undefined;
  let toolSequence = 0;
  let hold = false; let held: (() => void) | undefined; let heldSignal: (() => void) | undefined;
  let heldPromise = Promise.resolve();
  const sendStream = (response: ServerResponse, model: string) => {
    const command = terminalCommand; terminalCommand = undefined;
    const call = nextTool ?? (command ? { name: 'terminal', arguments: { command } } : undefined); nextTool = undefined;
    const deltas = call
      ? [[{ role: 'assistant', tool_calls: [{ index: 0, id: `fixture-call-${++toolSequence}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, null], [{}, 'tool_calls']]
      : [[{ role: 'assistant', content: 'fixture reply' }, null], [{}, 'stop']];
    for (const [delta, finish] of deltas) {
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model,
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [] })); return;
    }
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
        if (hold) { hold = false; held = () => sendStream(response, body.model); heldSignal?.(); }
        else sendStream(response, body.model);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'chatcmpl-title', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ title: 'Deterministic fixture session' }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
      }
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture listen address');
  const providerUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    root, home, cwd, userHome, executable, source, providerUrl,
    callToolNext(name: string, args: Record<string, unknown>) { nextTool = { name, arguments: args }; },
    callTerminalNext(command: string) { terminalCommand = command; },
    async start(model: string, wrap?: (argv: string[]) => string[], mcpServers: Wire[] = []) {
      if (children.some(child => !child.stopped)) throw new Error('Previous Hermes process must be dead before restart');
      await writeFile(join(home, 'config.yaml'), JSON.stringify({
        model: { default: model, provider: 'custom', base_url: providerUrl, api_key: 'fixture-dummy', context_length: 131072 },
        approvals: { mode: 'manual' }, compression: { enabled: false }, plugins: { enabled: [] }, mcp_servers: {}, terminal: { env: 'local' },
      }), { mode: 0o600 });
      const argv = wrap?.([executable]) ?? [executable];
      const child = new NativeChild(spawn(argv[0], argv.slice(1), { cwd, env: {
        PATH: '/usr/local/bin:/usr/bin:/bin', HOME: userHome, HERMES_HOME: home, LANG: 'C.UTF-8',
        PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', HERMES_ACP_SKIP_CONFIGURED_MCP: '1',
      }, stdio: 'pipe' })); children.push(child);
      child.initialize = await child.rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'fleet-conformance', version: '1' } });
      child.session = await child.rpc('session/new', { cwd, mcpServers }); return child;
    },
    toolResults: () => requests.flatMap(request => request.messages ?? []).filter(message => message.role === 'tool').map(message => message.content).join('\n'),
    inferenceTools: () => (requests.find(request => request.stream)?.tools ?? []).map((tool: Wire) => tool.function.name),
    inferenceModels: () => requests.filter(request => request.stream).map(request => request.model),
    async writeRetainedMarker() { await writeFile(join(home, 'fleet-retained-fixture.txt'), 'retained across fresh sessions'); },
    readRetainedMarker: () => readFile(join(home, 'fleet-retained-fixture.txt'), 'utf8'),
    async nativeProvider() { return JSON.parse(await readFile(join(home, 'config.yaml'), 'utf8')).model.provider; },
    holdNextInference() { hold = true; heldPromise = new Promise<void>(done => { heldSignal = done; }); },
    async waitForHeldInference() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([heldPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No held provider request')), 20_000); })]); }
      finally { clearTimeout(timer); }
    },
    releaseHeldInference() { held?.(); held = undefined; },
    async close() {
      held?.();
      await Promise.all(children.map(child => child.stop()));
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

class NativeChild {
  initialize: Wire = {}; session: Wire = {}; stopped = false;
  private permissionAnswer: string | undefined;
  private nextId = 0; private messages: Wire[] = []; private stderr = '';
  private pending = new Map<number, { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-12_000); });
    createInterface({ input: child.stdout }).on('line', line => {
      let message: Wire; try { message = JSON.parse(line); } catch { return; }
      this.messages.push(message);
      if (message.method === 'session/request_permission') {
        if (this.permissionAnswer) this.answerPermission(message.id, this.permissionAnswer);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
    });
    const fail = (error: Error) => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); };
    child.on('error', fail);
    child.on('exit', code => { this.stopped = true; fail(new Error(`Hermes exited ${code}: ${this.stderr}`)); });
  }
  rpc(method: string, params: Wire): Promise<Wire> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Hermes ${method} timeout: ${this.stderr}`)); }, 80_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method: string, params: Wire) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  prompt(text: string) { return this.rpc('session/prompt', { sessionId: this.session.sessionId, prompt: [{ type: 'text', text }] }); }
  output() { return this.messages.filter(message => message.params?.update?.sessionUpdate === 'agent_message_chunk').map(message => message.params.update.content.text).join(''); }
  setPermissionAnswer(option: string | undefined) { this.permissionAnswer = option; }
  permissionRequests() { return this.messages.filter(message => message.method === 'session/request_permission'); }
  answerPermission(id: number, optionId: string) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } })}\n`);
  }
  toolStarts() { return this.messages.filter(message => message.params?.update?.sessionUpdate === 'tool_call').map(message => message.params.update.title); }
  diagnostics() { return JSON.stringify(this.messages) + "\n" + this.stderr; }
  toolOutput() { return this.messages.filter(message => message.params?.update?.sessionUpdate === 'tool_call_update').map(message => JSON.stringify(message.params.update)).join('\n'); }
  async stop() {
    if (this.stopped) return;
    await new Promise<void>(done => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 3_000);
      this.child.once('exit', () => { clearTimeout(timer); done(); }); this.child.kill('SIGTERM');
    });
  }
}
