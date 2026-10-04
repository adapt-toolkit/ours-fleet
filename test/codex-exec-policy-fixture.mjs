// Scripted provider controls tool requests only. Real Codex executes every command.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeCodexAdapter } from '../dist/harness/codex.js';
import { AcpSession } from '../dist/session/acp.js';
import assert from 'node:assert/strict';
export const quote = value => /^[A-Za-z0-9_./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
export async function executeWithRules({ codex, root, cwd, env, rules, command }) {
  const configHome = join(root, 'codex-fixture');
  mkdirSync(configHome, { recursive: true });
  mkdirSync(join(cwd, '.codex', 'rules'), { recursive: true });
  writeFileSync(join(cwd, '.codex', 'rules', 'fleet.rules'), rules);
  let sent = false, result, providerError, sequence = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      for (const item of request.input ?? []) if (item.type === 'custom_tool_call_output') result = item.output;
      const execution = (Array.isArray(result) ? result : []).map(b => { try { return JSON.parse(b.text); } catch { return undefined; } }).find(v => v?.session_id !== undefined || v?.exit_code !== undefined);
      const pending = execution?.session_id !== undefined && execution?.exit_code === undefined;
      const call = !sent || pending; sent = true; sequence++;
      const toolInput = pending
        ? `text(await tools.write_stdin(${JSON.stringify({ session_id: execution.session_id, chars: '', yield_time_ms: 1000 })}));`
        : `text(await tools.exec_command(${JSON.stringify({ cmd: command, login: false, yield_time_ms: 10000 })}));`;
      const output = call
        ? { type: 'custom_tool_call', id: `fc_${sequence}`, call_id: `call_${sequence}`, name: 'exec', namespace: 'functions',
            input: toolInput }
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
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(configHome, 'config.toml'), `model="gpt-5.6-sol"
model_provider="fixture"
approval_policy="never"
sandbox_mode="workspace-write"
[sandbox_workspace_write]
exclude_slash_tmp=true
exclude_tmpdir_env_var=true
[model_providers.fixture]
name="fixture"
base_url="http://127.0.0.1:${server.address().port}/v1"
wire_api="responses"
requires_openai_auth=false
[projects.${JSON.stringify(cwd)}]
trust_level="trusted"
`);
  let session, child, timeout, log = '';
  try {
    const fleetSession = process.env.FLEET_TEST_SESSION;
    if (fleetSession) {
      const stateDir = join(root, 'session-' + randomUUID()); mkdirSync(stateDir);
      const role = { name: 'Fixture', identity: 'Fixture', harness: 'codex', session: fleetSession,
        model: 'gpt-5.6-sol', sourceFile: 'fixture', permissions: { approval: 'auto', filesystem: 'workspace', unattended: 'deny' },
        env: { CODEX_PATH: codex },
        session_options: { codex_app_server: { command: [codex, 'app-server'] } },
      };
      const adapter = makeCodexAdapter(undefined, options => AcpSession.start({ ...options, inheritEnvironment: false }));
      const prep = await adapter.prepareSession(role, { stateDir, runCwd: cwd });
      prep.env = { ...env, FLEET_OURS_MANAGED: '1', CODEX_HOME: configHome, CODEX_PATH: codex, ...prep.env,
        OPENAI_API_KEY: 'fixture-unused', OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
        DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key', _meta: { 'api-key': { apiKey: 'fixture-unused' } } }),
      };
      const launch = adapter.agentSession.prepareLaunch(role, prep);
      session = await adapter.agentSession.start({ role, prep, launch, cwd, stateDir, mode: 'fresh',
        permissions: role.permissions, permissionMode: adapter.effectivePermissionMode(role), log: line => { log += line + '\n'; },
      });
      timeout = setTimeout(() => session.close(), 120000);
      const outcome = await session.submitPrompt('Run the isolated fixture command.');
      assert.equal(outcome.succeeded, true, command + "\n" + JSON.stringify(outcome) + log);
    } else {
      child = spawn(codex, ['exec', '--skip-git-repo-check', '--json', '-C', cwd, 'Run the isolated fixture command.'], {
        env: { ...env, CODEX_HOME: configHome }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
      timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
      await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      assert.equal(child.exitCode, 0, log);
    }
    assert.ifError(providerError);
    const blocks = Array.isArray(result) ? result : [{ text: result }];
    const execution = blocks.map(b => { try { return JSON.parse(b.text); } catch { return undefined; } }).find(v => v?.exit_code !== undefined);
    assert(execution, 'No completed real shell execution: ' + JSON.stringify(result) + log);
    return { exitCode: execution.exit_code, output: execution.output };
  } finally { clearTimeout(timeout); await session?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
