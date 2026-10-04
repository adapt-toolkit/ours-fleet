// Full-stack disposable qualification of the Coordinator task lifecycle: the REAL
// role runner (`ours-fleet _run`), real Codex, a real local ours daemon and Cowork
// service, and Fleet's own launch preparation. The Coordinator's session creates a
// task, starts it (a Cowork room is provisioned and a room member agent is really
// spawned through the supervisor), inspects the room, reviews and finishes it —
// each command typed in the pinned managed entry form from inside the Codex
// command sandbox. Only the model provider is scripted: it supplies command
// requests, never outcomes. No external model, account or production state.
//
//   FLEET_CODEX_BIN=/abs/codex FLEET_COWORK_CLI=/abs/cowork/dist/cli.js
//   FLEET_TEST_SESSION=codex-app-server|acp     (default codex-app-server)
//   FLEET_TEST_HARNESS=claude FLEET_CLAUDE_BIN=/abs/claude   Coordinator on bundled Claude ACP with its
//                                  OS sandbox enabled; the spawned member stays on Codex
//   FLEET_TEST_NESTED_SANDBOX=1    Claude inside an unprivileged container (see the validation doc)
//   FLEET_TEST_TMP_PREFIX=/abs/private-parent/prefix-   FLEET_TEST_EVIDENCE=/file.json
//   FLEET_TEST_SOCKET_PREFIX=/short/private/prefix-    (Unix socket paths; default: system temp dir)
//   FLEET_TEST_KEEP_ARTIFACTS=1
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { attachOursClient } from '@ours.network/sdk/client';

const codex = process.env.FLEET_CODEX_BIN, coworkCli = process.env.FLEET_COWORK_CLI;
assert(codex && coworkCli, 'Set FLEET_CODEX_BIN and FLEET_COWORK_CLI');
const claude = process.env.FLEET_TEST_HARNESS === 'claude' ? process.env.FLEET_CLAUDE_BIN : undefined;
assert(process.env.FLEET_TEST_HARNESS !== 'claude' || claude, 'Set FLEET_CLAUDE_BIN');
const session = claude ? 'acp' : process.env.FLEET_TEST_SESSION ?? 'codex-app-server';
const daemonCli = resolve(process.env.FLEET_DAEMON_CLI ?? 'node_modules/@ours.network/daemon/dist/cli.js');
const cli = resolve('dist/cli.js');
const label = `${process.platform} ${claude ? 'claude' : 'codex'}/${session} full-stack lifecycle`;

