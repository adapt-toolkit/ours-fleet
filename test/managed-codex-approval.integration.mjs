// Real managed daemon/bridge, Fleet ACP adapter, codex-acp and Codex app-server.
// Only the model provider is scripted; it supplies intents, never tool outcomes.
// Run after build: node test/managed-codex-approval.integration.mjs before|after ROOT CODEX
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { attachOursClient } from '@ours.network/sdk/client';
import { prepareManagedAgent, storeTemporaryLaunch } from '../dist/agent-ours/service.js';
import { prepareManagedHarness } from '../dist/agent-ours/harness.js';
import { makeCodexAdapter } from '../dist/harness/codex.js';
const [expectation, rootArg, codexArg] = process.argv.slice(2);
assert(['before', 'after'].includes(expectation));
assert(rootArg && codexArg, 'explicit isolated root and Codex executable required');
const root = resolve(rootArg), codex = resolve(codexArg);
// Refuse to reuse any prior daemon state or identity selection.
mkdirSync(root, { mode: 0o700 });
const state = join(root, 'd'), agentDir = join(root, 'a'), configHome = join(root, 'c');
for (const path of [state, agentDir, configHome]) mkdirSync(path, { recursive: true, mode: 0o700 });
const pause = ms => new Promise(r => setTimeout(r, ms));
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', r));
const portProbe = netServer(); await listen(portProbe);
const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
const instance = randomUUID(), endpoint = `http://127.0.0.1:${port}`;
const credentialPath = join(root, 'token'), profile = join(root, 'profile.json'), config = join(root, 'daemon.json');
writeFileSync(config, JSON.stringify({ stateDir: state, port, apiVisibility: 'owner' }), { mode: 0o600 });
const daemonEnv = { PATH: process.env.PATH, HOME: root, OURS_STATE_DIR: state,
  OURS_PORT: String(port), OURS_DAEMON_ID: instance, OURS_API_VISIBILITY: 'owner',
  OURS_CONFIG: config, OURS_BROKER_URL: 'ws://127.0.0.1:1' };
