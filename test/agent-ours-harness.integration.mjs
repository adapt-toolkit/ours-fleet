// Real installed harness processes; discovery only, no model turn or production home.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, connect } from 'node:net';
import { createInterface } from 'node:readline';
import { startMcpEndpoint } from '../dist/agent-ours/mcp-endpoint.js';
import { prepareManagedHarness } from '../dist/agent-ours/harness.js';
const mode = process.argv[2] ?? 'codex-native';
const root = mkdtempSync(join(tmpdir(), 'fleet-harness-'));
let child, endpoint, proxy;
let diagnostic = '';
const pending = new Map();
let seq = 0;
const discoveries = [];
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('timeout ' + method + ' ' + diagnostic.slice(-1500)));
    }, 25000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
try {
  const socket = join(root, 'real.sock'),
    relay = join(root, 'relay.sock'),
    descriptor = join(root, 'descriptor.json');
  endpoint = await startMcpEndpoint({
    socket,
    capability: 'fixture',
    generation: 1,
    runtime: { admit: async () => () => {} },
    client: { currentIdentity: async () => ({ name: 'Agent', cid: 'CID', described: false }) },
    identities: { list: async () => ['Agent'] },
    remoteDaemonFiles: true,
  });
  proxy = createServer((down) => {
    const up = connect(socket);
    down.pipe(up);
    up.pipe(down);
    let buffer = '';
    up.on('data', (b) => {
      buffer += b;
      for (;;) {
        const n = buffer.indexOf('\n');
        if (n < 0) break;
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        try {
          const f = JSON.parse(line);
          if (f.kind === 'mcp' && f.value?.result?.tools) discoveries.push(f.value.result.tools);
        } catch {}
      }
    });
    down.on('error', () => up.destroy());
    up.on('error', () => down.destroy());
    down.on('close', () => up.destroy());
  });
  await new Promise((r) => proxy.listen(relay, r));
  writeFileSync(
    descriptor,
    JSON.stringify({ socket: relay, capability: 'fixture', generation: 1 }),
  );
  const harness = mode.startsWith('codex') ? 'codex' : mode === 'claude' ? 'claude-code' : 'hermes';
  const configHome = join(root, 'config');
  mkdirSync(configHome);
  const prepared = prepareManagedHarness({ harness }, root, root, descriptor, {
    HOME: root,
    CODEX_HOME: configHome,
    CLAUDE_CONFIG_DIR: configHome,
    HERMES_HOME: configHome,
    HERMES_ACP_SKIP_CONFIGURED_MCP: '1',
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: 'test-only-unused',
    OPENAI_API_KEY: 'test-only-unused',
    OPENAI_BASE_URL: 'http://127.0.0.1:1',
  });
  if (mode === 'hermes')
    writeFileSync(
      join(configHome, 'config.yaml'),
      'model:\n  default: fixture\n  context_length: 65536\n  provider: custom\n  base_url: http://127.0.0.1:1\n',
    );
  const argv =
    mode === 'codex-native'
      ? [process.env.FLEET_CODEX_BIN ?? '/home/fleet/.local/bin/codex', 'app-server']
      : mode === 'codex-acp'
        ? [process.execPath, resolve('node_modules/@agentclientprotocol/codex-acp/dist/index.js')]
        : mode === 'claude'
          ? [
              process.execPath,
              resolve('node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'),
            ]
          : [process.env.FLEET_HERMES_BIN];
  if (mode === 'codex-acp')
    prepared.env.CODEX_PATH = process.env.FLEET_CODEX_BIN ?? '/home/fleet/.local/bin/codex';
  child = spawn(argv[0], argv.slice(1), {
    cwd: root,
    env: prepared.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => {
    diagnostic = (diagnostic + b).slice(-30000);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const value = JSON.parse(line),
        p = pending.get(value.id);
      if (p) {
        pending.delete(value.id);
        value.error ? p.reject(Error(JSON.stringify(value.error))) : p.resolve(value.result);
      }
    } catch {}
  });
  if (mode === 'codex-native') {
    await request('initialize', {
      clientInfo: { name: 'fleet_managed_probe', version: '1' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
    const thread = await request('thread/start', {
      cwd: root,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      config: prepared.ours.native,
    });
    const status = await request('mcpServerStatus/list', { threadId: thread.thread.id });
    assert(status.data.some((s) => s.name === 'ours'));
  } else {
    await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'fleet-probe', version: '1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (mode === 'codex-acp')
      await request('authenticate', {
        methodId: 'api-key',
        _meta: { 'api-key': { apiKey: 'test-only-unused' } },
      });
    await request('session/new', {
      cwd: root,
      mcpServers: [prepared.ours.server],
      ...(mode === 'claude'
        ? {
            _meta: {
              claudeCode: {
                options: { settings: { enabledPlugins: { 'ours@ours.network': false } } },
              },
            },
          }
        : {}),
    });
  }
  const until = Date.now() + 15000;
  while (!discoveries.length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert(discoveries.length, `no MCP discovery from ${mode}: ${diagnostic.slice(-30000)}`);
  const names = discoveries.at(-1).map((t) => t.name);
  assert.equal(names.length, 27);
  assert(names.includes('send_message'));
  assert(!names.includes('choose_identity'));
  assert(!names.includes('create_temporary_identity'));
  console.log(
    `PASS real ${mode}: session startup discovered 27 managed ours tools before any model turn`,
  );
} finally {
  if (child) {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((r) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        r();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        r();
      });
    });
  }
  for (const p of pending.values()) p.reject(Error('probe closed'));
  await endpoint?.close();
  proxy?.close();
  rmSync(root, { recursive: true, force: true });
}
