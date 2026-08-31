import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReportArtifact } from '../dist/reports/index.js';

const out = process.argv[2];
if (!out) throw new Error('usage: generate-rich-task-mocks.mjs <output-directory>');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const at = '2026-08-28T10:00:00.000Z';
const source = { name: 'ours-fleet', version: 'mock-preview', buildId: 'script-free-rich-tasks' };
const value = (label, v, tone, target) => ({ label, value: v, ...(tone ? { tone } : {}), ...(target ? { target } : {}) });
const task = (id, title, subtitle, tone, values, paragraphs, open = true) => ({ id, title, subtitle, tone, values, paragraphs, open });

const tasks = {
  schemaVersion: 1, reportKind: 'tasks', title: 'Tasks — default + release',
  description: 'Script-free task explorer. Jump to a selected list, open native task details, or use browser Find (Ctrl/Cmd+F). Archive is excluded by the generation-time filter.',
  generatedAt: at, source, filters: { lists: 'default, release', state: 'all' },
  observedAt: { tasks: '2026-08-28T09:59:58.000Z', rooms: '2026-08-28T09:59:57.000Z' }, unavailable: [],
  summary: [
    value('Selected lists','default + release'), value('Shown tasks',4), value('Blocked',1,'warning',{section:'list-release',id:'tsk-release-blocked'}),
    value('Default',2,null,{section:'list-default'}), value('Release',2,null,{section:'list-release'}),
  ],
  sections: [
    { kind:'details', id:'selection', title:'Selection and search', values:[
      value('Proposed HTML CLI selector','--list default --list release'), value('Proposed HTML REST selector','?list=default&list=release'), value('Proposed HTML Messenger selector','/report tasks --list default --list release'), value('Text search','Use browser Find (Ctrl/Cmd+F)'),
    ], paragraphs:['These repeated selectors are a proposed HTML-only contract, not current CLI behavior. Filters are applied before rendering; existing text and JSON contracts remain unchanged.'] },
    { kind:'table', id:'list-summary', title:'Selected list summary', columns:['List','Shown','Total','Shown active','Shown blocked','Shown terminal'], rows:[
      {id:'default',cells:[value('List','default',null,{section:'list-default'}),value('Shown',2),value('Total',2),value('Shown active',1),value('Shown blocked',0),value('Shown terminal',1)]},
      {id:'release',cells:[value('List','release',null,{section:'list-release'}),value('Shown',2),value('Total',7),value('Shown active',2),value('Shown blocked',1,'warning'),value('Shown terminal',0)]},
    ]},
    { kind:'table', id:'status-summary', title:'Status navigation', description:'Blocked is an indicator, not a lifecycle state.', columns:['View','Count','Representative task'], rows:[
      {id:'active',cells:[value('View','Active lifecycle'),value('Count',3),value('Representative task','tsk-default-active',null,{section:'list-default',id:'tsk-default-active'})]},
      {id:'blocked',cells:[value('View','Blocked indicator'),value('Count',1,'warning'),value('Representative task','tsk-release-blocked',null,{section:'list-release',id:'tsk-release-blocked'})]},
      {id:'review',cells:[value('View','Review'),value('Count',0),value('Representative task',null)]},
      {id:'terminal',cells:[value('View','Done / terminal'),value('Count',1),value('Representative task','tsk-default-done',null,{section:'list-default',id:'tsk-default-done'})]},
    ]},
    { kind:'cards', id:'list-default', title:'List: default', description:'2 shown of 2 tasks, canonical by created-at descending then ID ascending.', items:[
      task('tsk-default-active','tsk-default-active — Build report registry','ACTIVE · Ready · Room rm-html','good',[
        value('ID','tsk-default-active'),value('Status','Active','good'),value('List','default'),value('Blocked',null),
        value('Room','rm-html',null,{section:'room-references',id:'rm-html'}),value('Template','pair-review@2',null,{section:'template-references',id:'pair-review'}),
        value('Created','2026-08-28T08:00:00.000Z'),value('Updated','2026-08-28T09:58:00.000Z'),value('Started','2026-08-28T08:05:00.000Z'),value('Ended',null),
        value('Members','Secretary — working/ready; Critic — reviewing/ready'),value('Readiness','2/2 ready','good'),value('Outcome',null),
      ],['Brief: Build the typed allowlisted registry and deterministic renderer.'],true),
      task('tsk-default-done','tsk-default-done — Audit command inventory','DONE · Terminal · No blocker','good',[
        value('ID','tsk-default-done'),value('Status','Done','good'),value('List','default'),value('Blocked',null),value('Room',null),value('Template','solo@1',null,{section:'template-references',id:'solo'}),
        value('Created','2026-08-27T13:00:00.000Z'),value('Updated','2026-08-27T14:15:00.000Z'),value('Started','2026-08-27T13:02:00.000Z'),value('Ended','2026-08-27T14:15:00.000Z'),value('Members','Auditor — completed/terminal'),value('Readiness','Terminal'),value('Outcome','Inventory documented with explicit exclusions.'),
      ],['Brief: Classify every CLI, REST, and Messenger command.']),
    ]},
    { kind:'cards', id:'list-release', title:'List: release', description:'2 shown of 7 tasks, canonical by created-at descending then ID ascending. Five older records are explicitly truncated.', truncated:{shown:2,total:7}, items:[
      task('tsk-release-blocked','tsk-release-blocked — Approve visual design','BLOCKED · Owner review required','warning',[
        value('ID','tsk-release-blocked'),value('Status','Active','warning'),value('List','release'),value('Blocked','Waiting for Owner visual approval','warning'),
        value('Room','rm-review',null,{section:'room-references',id:'rm-review'}),value('Template','pair-review@2',null,{section:'template-references',id:'pair-review'}),
        value('Created','2026-08-28T09:20:00.000Z'),value('Updated','2026-08-28T09:57:00.000Z'),value('Started','2026-08-28T09:23:00.000Z'),value('Ended',null),value('Members','Designer — blocked/waiting; Critic — reviewing/ready'),value('Readiness','1/2 waiting','warning'),value('Outcome',null),
      ],['Brief: Review the richer script-free task exploration artifact.']),
      task('tsk-release-active','tsk-release-active — Verify responsive print','ACTIVE · Healthy · No blocker','good',[
        value('ID','tsk-release-active'),value('Status','Active','good'),value('List','release'),value('Blocked',null),value('Room','rm-review',null,{section:'room-references',id:'rm-review'}),value('Template','pair-review@2',null,{section:'template-references',id:'pair-review'}),
        value('Created','2026-08-28T09:10:00.000Z'),value('Updated','2026-08-28T09:55:00.000Z'),value('Started','2026-08-28T09:12:00.000Z'),value('Ended',null),value('Members','Critic — testing/ready'),value('Readiness','Ready','good'),value('Outcome',null),
      ],['Brief: Verify desktop, 390px mobile, keyboard, and print layouts.']),
    ]},
    { kind:'table', id:'room-references', title:'Safe room references', columns:['Room','Lifecycle','Readiness'], rows:[
      {id:'rm-html',cells:[value('Room','rm-html'),value('Lifecycle','Active','good'),value('Readiness','Ready','good')]},
      {id:'rm-review',cells:[value('Room','rm-review'),value('Lifecycle','Active','good'),value('Readiness','Waiting for owner','warning')]},
    ]},
    { kind:'table', id:'template-references', title:'Template references', columns:['Template','Version','Members'], rows:[
      {id:'pair-review',cells:[value('Template','pair-review'),value('Version','2'),value('Members',2)]},
      {id:'solo',cells:[value('Template','solo'),value('Version','1'),value('Members',1)]},
    ]},
  ],
};

