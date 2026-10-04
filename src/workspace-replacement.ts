import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { validateAccountOrigin } from './account-origin.js';
import { replaceFileAtomically } from './atomic-file.js';
import { stateRoot } from './paths.js';
import { decodeWorkspacePayload, enrollWorkspace, unregisterWorkspace, checkWorkspaceConnector, type AttachDaemonClient, type WorkspacePayload } from './workspace-enrollment.js';
import { WorkspaceDeviceStore } from './web/workspace-devices.js';
import { webControlPath } from './web/control.js';
import { WebServiceManager } from './web/service.js';

export interface WorkspaceBinding { workspaceId: string; hostWorkspaceId: string; appOrigin: string; serverCid?: string; proofRootCid?: string }
const workspaceDir = () => join(stateRoot(), 'workspace');
const replacementPath = () => join(workspaceDir(), 'replacement.json');
const opaque = /^[\w-]{43}$/;
function binding(value: WorkspaceBinding): WorkspaceBinding {
  if (!value || !opaque.test(value.workspaceId) || !opaque.test(value.hostWorkspaceId) || (value.serverCid!==undefined && !/^[a-f0-9]{64}$/i.test(value.serverCid))
    || (value.proofRootCid !== undefined && !/^[a-f0-9]{64}$/i.test(value.proofRootCid))) throw Error('Existing workspace binding is invalid; restore it before tunnel setup');
  return {...value, appOrigin: validateAccountOrigin(value.appOrigin ?? 'https://app.ours.network')};
}
export function readWorkspaceBinding(): WorkspaceBinding | undefined {
  const file = join(workspaceDir(), 'binding.json');
  if (!existsSync(file)) return;
  let value:WorkspaceBinding;try{value=JSON.parse(readFileSync(file, 'utf8'));}catch{throw Error('Existing workspace binding is invalid');}
  return binding(value);
}
export function sameWorkspaceBinding(previous: WorkspaceBinding, payload: WorkspacePayload): boolean {
  return previous.workspaceId === payload.challenge.workspaceId && previous.appOrigin === payload.appOrigin && (!previous.serverCid || previous.serverCid.toUpperCase() === payload.serverCid.toUpperCase());
}
/** A workspace ID is never retired to rerun or migrate that same workspace. */
export function requiresWorkspaceReplacement(previous:WorkspaceBinding,target:{workspaceId:string;appOrigin:string;serverCid:string},migrateAppOrigin=false):boolean {
  if(previous.workspaceId!==target.workspaceId){if(!previous.serverCid)throw Error('Legacy registration has no recorded server identity. Rerun its own workspace setup before replacing it');return true;}
  if(previous.serverCid && previous.serverCid.toUpperCase()!==target.serverCid.toUpperCase())throw Error('Same-workspace setup must retain the enrollment server identity; existing setup preserved');
  if(previous.appOrigin!==target.appOrigin && !migrateAppOrigin)throw Error('Account origin change requires explicit --migrate-app-origin; existing setup preserved');
  return false;
}
/** Ask before redeeming the one-use grant, whose destination is deliberately opaque. */
export async function confirmWorkspaceReplacement(previous: WorkspaceBinding, explicit = false, effects: {
  write?: (value: string) => void; interactive?: boolean; ask?: () => Promise<string>;
} = {}): Promise<boolean> {
  const write = effects.write ?? (value => { process.stderr.write(value); });
  let hostname='';try{const tunnel=JSON.parse(readFileSync(join(workspaceDir(),'tunnel.json'),'utf8'));if(typeof tunnel.origin==='string' && /^https:\/\/[a-z0-9][a-z0-9-]{2,60}\.ours-tunnel\.com$/.test(tunnel.origin))hostname=` (${new URL(tunnel.origin).hostname})`;}catch{}
  write(`This host is registered to workspace ${previous.workspaceId}${hostname} at ${previous.appOrigin}.\nReplacing it removes the old account registration and revokes its linked devices. The account service retires tunnel resources it knows; a migrated database may have no old resources to delete. Installation identities, agents and data are preserved.\n`);
  if (explicit) return true;
  if (!(effects.interactive ?? process.stdin.isTTY)) { write('Existing setup preserved. Run in a terminal to confirm, or pass --replace-registration to confirm explicitly.\n'); return false; }
  const ask = effects.ask ?? (async () => {
    const terminal = createInterface({input: process.stdin, output: process.stderr});
    try { return await terminal.question('Replace the existing registration if this command names another workspace? [y/N] '); }
    finally { terminal.close(); }
  });
  let answer = ''; try { answer = await ask(); } catch { /* EOF, cancellation and input failure mean no consent. */ }
  if (/^(y|yes)$/i.test(answer.trim())) return true;
  write('Existing setup preserved.\n'); return false;
}
export interface PendingWorkspaceReplacement {
  version: 1|2; previous: WorkspaceBinding & {serverCid:string}; payload: WorkspacePayload; configuration: string; operationNonce: string;
  rootCid?: string; retired?: boolean; cleaned?: boolean; dispatchAttempted?:boolean; operationExpiresAt?:number;
}
export function saveWorkspaceReplacement(record: PendingWorkspaceReplacement): void {
  replaceFileAtomically(replacementPath(), JSON.stringify(record) + '\n', 0o600);
}
export function readWorkspaceReplacement(): PendingWorkspaceReplacement | undefined {
  const file = replacementPath(); if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw Error('Unfinished replacement must be an owned private regular file');
  let record:PendingWorkspaceReplacement;try{record=JSON.parse(readFileSync(file, 'utf8'));}catch{throw Error('Unfinished replacement record is invalid');}
  if (![1,2].includes(record.version) || !opaque.test(record.operationNonce) || typeof record.configuration !== 'string' || resolve(record.configuration) !== record.configuration
    || (record.rootCid !== undefined && !/^[a-f0-9]{64}$/i.test(record.rootCid)) || (record.retired !== undefined && typeof record.retired !== 'boolean')
    || (record.cleaned !== undefined && typeof record.cleaned !== 'boolean') || (record.dispatchAttempted!==undefined && typeof record.dispatchAttempted!=='boolean') || (record.version===2 && (record.dispatchAttempted===undefined || (!Number.isSafeInteger(record.operationExpiresAt) || record.operationExpiresAt!<=0 || record.operationExpiresAt!>Date.now()+86400000+60000))) || (record.cleaned && !record.retired) || (record.retired && !record.rootCid)) throw Error('Unfinished replacement record is invalid');
  record.previous=binding(record.previous) as WorkspaceBinding & {serverCid:string};if(!record.previous.serverCid)throw Error('Unfinished replacement has no pinned server identity');
  record.payload = decodeWorkspacePayload(Buffer.from(JSON.stringify(record.payload)).toString('base64url'), {allowExpired: true});
  return record;
}
export function clearWorkspaceReplacement(): void { rmSync(replacementPath(), {force: true}); }
function checkReplacementService(configuration:string):void {
  const manager=new WebServiceManager(),service=manager.readMetadata();
  if(service?.configuration && resolve(service.configuration)!==resolve(configuration))throw Error('Installed web service uses another configuration; existing setup preserved');
  if(!service && existsSync(webControlPath()))throw Error('Stop the foreground Fleet web service before replacing its registration; existing setup preserved');
}
export async function beginWorkspaceReplacement(previous: WorkspaceBinding, payload: WorkspacePayload, configuration: string,effects:{preflight?:typeof unregisterWorkspace;attach?:AttachDaemonClient}={}): Promise<PendingWorkspaceReplacement> {
  checkWorkspaceConnector(payload);
  if(!requiresWorkspaceReplacement(previous,{workspaceId:payload.challenge.workspaceId,appOrigin:payload.appOrigin,serverCid:payload.serverCid}))throw Error('The same workspace must never be retired');
  checkReplacementService(configuration);
  const record: PendingWorkspaceReplacement = {version: 2, previous:previous as WorkspaceBinding & {serverCid:string}, payload, configuration: resolve(configuration), operationNonce: randomBytes(32).toString('base64url'),dispatchAttempted:false,operationExpiresAt:Date.now()+86400000};
  record.rootCid=await (effects.preflight??unregisterWorkspace)(record.previous,payload,record.operationNonce,effects.attach,{checkOnly:true,operationExpiresAt:record.operationExpiresAt});
  saveWorkspaceReplacement(record); return record;
}
/** Abandon only after a private receipt confirms no deletion and dispatch was unsent or terminally rejected. */
export async function abandonWorkspaceReplacement(effects:{inspect?:typeof unregisterWorkspace;attach?:AttachDaemonClient}={}):Promise<void> {
  const record=readWorkspaceReplacement();if(!record)throw Error('There is no unfinished replacement');
  if(record.retired || record.cleaned || record.version!==2)throw Error('Retirement may already have completed; resume this replacement instead of abandoning it');
  const current=readWorkspaceBinding();
  if(!current || current.workspaceId!==record.previous.workspaceId || current.hostWorkspaceId!==record.previous.hostWorkspaceId || current.appOrigin!==record.previous.appOrigin || current.serverCid?.toUpperCase()!==record.previous.serverCid.toUpperCase())throw Error('Workspace binding changed; replacement was not abandoned');
  let deleted:boolean|undefined,rejected=false,expired=false,deadlineEnforced=false;
  const root=await (effects.inspect??unregisterWorkspace)(record.previous,record.payload,record.operationNonce,effects.attach,{checkOnly:true,operationExpiresAt:record.operationExpiresAt,onReceipt:status=>{deleted=status.deleted;rejected=status.rejected===true;expired=status.expired===true;deadlineEnforced=status.deadlineEnforced===true;}});
  if(root.toUpperCase()!==record.rootCid?.toUpperCase() || deleted!==false || (record.dispatchAttempted && !(rejected && (!expired || Date.now()>record.operationExpiresAt!+5*60000) || deadlineEnforced && Date.now()>record.operationExpiresAt!+5*60000)))throw Error('Retirement may already have been sent; run --resume or abandon only after the account service confirms terminal rejection');
  clearWorkspaceReplacement();
}
/** A failed/expired one-time command can be renewed only for its pinned successor. */
export function refreshWorkspaceReplacement(record: PendingWorkspaceReplacement, payload: WorkspacePayload, configuration: string): void {
  if (resolve(configuration)!==record.configuration) throw Error('Replacement requires its original configuration');
  if (payload.challenge.workspaceId!==record.payload.challenge.workspaceId || payload.challenge.accountId!==record.payload.challenge.accountId
    || payload.appOrigin!==record.payload.appOrigin || payload.serverCid.toUpperCase()!==record.payload.serverCid.toUpperCase()
    || payload.hostname!==record.payload.hostname) throw Error('Unfinished replacement requires a fresh command for the same target workspace');
  record.payload=payload;saveWorkspaceReplacement(record);
}
/** Only tunnel files and account-issued device capabilities belong to this registration. */
export async function clearReplacedWorkspaceLocalState(): Promise<void> {
  const manager = new WebServiceManager();
  if (manager.readMetadata()) await manager.stop();
  const devices = new WorkspaceDeviceStore();
  try { devices.revokeAll(); } finally { devices.close(); }
  for (const file of ['tunnel.json', 'connector', 'pending-setup.json']) rmSync(join(workspaceDir(), file), {force: true});
}
/** Persist every irreversible boundary; the original binding stays until enrollment writes its successor. */
export async function finishWorkspaceReplacement(record: PendingWorkspaceReplacement, effects: {
  unregister?: typeof unregisterWorkspace; cleanup?: () => Promise<void>; enroll?: typeof enrollWorkspace; attach?: AttachDaemonClient;
} = {}): Promise<{origin: string; hostWorkspaceId: string; rootCid: string}> {
  const current = readWorkspaceBinding();
  if (!current || (current.workspaceId===record.previous.workspaceId ? (current.appOrigin!==record.previous.appOrigin || current.serverCid?.toUpperCase()!==record.previous.serverCid.toUpperCase() || current.hostWorkspaceId!==record.previous.hostWorkspaceId) : !sameWorkspaceBinding(current, record.payload))) throw Error('Workspace binding changed during replacement; review it before continuing');
  // A saved successor binding may predate a refreshed challenge. Enrollment
  // checks the exact proof receipt: it reuses confirmed proof, or signs the new
  // challenge, rather than assuming every challenge for this binding is done.
  if (!record.retired) {
    checkReplacementService(record.configuration);
    record.rootCid = await (effects.unregister ?? unregisterWorkspace)(record.previous, record.payload, record.operationNonce, effects.attach,{operationExpiresAt:record.operationExpiresAt,beforeSend:()=>{record.dispatchAttempted=true;saveWorkspaceReplacement(record);}});
    record.retired = true; saveWorkspaceReplacement(record);
  }
  if (!record.cleaned) { await (effects.cleanup ?? clearReplacedWorkspaceLocalState)(); record.cleaned = true; saveWorkspaceReplacement(record); }
  if (record.payload.challenge.expiresAt <= Date.now()) throw Error('Old registration was retired, but the replacement setup window expired. Get a fresh App command and pass --replace-registration; the retirement will not be repeated');
  return (effects.enroll ?? enrollWorkspace)(record.payload, record.configuration, {preserveProfile: true, replacingWorkspace: record.previous.workspaceId, attach: effects.attach});
}
