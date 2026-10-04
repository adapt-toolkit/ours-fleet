// One real harness turn through Fleet's own launch preparation. A scripted local
// provider only asks for the command; real Codex / Claude Code decide whether it
// runs inside or outside their command sandbox from what Fleet generated.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCodexAdapter } from '../dist/harness/codex.js';
import { makeClaudeCodeAdapter } from '../dist/harness/claude-code.js';
import { prepareManagedCliLaunch } from '../dist/managed-cli.js';
import { harnessChildEnv } from '../dist/runner.js';
import { AcpSession } from '../dist/session/acp.js';

const listen = server => new Promise(done => server.listen(0, '127.0.0.1', done));
const close = async server => { server.closeAllConnections(); await new Promise(done => server.close(done)); };

/** The steps runOnce performs between resolving a role and starting its session. */
async function prepare(adapter, role, { stateDir, cwd, configPath, deps, env, log }) {
  const managed = { ...role, monitor: { ...role.monitor, mode: 'fleet' } };
  const adapterPrep = await adapter.prepareSession(managed, { stateDir, runCwd: cwd });
  const prep = prepareManagedCliLaunch(managed, {
    stateDir, runCwd: cwd, configPath, prep: adapterPrep, log, ...(deps ? { deps } : {}),
  });
  prep.env = { ...env, ...prep.env };
  const launch = adapter.agentSession.prepareLaunch(managed, prep);
  // The real proxy pair: this is what makes the child CLI audit through the supervisor.
  launch.env = { ...harnessChildEnv(managed, launch.env, stateDir), FLEET_OURS_MANAGED: '1' };
  return { role: managed, prep, launch };
}