const daemon = spawn(process.execPath, [resolve('node_modules/@ours.network/daemon/dist/cli.js'), 'daemon', 'serve', '--managed'],
  { env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let daemonLog = '', session, managed, control, gateway;
for (const s of [daemon.stdout, daemon.stderr]) s.on('data', b => { daemonLog = (daemonLog + b).slice(-8000); });
const oldFleetHome = process.env.OURS_FLEET_HOME;
process.env.OURS_FLEET_HOME = join(root, 'f');
const results = [], calls = [], backendCalls = [];
let plan = [], phase = '', sequence = 0, providerError;
const provider = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    const input = JSON.parse(body);
    for (const item of input.input ?? []) if (['function_call_output', 'custom_tool_call_output'].includes(item.type) && !results.some(r => r.call_id === item.call_id)) {
      results.push({ phase, ...item });
      console.log('TOOL_RESULT', item.call_id, JSON.stringify(item.output));
    }
    const next = plan[0], id = `resp_${++sequence}`;
    const output = next ? { type: 'custom_tool_call', id: `fc_${sequence}`, call_id: `${phase}_${next.name}`,
      name: 'exec', namespace: 'functions', input: `text(await tools.mcp__ours__${next.name}(${JSON.stringify(next.args ?? {})}));` } :
      { type: 'message', id: `msg_${sequence}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Probe complete.' }] };
    if (next) {
      const available = body.includes('functions') && body.includes('exec');
      assert(available, `missing real MCP tool ${next.name}`);
      plan.shift();
      calls.push({ phase, name: next.name });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
    emit({ type: 'response.output_item.added', output_index: 0, item: next ? { ...output, input: '' } : output });
    emit({ type: 'response.output_item.done', output_index: 0, item: output });
    emit({ type: 'response.completed', response: { id, status: 'completed', output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  } catch (e) { providerError = e; console.log('PROVIDER_ERROR', String(e)); res.writeHead(400); res.end(String(e)); }
});
await listen(provider);
const modelUrl = `http://127.0.0.1:${provider.address().port}/v1`;
// Observe actual requests arriving at real Codex, after Fleet's policy proxy.
const tap = join(root, 'tap.mjs'), wrapper = join(root, 'codex');
writeFileSync(tap, `import {spawn} from 'node:child_process';\nimport {createInterface} from 'node:readline';\nimport {appendFileSync} from 'node:fs';\nconst p=spawn(${JSON.stringify(codex)},process.argv.slice(2),{stdio:['pipe','pipe','inherit']});\np.stdout.pipe(process.stdout);\ncreateInterface({input:process.stdin}).on('line',line=>{try{const v=JSON.parse(line);if(['thread/start','thread/resume','turn/start'].includes(v.method))appendFileSync(${JSON.stringify(join(root, 'requests.jsonl'))},JSON.stringify(v)+'\\n');}catch{}p.stdin.write(line+'\\n')}).on('close',()=>p.stdin.end());\nprocess.on('SIGTERM',()=>p.kill('SIGTERM'));p.on('close',c=>{process.exitCode=c;process.stdin.destroy()});\n`);
writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${tap}' "$@"\n`, { mode: 0o700 });
const timeout = setTimeout(() => { console.error('bounded probe timeout'); daemon.kill('SIGKILL'); process.exit(1); }, 120_000);
try {
  let ready = false;
  for (let i = 0; i < 200; i++) {
    assert.equal(daemon.exitCode, null, daemonLog);
    try { const r = await fetch(endpoint + '/selection', { signal: AbortSignal.timeout(100) });
      if (r.ok && (await r.json()).instanceId === instance) { ready = true; break; } } catch {}
    await pause(100);
  }
  assert(ready, 'daemon timeout: ' + daemonLog);
  copyFileSync(join(state, 'daemon-token'), credentialPath);
  control = await attachOursClient({ endpoint, expectedInstanceId: instance, credentialPath, sessionMode: 'local', requiredCapabilities: ['local-pid-v1'] });
  await control.createRootIdentity({ skipIfRootExists: true, name: 'TestRoot', bio: 'isolated fixture', exposeLocal: true, localAutoAccept: true });
  gateway = createServer(async (req, res) => {
    if (!req.url.startsWith('/daemon/')) { res.writeHead(404).end(); return; }
    backendCalls.push({ phase, method: req.method, path: req.url });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    try {
      const upstream = await fetch(endpoint + req.url.slice('/daemon'.length), {
        method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { res.writeHead(502).end(); }
  });
  await listen(gateway);
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  writeFileSync(profile, JSON.stringify({ serverUrl, endpoint: serverUrl + '/daemon', expectedInstanceId: instance, credentialPath }), { mode: 0o600 });
  const role = { name: 'Agent' , identity: 'Agent', harness: 'codex', session: 'acp', model: 'gpt-5.6-sol',
    sourceFile: 'test', harness_options: { sandbox: 'workspace-write' },
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    env: { OURS_CONFIG: profile, CODEX_PATH: wrapper } };
  writeFileSync(join(agentDir, '.identity'), 'Agent');
  storeTemporaryLaunch(role, 'approval-probe');
  managed = await prepareManagedAgent(role, agentDir, true);
  const cid = managed.runtime.snapshot.cid;
  const adapter = makeCodexAdapter();
  const configOverride = { model: role.model, model_provider: 'fixture',
    model_providers: { fixture: { name: 'fixture', base_url: modelUrl, wire_api: 'responses', requires_openai_auth: false } },
    features: { shell_tool: false, js_repl: false },
  };
  writeFileSync(join(configHome, 'config.toml'), `model_provider = \"fixture\"\n[model_providers.fixture]\nname = \"fixture\"\nbase_url = ${JSON.stringify(modelUrl)}\nwire_api = \"responses\"\nrequires_openai_auth = false\n`);
  let firstSession;
  for (const mode of ['fresh', 'resume']) {
    phase = mode;
    plan = ['current_identity', 'get_messages', 'list_history', 'list_contacts'].map(name => ({ name }));
    plan.push({ name: 'send_message', args: { contact: 'TestRoot', text: `isolated-${mode}` } });
    plan.push({ name: 'set_bio', args: { bio: 'SHOULD_NOT_CHANGE' } });
    const prep = await adapter.prepareSession(role, { stateDir: agentDir, runCwd: root });
    const harness = prepareManagedHarness(role, agentDir, root, managed.descriptor, {
      ...prep.env, MODEL_PROVIDER: 'fixture', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost', HOME: root, CODEX_HOME: configHome, CODEX_CONFIG: JSON.stringify(configOverride),
      OPENAI_API_KEY: 'fixture-unused', OPENAI_BASE_URL: modelUrl,
      DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key', _meta: { 'api-key': { apiKey: 'fixture-unused' } } }),
    });
    // Do not inherit production runtime credentials or unrelated connector settings.
    const env = Object.fromEntries(Object.entries(harness.env).filter(([k]) =>
      ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','MODEL_PROVIDER','PATH','HOME','CODEX_HOME','CODEX_CONFIG','CODEX_PATH','FLEET_OURS_MANAGED','DISABLE_MCP_CONFIG_FILTERING','INITIAL_AGENT_MODE','OPENAI_API_KEY','OPENAI_BASE_URL','DEFAULT_AUTH_REQUEST'].includes(k) || k.startsWith('OURS_FLEET_CODEX_') || k === 'OURS_FLEET_REAL_CODEX_PATH'));
    const launch = adapter.agentSession.prepareLaunch(role, { ...prep, env });
    console.log('PREVIEW', JSON.stringify(adapter.effectivePermissions(role)));
    const start = () => adapter.agentSession.start({ role, prep, launch, managedOurs: harness.ours,
      cwd: root, stateDir: agentDir, mode, permissions: role.permissions,
      permissionMode: adapter.effectivePermissionMode(role), log: line => console.log('ACP', line) });
    if (mode === 'fresh') await managed.runtime.startHarness(async () => { session = await start(); });
    else session = await start();
    const sessionId = session.snapshot().sessionId;
    if (mode === 'fresh') firstSession = sessionId; else assert.equal(sessionId, firstSession, 'resume same thread');
    const outcome = await session.submitPrompt('Run the isolated approval fixture tool sequence.');
    assert.ifError(providerError);
    assert.equal(outcome.succeeded, true, JSON.stringify(outcome));
    assert.equal(plan.length, 0);
    await session.close(); session = undefined;
    const rows = results.filter(r => r.phase === mode);
    assert.equal(rows.length, 6);
    for (const row of rows) {
      const denial = JSON.stringify(row.output).includes('MCP tool call requires approval, but approval policy is never');
      assert.equal(denial, expectation === 'before' || row.call_id.endsWith('_set_bio'), row.call_id + ': ' + JSON.stringify(row.output));
      if (expectation === 'after' && !row.call_id.endsWith('_set_bio')) {
        const result = row.output.map(b => { try { return JSON.parse(b.text); } catch { return null; } })
          .find(b => b && Array.isArray(b.content));
        assert(result, 'missing MCP result ' + row.call_id);
        assert.equal(result.isError, false, JSON.stringify(result));
        if (row.call_id.endsWith('_current_identity')) assert(JSON.stringify(result).includes(cid));
      }
    }
    console.log('PHASE_PASS', mode, cid);
  }
  const requests = readFileSync(join(root, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(requests.some(r => r.method === 'thread/start'));
  assert(requests.some(r => r.method === 'thread/resume'));
  for (const r of requests.filter(r => r.method === 'turn/start')) {
    assert.equal(r.params.approvalPolicy, 'never');
    assert.equal(r.params.sandboxPolicy.type, 'workspaceWrite');
  }
  for (const r of requests.filter(r => ['thread/start', 'thread/resume'].includes(r.method) && !r.params.ephemeral)) {
    const server = r.params.config.mcp_servers.ours;
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [resolve('dist/agent-ours/bridge.js')]);
    assert.equal(server.env.FLEET_OURS_BRIDGE_DESCRIPTOR, managed.descriptor);
    assert(!('default_tools_approval_mode' in server));
    if (expectation === 'before') assert(!('tools' in server));
    else assert.deepEqual(server.tools, Object.fromEntries([
      'current_identity', 'get_messages', 'list_history', 'list_contacts', 'send_message',
    ].map(name => [name, { approval_mode: 'approve' }])));
  }
  const identities = await control.listIdentities();
  const agent = identities.find(i => i.name === 'Agent');
  assert(agent && JSON.stringify(agent).includes(cid));
  // The denied mutation must never reach the actual daemon backend.
  assert(!backendCalls.some(c => c.path === '/daemon/api/v1/setBio'));
  const received = await control.getMessages();
  const receivedText = JSON.stringify(received);
  if (expectation === 'after') {
    for (const mode of ['fresh', 'resume']) {
      const message = received.messages.find(m => m.text === `isolated-${mode}`);
      assert(message, 'recipient did not receive ' + mode);
      assert.equal(message.from.id, cid, 'authenticated sender CID');
    }
  }
  else assert(!receivedText.includes('isolated-'));
  writeFileSync(join(root, 'summary.json'), JSON.stringify({ expectation, cid, calls, results,
    threadMethods: requests.map(r => r.method), backendCalls, recipientVerified: true }, null, 2));
  console.log('PASS', expectation, 'actual managed ACP fresh/resume, explicit workspace-write, approval allow, unattended deny');
} finally {
  clearTimeout(timeout);
  await session?.close(); await managed?.close(false); await control?.close();
  daemon.kill('SIGTERM');
  await Promise.race([new Promise(r => daemon.once('exit', r)), pause(3000).then(() => daemon.kill('SIGKILL'))]);
  gateway?.closeAllConnections(); if (gateway) await new Promise(r => gateway.close(r));
  provider.closeAllConnections(); await new Promise(r => provider.close(r));
  if (oldFleetHome === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = oldFleetHome;
}
