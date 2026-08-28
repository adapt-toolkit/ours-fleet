import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReportArtifact } from '../dist/reports/index.js';

const out = process.argv[2];
if (!out) throw new Error('usage: generate-report-mocks.mjs <output-directory>');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const at = '2026-08-28T10:00:00.000Z';
const source = { name: 'ours-fleet', version: 'mock-preview', buildId: 'owner-design-review' };
const V = (label, value, tone, target) => ({ label, value, ...(tone ? { tone } : {}), ...(target ? { target } : {}) });
const table = (id, title, columns, rows, extra = {}) => ({ kind: 'table', id, title, columns, rows, ...extra });
const details = (id, title, values, paragraphs = []) => ({ kind: 'details', id, title, values, paragraphs });
const row = (id, ...cells) => ({ id, cells });
const base = (kind, title, description, sections, summary = [], extra = {}) => ({
  schemaVersion: 1, reportKind: kind, title, description, generatedAt: at, source,
  observedAt: { [kind]: '2026-08-28T09:59:58.000Z' }, sections, summary, unavailable: [], ...extra,
});

const reports = [
  base('overview', 'Fleet overview', 'A safe cross-resource operational snapshot.', [
    table('tasks','Tasks',['ID','Title','Status','Room','Template'],[row('tsk-demo',V('ID','tsk-demo'),V('Title','Render reports'),V('Status','Active','good'),V('Room','rm-demo',null,{section:'rooms',id:'rm-demo'}),V('Template','pair-review',null,{section:'templates',id:'pair-review'}))],{truncated:{shown:1,total:3}}),
    table('rooms','Rooms',['ID','Name','Status','Task'],[row('rm-demo',V('ID','rm-demo'),V('Name','HTML reports'),V('Status','Ready','good'),V('Task','tsk-demo',null,{section:'tasks',id:'tsk-demo'}))]),
    table('agents','Agents',['Role','Harness','Readiness'],[row('secretary',V('Role','Secretary'),V('Harness','Codex'),V('Readiness','Ready','good'))]),
    table('templates','Templates',['Name','Version','Members'],[row('pair-review',V('Name','pair-review'),V('Version','2'),V('Members',2))]),
    table('loops','Loops',['Role','Loop','Health'],[row('health',V('Role','Coordinator'),V('Loop','health'),V('Health','Healthy','good'))]),
    table('watchdog','Watchdog',['Name','Latest run','Status'],[row('fleet-health',V('Name','fleet-health'),V('Latest run','run-2'),V('Status','Degraded','warning'))]),
    table('host','Host health',['Surface','Value','Health'],[row('version',V('Surface','Version'),V('Value','1.0.4'),V('Health','Current','good')),row('config',V('Surface','Config'),V('Value','5 roles'),V('Health','Valid','good')),row('doctor',V('Surface','Doctor'),V('Value','1 warning'),V('Health','Degraded','warning'))]),
  ],[V('Tasks',3),V('Rooms',1),V('Agents',2),V('Health','Degraded','warning')],{unavailable:['watchdog history (service unavailable)']}),
  base('tasks','Tasks','All task lists and lifecycle filters.',[
    table('tasks','Tasks',['ID','List','Title','Status','Blocker','Room'],[
      row('tsk-active',V('ID','tsk-active'),V('List','default'),V('Title','Build HTML reports'),V('Status','Active','good'),V('Blocker',null,'unknown'),V('Room','rm-demo')),
      row('tsk-blocked',V('ID','tsk-blocked'),V('List','release'),V('Title','Ship preview'),V('Status','Blocked','warning'),V('Blocker','Owner visual approval'),V('Room','rm-review')),
      row('tsk-done',V('ID','tsk-done'),V('List','archive'),V('Title','Audit inventory'),V('Status','Done','good'),V('Blocker',null),V('Room',null)),
    ],{truncated:{shown:3,total:12}}),
  ],[V('Shown',3),V('Blocked',1,'warning')],{filters:{state:'all',list:'all'}}),
  base('task-lists','Task lists','Named workflow groupings.',[table('task-lists','Lists',['Name','Type','Tasks'],[row('default',V('Name','default'),V('Type','Built-in'),V('Tasks',2)),row('release',V('Name','release'),V('Type','Custom'),V('Tasks',5))])]),
  base('task','Task details','Full safe task record and terminal state.',[
    details('task','Task',[V('ID','tsk-demo'),V('Title','Render Fleet reports'),V('Status','Done','good'),V('List','release'),V('Template','pair-review'),V('Room','rm-demo'),V('Created','2026-08-28T08:00:00.000Z'),V('Started','2026-08-28T08:05:00.000Z'),V('Ended','2026-08-28T09:45:00.000Z'),V('Outcome','Mock previews delivered for Owner review.')],['This bounded brief demonstrates long prose handling. '+'A deliberately verbose sentence repeats safely without raw HTML or active content. '.repeat(18)]),
    table('members','Members',['Name','Role','State'],[row('secretary',V('Name','secretary'),V('Role','Secretary'),V('State','Working','good')),row('critic',V('Name','critic'),V('Role','Critic'),V('State','Reviewing','warning'))]),
    {kind:'notice',id:'brief-limit',title:'Bounded content',tone:'neutral',text:'Brief truncated; showing 1,500 of 8,240 characters.'},
  ]),
  base('rooms','Rooms','Room lifecycle and task linkage.',[table('rooms','Rooms',['ID','Name','State','Task','Template'],[row('rm-demo',V('ID','rm-demo'),V('Name','HTML reports'),V('State','Active','good'),V('Task','tsk-demo'),V('Template','pair-review')),row('rm-old',V('ID','rm-old'),V('Name','Completed audit'),V('State','Closed','neutral'),V('Task','tsk-done'),V('Template','solo'))])]),
  base('room','Room details','Lifecycle, linkage, seats, and safe orchestration readiness.',[details('room','Room',[V('ID','rm-demo'),V('Name','HTML reports'),V('State','Active','good'),V('Task','tsk-demo'),V('Template','pair-review'),V('Saga','members-ready'),V('Health','Ready','good')]),table('seats','Seats',['CID','Role','Seat state','Briefing'],[row('seat-1',V('CID','A1B2…'),V('Role','Secretary'),V('Seat state','verified','good'),V('Briefing','delivered','good')),row('seat-2',V('CID','C3D4…'),V('Role','Critic'),V('Seat state','verified','good'),V('Briefing','acknowledged','good'))])]),
  base('room-members','Room members','Participant roles and readiness.',[table('members','Members',['Identity','Role','Seat','Readiness'],[row('member-a',V('Identity','A1B2…'),V('Role','Owner'),V('Seat','authenticated','good'),V('Readiness','Ready','good')),row('member-b',V('Identity','C3D4…'),V('Role','Secretary'),V('Seat','verified','good'),V('Readiness','Working','good'))])]),
  base('agents','Fleet agents','Safe session and process readiness.',[table('agents','Agents',['Role','Harness','Lifecycle','Readiness','Activity','Restarts'],[row('secretary',V('Role','Secretary'),V('Harness','Codex'),V('Lifecycle','Running','good'),V('Readiness','Ready','good'),V('Activity','2026-08-28T09:58:00.000Z'),V('Restarts',0)),row('watcher',V('Role','Watcher'),V('Harness','ACP'),V('Lifecycle','Degraded','warning'),V('Readiness','Recovering','warning'),V('Activity','2026-08-28T09:42:00.000Z'),V('Restarts',2,'warning'))])]),
  base('agent-status','Agent status','Allowlisted lifecycle and readiness; no console, prompt, log, or session secret.',[details('agent','Secretary',[V('Role','Secretary'),V('Harness','Codex'),V('Lifecycle','Running','good'),V('Ready',true,'good'),V('Model','gpt-5'),V('Activity','2026-08-28T09:58:00.000Z'),V('Restart policy','resume'),V('Isolation','enabled','good')])]),
  base('templates','Room templates','Available deterministic room shapes.',[table('templates','Templates',['Name','Version','Description','Members','Built-in'],[row('pair-review',V('Name','pair-review'),V('Version','2'),V('Description','Builder and independent critic'),V('Members',2),V('Built-in',true)),row('solo',V('Name','solo'),V('Version','1'),V('Description','Single focused worker'),V('Members',1),V('Built-in',true))])]),
  base('template','Template details','Contract, room policy, and member slots.',[details('template','pair-review',[V('Name','pair-review'),V('Version','2'),V('Content hash','sha256:0123…'),V('Anonymous',false),V('Quiet membership',true)] ,[ 'Secretary implements; Critic independently reviews every material decision.' ]),table('members','Member slots',['Slot','Count','Role','Reference'],[row('secretary',V('Slot','secretary'),V('Count',1),V('Role','Secretary'),V('Reference','roles.secretary')),row('critic',V('Slot','critic'),V('Count',1),V('Role','Critic'),V('Reference','roles.critic'))])]),
  base('template-validation','Template validation','Accessible validation results.',[{kind:'notice',id:'result',title:'Validation result',tone:'warning',text:'1 of 3 templates has an issue.'},table('problems','Problems',['Template','Severity','Issue'],[row('legacy',V('Template','legacy'),V('Severity','Warning','warning'),V('Issue','Unknown future room policy was ignored safely.'))])]),
  base('loops','Scheduled loops','Redacted definitions; prompt and expanded ACP material are excluded.',[table('loops','Loops',['Role','Loop','Schedule','Enabled','Next run'],[row('coordinator:health',V('Role','Coordinator'),V('Loop','health'),V('Schedule','every 15m'),V('Enabled',true,'good'),V('Next run','2026-08-28T10:15:00.000Z'))])]),
  base('loop-status','Loop status','Live or stored state with honest observation time.',[details('loop','Coordinator / health',[V('Role','Coordinator'),V('Loop','health'),V('State','Idle','good'),V('Last run','2026-08-28T09:45:00.000Z'),V('Next run','2026-08-28T10:15:00.000Z'),V('Failures',0,'good')])]),
  base('loop-validation','Loop validation','Safe validation summary only.',[{kind:'notice',id:'result',title:'Validation result',tone:'good',text:'2 loops and 3 role pairs resolved successfully.'}]),
  base('watchdog','Watchdog run','One bounded run with safe findings and evidence anchors.',[details('run','Run',[V('Watchdog','fleet-health'),V('Run ID','run-20260828'),V('Status','Degraded','warning'),V('Started','2026-08-28T09:55:00.000Z'),V('Duration','8s')]),table('findings','Role findings',['Role','Status','Reason','Evidence'],[row('watcher',V('Role','Watcher'),V('Status','Anomaly','bad'),V('Reason','Readiness heartbeat stale'),V('Evidence','finding-1',null,{section:'evidence'}))]),details('evidence','Safe evidence summary',[V('Evidence ID','finding-1'),V('Observation','Heartbeat exceeded the configured freshness threshold.'),V('Raw payload','Excluded')])]),
  base('watchdog-runs','Watchdog runs','Bounded run history.',[table('runs','Runs',['Run ID','Started','Duration','Status','Healthy','Anomalies'],[row('run-2',V('Run ID','run-2'),V('Started','2026-08-28T09:55:00.000Z'),V('Duration','8s'),V('Status','Degraded','warning'),V('Healthy',4),V('Anomalies',1,'warning')),row('run-1',V('Run ID','run-1'),V('Started','2026-08-28T09:40:00.000Z'),V('Duration','6s'),V('Status','Healthy','good'),V('Healthy',5),V('Anomalies',0))])]),
  base('version','Fleet version','Machine and build identity.',[details('version','Version',[V('Fleet','1.0.4'),V('Node','v22.18.0'),V('Platform','linux'),V('Build','abc123'),V('Package integrity','Verified','good')])]),
  base('config','Fleet configuration','Secret-safe resolved plan; raw editable YAML is never rendered.',[details('config','Resolved plan',[V('Schema version',1),V('Roles',5),V('Watchdogs',1),V('Loops',2),V('Isolation default','enabled','good')]),table('roles','Configured roles',['Role','Harness','Model','Autostart'],[row('coordinator',V('Role','Coordinator'),V('Harness','ACP'),V('Model','gpt-5'),V('Autostart',true))])]),
  base('doctor','Fleet doctor','Prerequisite checks and actionable diagnostics.',[table('checks','Checks',['Check','Result','Detail'],[row('node',V('Check','Node.js'),V('Result','Pass','good'),V('Detail','v22.18.0')),row('daemon',V('Check','ours daemon'),V('Result','Pass','good'),V('Detail','reachable')),row('watchdog',V('Check','watchdog freshness'),V('Result','Warning','warning'),V('Detail','last run 2026-08-28T09:40:00.000Z'))])],[V('Passed',8,'good'),V('Warnings',1,'warning'),V('Errors',0,'good')]),
  base('manual','Fleet HTML report manual','Static navigable documentation.',[details('getting-started','Getting started',[V('CLI','ours-fleet task list --format html --output tasks.html'),V('REST','GET /api/v1/reports/tasks'),V('Messenger','/report tasks')]),table('kinds','Report kinds',['Kind','Purpose'],[row('tasks',V('Kind','tasks'),V('Purpose','Filtered task inventory')),row('overview',V('Kind','overview'),V('Purpose','Authorized Fleet snapshot'))]),table('empty','Empty-state example',['Item','Status'],[],{empty:'No matching records. Adjust filters or try again.'}),{kind:'notice',id:'privacy',title:'Privacy guarantee',tone:'good',text:'Reports exclude secrets, prompts, messages, consoles, raw logs, and private filesystem paths.'}]),
];

for (const report of reports) {
  const artifact = createReportArtifact(report);
  await writeFile(join(out, artifact.metadata.filename), artifact.html, { flag: 'wx', mode: 0o600 });
}
const index = base('manual', 'HTML preview pack index', 'Mocked artifacts for Owner visual review. Filenames are portable and contain no host-local paths.', [
  table('files', 'Preview files', ['Report kind', 'Filename'], reports.map(report =>
    row(report.reportKind, V('Report kind', report.reportKind), V('Filename', createReportArtifact(report).metadata.filename)))),
]);
await writeFile(join(out, 'fleet-preview-index.html'), createReportArtifact(index).html, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: out, files: reports.length + 1 }));