export async function runCodexTurn({ codex, root, role, stateDir, cwd, configPath, deps, env, command }) {
  const configHome = join(root, 'codex-home');
  mkdirSync(configHome, { recursive: true });
  let sent = false, result, providerError, sequence = 0, log = '';
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      for (const item of request.input ?? []) if (item.type === 'custom_tool_call_output') result = item.output;
      const execution = (Array.isArray(result) ? result : []).map(b => { try { return JSON.parse(b.text); } catch { return undefined; } })
        .find(v => v?.session_id !== undefined || v?.exit_code !== undefined);
      const pending = execution?.session_id !== undefined && execution?.exit_code === undefined;
      const call = !sent || pending; sent = true; sequence++;
      const toolInput = pending
        ? `text(await tools.write_stdin(${JSON.stringify({ session_id: execution.session_id, chars: '', yield_time_ms: 1000 })}));`
        : `text(await tools.exec_command(${JSON.stringify({ cmd: command, login: false, yield_time_ms: 20000 })}));`;
      const output = call
        ? { type: 'custom_tool_call', id: `fc_${sequence}`, call_id: `call_${sequence}`, name: 'exec', namespace: 'functions', input: toolInput }
        : { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      emit({ type: 'response.created', response: { id: `resp_${sequence}`, status: 'in_progress', output: [] } });
      emit({ type: 'response.output_item.added', output_index: 0, item: output });
      emit({ type: 'response.output_item.done', output_index: 0, item: output });
      emit({ type: 'response.completed', response: { id: `resp_${sequence}`, status: 'completed', output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    } catch (error) { providerError = error; res.writeHead(400).end(String(error)); }
  });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  // The operator's Codex home: a local provider and the trust they granted this workspace.
  writeFileSync(join(configHome, 'config.toml'), `model="gpt-5.6-sol"
model_provider="fixture"
[sandbox_workspace_write]
exclude_slash_tmp=true
exclude_tmpdir_env_var=true
[model_providers.fixture]
name="fixture"
base_url="${base}"
wire_api="responses"
requires_openai_auth=false
[projects.${JSON.stringify(cwd)}]
trust_level="trusted"
`);
  let session, timeout;
  try {
    const adapter = makeCodexAdapter(undefined, options => AcpSession.start({ ...options, inheritEnvironment: false }));
    const prepared = await prepare(adapter, role, { stateDir, cwd, configPath, deps, log: line => { log += `${line}\n`; },
      env: { ...env, CODEX_HOME: configHome, OPENAI_API_KEY: 'fixture-unused', OPENAI_BASE_URL: base,
        DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key', _meta: { 'api-key': { apiKey: 'fixture-unused' } } }) } });
    session = await adapter.agentSession.start({ ...prepared, cwd, stateDir, mode: 'fresh',
      permissions: prepared.role.permissions, permissionMode: adapter.effectivePermissionMode(prepared.role),
      log: line => { log += `${line}\n`; } });
    timeout = setTimeout(() => session.close(), 180000);
    const outcome = await session.submitPrompt('Run the isolated fixture command.');
    assert.equal(outcome.succeeded, true, `${command}\n${JSON.stringify(outcome)}${log}`);
    assert.ifError(providerError);
    const blocks = Array.isArray(result) ? result : [{ text: result }];
    const execution = blocks.map(b => { try { return JSON.parse(b.text); } catch { return undefined; } }).find(v => v?.exit_code !== undefined);
    assert(execution, `No completed real shell execution: ${JSON.stringify(result)}${log}`);
    return { exitCode: execution.exit_code, output: String(execution.output ?? ''), log };
  } finally { clearTimeout(timeout); await session?.close(); await close(server); }
}

export async function runClaudeTurn({ claude, root, role, stateDir, cwd, configPath, deps, env, command, userSettings }) {
  // The operator's own Claude settings. Fleet's entries are NOT here: they arrive
  // only through the per-role overlay that prepareManagedCliLaunch writes.
  const configHome = join(root, 'claude-home');
  mkdirSync(configHome, { recursive: true });
  writeFileSync(join(configHome, 'settings.json'), JSON.stringify(userSettings));
  let result, calls = 0, error, log = '';
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":10}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404).end(); return; }
      const input = JSON.parse(body);
      for (const m of input.messages ?? []) for (const c of Array.isArray(m.content) ? m.content : [])
        if (c.type === 'tool_result' && c.tool_use_id === 'tool_fixture') result = c;
      const runnable = input.tools?.some(t => t.name === 'Bash');
      const call = runnable && !result && calls++ === 0;
      const content = call
        ? { type: 'tool_use', id: 'tool_fixture', name: 'Bash', input: { command, timeout: 120000, description: 'Isolated Fleet managed CLI fixture' } }
        : { type: 'text', text: 'Fixture complete.' };
      const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
      if (!input.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message, content: [content], stop_reason: call ? 'tool_use' : 'end_turn' })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      emit('message_start', { message });
      emit('content_block_start', { index: 0, content_block: call ? { ...content, input: {} } : { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
      emit('message_stop', {}); res.end();
    } catch (e) { error = e; res.writeHead(500).end(String(e)); }
  });
  await listen(server);
  // Fresh HOME/settings, a fake key and a local endpoint: no production account or state.
  const launchEnv = { ...env, HOME: root, CLAUDE_CONFIG_DIR: configHome, ANTHROPIC_API_KEY: 'fixture-unused',
    ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_USE_FOUNDRY: '0', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_EXECUTABLE: claude };
  let session, timer;
  try {
    const adapter = makeClaudeCodeAdapter(undefined, options => AcpSession.start({ ...options, inheritEnvironment: false }));
    const prepared = await prepare(adapter, { ...role, env: { ...role.env, ...launchEnv } },
      { stateDir, cwd, configPath, deps, env: launchEnv, log: line => { log += `${line}\n`; } });
    prepared.launch.env = { ...prepared.launch.env, CLAUDE_CODE_EXECUTABLE: claude };
    session = await adapter.agentSession.start({ ...prepared, cwd, stateDir, mode: 'fresh',
      permissions: prepared.role.permissions, permissionMode: adapter.effectivePermissionMode(prepared.role),
      log: line => { log += `${line}\n`; } });
    timer = setTimeout(() => session.close(), 180000);
    const outcome = await session.submitPrompt('Run the isolated Fleet fixture command.');
    assert.equal(outcome.succeeded, true, JSON.stringify(outcome) + log);
    assert.ifError(error); assert(result, `No real Bash result: ${log}`);
    const output = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    return { exitCode: result.is_error ? 1 : 0, output, log };
  } finally { clearTimeout(timer); await session?.close(); await close(server); }
}