const root = realpathSync(mkdtempSync(process.env.FLEET_TEST_TMP_PREFIX ?? '/tmp/fleet-managed-lifecycle-'));
// Sockets (Fleet control, Cowork management, Claude's sandbox bridge) need a SHORT private
// directory: about 40 characters at most. FLEET_TEST_SOCKET_PREFIX overrides the system temp dir.
const socketRoot = realpathSync(mkdtempSync(process.env.FLEET_TEST_SOCKET_PREFIX ?? join(tmpdir(), 'fml-')));
chmodSync(socketRoot, 0o700);
for (const key of Object.keys(process.env)) if (/^(OURS_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_)/u.test(key)) delete process.env[key];
// Short: Claude's sandbox and Fleet both create Unix sockets below TMPDIR.
const tmp = join(socketRoot, 't'); mkdirSync(tmp, { mode: 0o700 });
const bin = join(root, 'bin'); mkdirSync(bin); symlinkSync(codex, join(bin, 'codex'));
const codexHome = join(root, 'codex-home'); mkdirSync(codexHome);
// The Codex child does not receive OURS_CONFIG, so the CLI it runs finds the host profile where
// an installed host has it: $HOME/.ours-client/profile.json.
const profile = join(root, '.ours-client', 'profile.json');
// Everything below resolves only this disposable home.
const env = {
  PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: tmp, OURS_FLEET_HOME: root,
  OURS_FLEET_SUPERVISOR: 'none', OURS_FLEET_SOCKET_ROOT: socketRoot, CODEX_HOME: codexHome, OURS_CONFIG: profile,
  OPENAI_API_KEY: 'fixture-unused',
  ...(claude ? { CLAUDE_CONFIG_DIR: join(root, 'claude-home'), CLAUDE_CODE_EXECUTABLE: claude, ANTHROPIC_API_KEY: 'fixture-unused',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' } : {}),
};
Object.assign(process.env, env);

const children = [];
function start(command, args, childEnv, name) {
  const log = join(root, `${name}.log`), fd = openSync(log, 'a');
  const child = spawn(command, args, { env: childEnv, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.log = log; child.closed = false; child.once('close', code => { child.closed = true; child.exitCode ??= code; });
  children.push(child); return child;
}
const tail = file => { try { return readFileSync(file, 'utf8').split('\n').filter(line => !/^INFO: |^  |^\) |^\( /u.test(line)).join('\n').slice(-2500); } catch { return ''; } };
async function wait(check, what, child, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    try { if (await check()) return; } catch { /* not yet */ }
    if (child?.closed) throw new Error(`${what}: process exited\n${tail(child.log)}`);
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error(`${what}: timed out\n${child ? tail(child.log) : ''}`);
}
async function port() {
  const server = netServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const value = server.address().port; await new Promise(done => server.close(done)); return value;
}
const json = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
function operator(args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail); child.once('close', code => done({ code, stdout, stderr }));
  });
}
const firstJson = text => {
  const begin = text.indexOf('{');
  for (let end = text.lastIndexOf('}'); end > begin; end = text.lastIndexOf('}', end - 1))
    try { return JSON.parse(text.slice(begin, end + 1)); } catch { /* trailing text */ }
  return undefined;
};

const watchdog = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(124); }, 900_000);
let gateway, provider, sdk, failure;
const evidence = [];
try {
  // --- A private ours daemon, Cowork service and the gateway a host profile names ---
  const daemonState = join(root, 'daemon'); mkdirSync(daemonState, { mode: 0o700 });
  const daemonPort = await port(), coworkPort = await port();
  const instance = randomUUID(), daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const credential = join(root, 'credential'), daemonConfig = join(root, 'daemon.json');
  json(daemonConfig, { stateDir: daemonState, port: daemonPort, apiVisibility: 'owner' });
  const clean = { PATH: env.PATH, HOME: root, TMPDIR: env.TMPDIR, XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_DATA_HOME: join(root, 'xdg-data'), LANG: process.env.LANG ?? 'C.UTF-8' };
  const daemon = start(process.execPath, [daemonCli, 'daemon', 'serve', '--managed'], {
    ...clean, OURS_CONFIG: daemonConfig, OURS_STATE_DIR: daemonState, OURS_PORT: String(daemonPort),
    OURS_DAEMON_ID: instance, OURS_API_VISIBILITY: 'owner', OURS_BROKER_URL: process.env.FLEET_TEST_BROKER_URL ?? 'wss://invalid.local/none',
  }, 'daemon');
  await wait(async () => (await (await fetch(`${daemonUrl}/selection`)).json()).instanceId === instance, 'daemon', daemon);
  copyFileSync(join(daemonState, 'daemon-token'), credential);
  sdk = await attachOursClient({ endpoint: daemonUrl, expectedInstanceId: instance, credentialPath: credential,
    sessionMode: 'external', leaseToken: randomUUID(), env: {} });
  const owner = await sdk.createRootIdentity({ name: 'FixtureOwner', bio: '', exposeLocal: false, localAutoAccept: true, skipIfRootExists: false });
  await sdk.releaseLease(); sdk = undefined;
  const coworkConfig = join(root, 'cowork.json');
  // Cowork's management socket lives in its state dir; Unix socket paths are short.
  json(coworkConfig, { version: 1, stateDir: join(socketRoot, 'cowork'), rest: { enabled: true, host: '127.0.0.1', port: coworkPort } });
  const cowork = start(process.execPath, [resolve(coworkCli), 'serve'], {
    ...clean, OURS_COWORK_CONFIG: coworkConfig, OURS_COWORK_HTTP_MANAGEMENT: '1',
    OURS_DAEMON_URL: daemonUrl, OURS_DAEMON_ID: instance, OURS_DAEMON_CREDENTIAL_PATH: credential,
  }, 'cowork');
  gateway = httpServer(async (req, res) => {
    try {
      const isDaemon = req.url.startsWith('/daemon/');
      if (!isDaemon && !req.url.startsWith('/cowork/')) { res.writeHead(404).end(); return; }
      const prefix = isDaemon ? '/daemon' : '/cowork';
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await fetch((isDaemon ? daemonUrl : `http://127.0.0.1:${coworkPort}`) + req.url.slice(prefix.length), {
        method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(502).end(); }
  });
  await new Promise(done => gateway.listen(0, '127.0.0.1', done));
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  mkdirSync(join(root, '.ours-client'), { recursive: true, mode: 0o700 });
  json(profile, { serverUrl, endpoint: `${serverUrl}/daemon`, expectedInstanceId: instance, credentialPath: credential });
  const { createCoworkAdapter } = await import('../dist/rooms-tasks/cowork-adapter.js');
  await wait(() => createCoworkAdapter({ env }).available(), 'Cowork management', cowork);

  // --- The operator's Fleet: one Coordinator, the packaged-style `single` template ---
  const project = join(root, 'project'); mkdirSync(project);
  const configDir = join(root, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const config = join(configDir, 'fleet.yaml');
  writeFileSync(config, `api_version: ours.network/fleet/v2\nrooms:\n  owner:\n    expected_cid: "${owner.info.cid}"\n  defaults:\n    attach_owner: false\n`, { mode: 0o600 });
  for (const dir of ['agents', 'agent_templates', 'room_templates']) mkdirSync(join(configDir, 'fleet', dir), { recursive: true, mode: 0o700 });
  const memberSession = claude ? 'codex-app-server' : session;
  const brain = `brain: { inline: { harness: codex, session: ${memberSession}, model: gpt-5.6-sol } }`;
  const acpEnv = memberSession === 'acp' ? [`env: { CODEX_PATH: ${JSON.stringify(codex)} }`] : [];
  writeFileSync(join(configDir, 'fleet', 'agents', 'Coordinator.yaml'), [
    'role: { inline: { mission: Coordinate tasks. } }',
    claude ? 'brain: { inline: { harness: claude-code, session: acp, model: claude-sonnet-4-6 } }' : brain,
    'permissions: { approval: auto, filesystem: workspace, unattended: deny }',
    `cwd: ${JSON.stringify(project)}`, ...(claude ? [] : acpEnv), '',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(configDir, 'fleet', 'agent_templates', 'Developer.yaml'), [
    'role: { inline: { mission: Implement the task. } }', brain,
    'permissions: { approval: allow, filesystem: workspace, unattended: deny }',
    // The template opts its instances in: a member created by `task start` must get its own
    // generated policy at launch, with no installer or setup run in between.
    'managed_cli: [task-workflow]', ...acpEnv, '',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(configDir, 'fleet', 'room_templates', 'single.yaml'), [
    'version: 1', 'description: "Solo task: one Developer"', 'room: { quiet_membership: false, anonymous: false }',
    'contract: |', '  Developer owns task execution.', 'members:',
    '  - { slot: developer, role: Developer, count: 1, agent_template: Developer }', '',
  ].join('\n'), { mode: 0o600 });

  // --- Setup exactly as the installer invokes it: static, no session ---------------
  const setup = await operator(['managed-cli', 'setup', '--configuration', config, '--json', '--enable', 'Coordinator']);
  assert.equal(setup.code, 0, setup.stdout + setup.stderr);
  const prefix = JSON.parse(setup.stdout).roles.find(item => item.role === 'Coordinator').commandPrefix;
  assert(prefix, setup.stdout);

  // --- A scripted provider: the Coordinator gets the workflow, everyone else "Done." --
  const run = (args) => `${prefix} ${args}`;
  let taskId, roomId, finished = false;
  /** The next command given every completed command output so far, or undefined when done. */
  // The member `task start` created, looked at while it is alive: what its own launch prepared.
  let member;
  function inspectMember() {
    const tmpRoot = join(root, '.ours-fleet', 'tmp');
    const name = readdirSync(tmpRoot).find(entry => entry.includes('-developer-'));
    if (!name) return { name: undefined };
    const read = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
    const launched = read(join(tmpRoot, name, '.managed-cli.json'));
    const registry = read(join(root, '.ours-fleet', 'managed-cli', 'registry.json'));
    return { name, stateDir: join(tmpRoot, name), record: launched,
      rules: launched?.artifact && existsSync(launched.artifact) ? readFileSync(launched.artifact, 'utf8') : undefined,
      holders: launched?.artifact ? registry?.files?.[launched.artifact]?.holders : undefined };
  }
  let answered = -1, answer;
  function next(outputs) {
    // One decision per completed command, however often the harness asks.
    if (outputs.length === answered) return answer;
    answered = outputs.length; return answer = decide(outputs);
  }
  function decide(outputs) {
    const step = outputs.length, last = outputs.at(-1);
    const record = (note, command) => { evidence.push({ note, command }); return command; };
    if (last) Object.assign(evidence.at(-1), { exitCode: last.exit_code, output: String(last.output ?? '').slice(0, 1200) });
    if (step === 0) return record('unpinned help stays sandboxed', `${process.execPath} ${cli} --help`);
    if (step === 1) return record('task create', run(`task create --title 'Lifecycle fixture' --brief 'provision, review, finish' --backlog --json`));
    if (step === 2) { taskId = firstJson(String(last.output))?.task?.task_id; return record('task start (provisions the room and spawns the member)', run(`task start ${taskId} --template single --json`)); }
    // The member's control socket answers only once its session is up; the task is
    // already durably active, and asking again is the documented idempotent retry.
    if (step === 3 && last.exit_code !== 0 && /task_not_ready|not ready|readiness is unknown/iu.test(String(last.output)))
      return record('task start again (idempotent retry while the member finishes starting)', `sleep 20; true`);
    if (evidence.at(-1).note.startsWith('task start again')) return record('task start (retry)', run(`task start ${taskId} --template single --json`));
    const done = { includes: note => evidence.some(item => item.note === note || item.note.startsWith(`${note} (`)) };
    if (!member) member = inspectMember();
    if (!evidence.some(item => item.note === 'task show')) return record('task show', run(`task show --json -- ${taskId}`));
    if (!done.includes('room show')) { roomId = firstJson(String(last.output))?.task?.room_id; return record('room show', run(`room show ${roomId} --json`)); }
    if (!done.includes('room members')) return record('room members', run(`room members ${roomId} --json`));
    if (!done.includes('task block')) return record('task block', run(`task block ${taskId} --reason 'waiting' --json`));
    if (!done.includes('task unblock')) return record('task unblock', run(`task unblock ${taskId} --json`));
    if (!done.includes('task review')) return record('task review', run(`task review ${taskId} --json`));
    const finish = run(`task finish ${taskId} --summary 'closed by the fixture' --json`);
    if (!done.includes('task finish')) return record('task finish (retires the member and the room)', finish);
    // Settlement is Fleet's own, unchanged by this work: when the member takes longer to stop
    // than the settle worker waits, finish reports it and the documented action is to re-run it.
    const attempts = evidence.filter(item => item.command === finish);
    if (attempts.at(-1) === evidence.at(-1) && last.exit_code !== 0 && attempts.length < 3) return record('pause before re-running finish', 'sleep 8');
    if (evidence.at(-1).note === 'pause before re-running finish') return record('task finish (re-run)', finish);
    if (!evidence.some(item => item.note === 'task show (final)')) return record('task show (final)', run(`task show --json -- ${taskId}`));
    finished = true; return undefined;
  }
  let sequence = 0, providerError;
  /** Claude's side of the same script: a Bash tool_use per command, its tool_result back. */
  function anthropic(input, res) {
    const results = (input.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_result')
      .map(block => ({ exit_code: block.is_error ? 1 : 0, output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }));
    const command = input.tools?.some(tool => tool.name === 'Bash') && !finished ? next(results) : undefined;
    const content = command
      ? { type: 'tool_use', id: `tool_${results.length}`, name: 'Bash', input: { command, timeout: 300000, description: 'Fleet lifecycle fixture' } }
      : { type: 'text', text: 'Done.' };
    const message = { id: `msg_${++sequence}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    if (!input.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message, content: [content], stop_reason: command ? 'tool_use' : 'end_turn' })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    emit('message_start', { message });
    emit('content_block_start', { index: 0, content_block: command ? { ...content, input: {} } : { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: command ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: command ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
    emit('message_stop', {}); res.end();
  }
  provider = httpServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.method !== 'POST' || !body.trim()) { res.writeHead(req.method === 'HEAD' ? 200 : 404).end(); return; }
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":10}'); return; }
      if (req.url.includes('/messages')) { anthropic(JSON.parse(body), res); return; }
      const request = JSON.parse(body);
      const text = JSON.stringify(request.input ?? []);
      const coordinator = text.includes('agents/Coordinator/briefing.md');
      let output = { type: 'message', id: `msg_${++sequence}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] };
      if (coordinator && !finished) {
        const results = (request.input ?? []).filter(item => item.type === 'custom_tool_call_output').map(item => {
          const blocks = Array.isArray(item.output) ? item.output : [{ text: item.output }];
          return blocks.map(block => { try { return JSON.parse(block.text); } catch { return undefined; } })
            .find(value => value?.session_id !== undefined || value?.exit_code !== undefined);
        }).filter(Boolean);
        const pending = results.at(-1)?.session_id !== undefined && results.at(-1)?.exit_code === undefined ? results.at(-1) : undefined;
        const completed = results.filter(value => value.exit_code !== undefined);
        const command = pending ? undefined : next(completed);
        const input = pending
          ? `text(await tools.write_stdin(${JSON.stringify({ session_id: pending.session_id, chars: '', yield_time_ms: 5000 })}));`
          : command ? `text(await tools.exec_command(${JSON.stringify({ cmd: command, login: false, yield_time_ms: 120000 })}));` : undefined;
        if (input) output = { type: 'custom_tool_call', id: `fc_${++sequence}`, call_id: `call_${sequence}`, name: 'exec', namespace: 'functions', input };
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      emit({ type: 'response.created', response: { id: `resp_${sequence}`, status: 'in_progress', output: [] } });
      emit({ type: 'response.output_item.added', output_index: 0, item: output });
      emit({ type: 'response.output_item.done', output_index: 0, item: output });
      emit({ type: 'response.completed', response: { id: `resp_${sequence}`, status: 'completed', output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    } catch (error) { providerError = error; res.writeHead(400).end(String(error)); }
  });
  await new Promise(done => provider.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${provider.address().port}/v1`;
  writeFileSync(join(codexHome, 'config.toml'), `model="gpt-5.6-sol"
model_provider="fixture"
[sandbox_workspace_write]
exclude_slash_tmp=true
exclude_tmpdir_env_var=true
[model_providers.fixture]
name="fixture"
base_url="${base}"
wire_api="responses"
requires_openai_auth=false
[projects.${JSON.stringify(project)}]
trust_level="trusted"
`);

  if (claude) {
    // The operator's own Claude settings: the OS sandbox is theirs to enable. Fleet's entries are
    // not here; they arrive through the role's settings overlay written at launch.
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    json(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), { sandbox: {
      ...(process.env.FLEET_TEST_NESTED_SANDBOX === '1' ? { enableWeakerNestedSandbox: true } : {}),
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } });
  }

  // --- The real runner: applyRole, then `_run` as the supervisor would launch it -----
  const { loadConfig, findRole } = await import('../dist/config.js');
  const { applyRole } = await import('../dist/ops.js');
  const { agentDir } = await import('../dist/paths.js');
  applyRole(findRole(loadConfig(config), 'Coordinator'), { configPath: config });
  const runnerEnv = { ...env, OPENAI_BASE_URL: base, ...(claude ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`, ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '' } : {}),
    DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key', _meta: { 'api-key': { apiKey: 'fixture-unused' } } }) };
  const runner = start(process.execPath, [cli, '_run', 'Coordinator', '-c', config], runnerEnv, 'runner');
  await wait(() => finished, 'scripted workflow', runner, 600_000);
  assert.ifError(providerError);

  // --- What actually happened ------------------------------------------------------
  const by = note => evidence.find(item => item.note === note);
  const ok = note => { const item = by(note); assert(item, `${note} was not run`); assert.equal(item.exitCode, 0, `${note}: ${item.output}`); return item; };
  assert.notEqual(by('unpinned help stays sandboxed').exitCode, 0);
  assert.match(by('unpinned help stays sandboxed').output, /connect (EPERM|EACCES)/u);
  ok('task create');
  const started = by('task start (retry)') ?? by('task start (provisions the room and spawns the member)');
  assert.equal(started.exitCode, 0, started.output);
  for (const note of ['task show', 'room show', 'room members', 'task block', 'task unblock', 'task review', 'task show (final)']) ok(note);
  const finishes = evidence.filter(item => item.note.startsWith('task finish'));
  assert.equal(finishes.at(-1).exitCode, 0, finishes.map(item => item.output).join('\n'));
  const reruns = finishes.length - 1;
  assert(roomId, 'task start did not record a room');
  const final = (await operator(['task', 'show', '--json', '-c', config, '--', taskId]));
  assert.equal(JSON.parse(final.stdout).task.state, 'done', final.stdout);

  // The new agent got its own policy from its own launch: record, rules, and a temporary holder.
  assert(member?.name, 'task start created no member state');
  assert.equal(member.record?.state, 'supported', JSON.stringify(member.record));
  assert.equal(member.record.mechanism, 'codex-workspace-rules');
  assert.equal(member.record.paths.configuration, config);
  assert.notEqual(member.record.workspace, project, 'the member has its own workspace');
  assert(member.record.artifact.startsWith(join(member.record.workspace, '.codex', 'rules')), member.record.artifact);
  assert(member.rules?.includes(`"--managed-configuration",${JSON.stringify(config)},"task","start"]`), `member rules: ${member.rules}`);
  assert.deepEqual(member.holders, [`temp:${member.name}`]);

  // Retirement, checked where it happened rather than inferred from the task state.
  assert.equal(existsSync(member.stateDir), false, 'the member\'s live state is still there');
  const { getRoomRecord } = await import('../dist/rooms-tasks/room-state.js');
  assert.equal(getRoomRecord(roomId), undefined, 'Fleet still records the room');
  const adapter = createCoworkAdapter({ env });
  assert.equal(await adapter.getRoom(roomId), undefined, 'Cowork still has the room');
  assert.equal((await adapter.listRooms()).some(room => room.room_id === roomId), false);
  // The member's rules go with it: the next setup finds no holder left and removes the file.
  const after = JSON.parse((await operator(['managed-cli', 'setup', '--configuration', config, '--json'])).stdout);
  assert.equal(existsSync(member.record.artifact), false, JSON.stringify(after.removed));
  const ledger = JSON.parse(readFileSync(join(agentDir('Coordinator'), '.fleet-command-audit.json'), 'utf8')).attempts;
  // Finishing the task erases its rows' words to hashes; the pin flag stays recognisable.
  const { erasedArg } = await import('../dist/erased-resources.js');
  const pinned = row => ['--managed-configuration', erasedArg('--managed-configuration')].includes(row.argv[0]);
  const audited = ledger.filter(pinned);
  for (const command of ['task create', 'task start', 'task show', 'room show', 'room members', 'task block', 'task unblock', 'task review', 'task finish'])
    assert(audited.some(row => row.classification.command === command && row.outcome?.class === 'success'), `${command} has no successful audit row`);
  assert.equal(ledger.some(row => !pinned(row)), false, 'an unpinned command reached the supervisor');
  const status = JSON.parse((await operator(['managed-cli', 'status', '--configuration', config, '--json'])).stdout).roles.find(item => item.role === 'Coordinator');
  assert.equal(status.session_policy, 'current', JSON.stringify(status));
  const observed = status.observed.current.filter(item => item.class === 'success').map(item => item.form);
  for (const form of ['task create', 'task start', 'task review', 'task finish', 'room show', 'room members']) assert(observed.includes(form), `${form} not observed: ${JSON.stringify(status.observed)}`);
  console.log(`PASS ${label}: real runner launched the Coordinator with Fleet-prepared policy; unpinned CLI denied at the socket`);
  console.log(`PASS ${label}: task create -> start (room ${roomId} provisioned, member spawned) -> show/room show/room members -> block/unblock -> review -> finish${reruns ? ` (re-run ${reruns}x while the member was still stopping)` : ''}, all pinned, all audited; task is done`);
  console.log(`PASS ${label}: the spawned member ${member.name} declared the workflow through its Agent Template and its own launch prepared it (record supported, rules in its workspace, temporary holder); after finish its live state, the Fleet room record and the Cowork room are gone and its rules were removed`);
  console.log(`QUALIFIED ${label}: node ${process.version}; ${audited.length} audited pinned invocations`);
} catch (error) { failure = error; throw error; } finally {
  clearTimeout(watchdog);
  if (failure) for (const name of ['runner', 'cowork', 'daemon']) console.error(`--- ${name}.log\n${tail(join(root, `${name}.log`))}`);
  if (process.env.FLEET_TEST_EVIDENCE) writeFileSync(process.env.FLEET_TEST_EVIDENCE, JSON.stringify({ label, evidence }, null, 2));
  for (const child of children.reverse()) if (!child.closed) child.kill('SIGTERM');
  await new Promise(done => setTimeout(done, 3000));
  for (const child of children) if (!child.closed) child.kill('SIGKILL');
  try { await sdk?.releaseLease(); } catch { /* already released */ }
  provider?.closeAllConnections(); provider?.close(); gateway?.closeAllConnections(); gateway?.close();
  rmSync(socketRoot, { recursive: true, force: true });
  if (process.env.FLEET_TEST_KEEP_ARTIFACTS === '1' || failure) console.log(`Fixture artifacts retained: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