const lists = {
  schemaVersion:1,reportKind:'task-lists',title:'Task lists',description:'Script-free list index with counts and a selected empty-list example.',generatedAt:at,source,
  observedAt:{tasks:'2026-08-28T09:59:58.000Z'},unavailable:[],summary:[value('Lists',4),value('Tasks',14)],sections:[
    {kind:'table',id:'lists',title:'All lists',columns:['List','Type','Total','Active','Blocked','Terminal'],rows:[
      {id:'archive',cells:[value('List','archive'),value('Type','Custom'),value('Total',5),value('Active',0),value('Blocked',0),value('Terminal',5)]},
      {id:'default',cells:[value('List','default'),value('Type','Built-in'),value('Total',2),value('Active',1),value('Blocked',0),value('Terminal',1)]},
      {id:'release',cells:[value('List','release'),value('Type','Custom'),value('Total',7),value('Active',6),value('Blocked',1,'warning'),value('Terminal',0)]},
      {id:'waiting',cells:[value('List','waiting'),value('Type','Custom'),value('Total',0),value('Active',0),value('Blocked',0),value('Terminal',0)]},
    ]},
    {kind:'cards',id:'empty-list',title:'Selected list: waiting',description:'Generation-time filter: --list waiting',items:[],empty:'No tasks in the selected list.'},
  ],
};

for (const report of [tasks, lists]) {
  const artifact=createReportArtifact(report);
  await writeFile(join(out,artifact.metadata.filename),artifact.html,{flag:'wx',mode:0o600});
}
console.log(JSON.stringify({output:out,files:2}));
