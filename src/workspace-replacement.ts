import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { validateAccountOrigin } from './account-origin.js';
import { replaceFileAtomically } from './atomic-file.js';
import { stateRoot } from './paths.js';
import { decodeWorkspacePayload, enrollWorkspace, unregisterWorkspace, type AttachDaemonClient, type WorkspacePayload } from './workspace-enrollment.js';
import { WorkspaceDeviceStore } from './web/workspace-devices.js';
import { webControlPath } from './web/control.js';
import { WebServiceManager } from './web/service.js';

export interface WorkspaceBinding { workspaceId: string; hostWorkspaceId: string; appOrigin: string; serverCid: string; proofRootCid?: string }
const workspaceDir = () => join(stateRoot(), 'workspace');
const replacementPath = () => join(workspaceDir(), 'replacement.json');
const opaque = /^[\w-]{43}$/;
function binding(value: WorkspaceBinding): WorkspaceBinding {
  if (!value || !opaque.test(value.workspaceId) || !opaque.test(value.hostWorkspaceId) || !/^[a-f0-9]{64}$/i.test(value.serverCid)
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
  return previous.workspaceId === payload.challenge.workspaceId && previous.appOrigin === payload.appOrigin && previous.serverCid.toUpperCase() === payload.serverCid.toUpperCase();
}
/** Ask before redeeming the one-use grant, whose destination is deliberately opaque. */
export async function confirmWorkspaceReplacement(previous: WorkspaceBinding, explicit = false, effects: {
  write?: (value: string) => void; interactive?: boolean; ask?: () => Promise<string>;
} = {}): Promise<boolean> {
  const write = effects.write ?? (value => { process.stderr.write(value); });
  write(`This host is registered to workspace ${previous.workspaceId} at ${previous.appOrigin}.\nReplacing it deletes that account registration and its tunnel, and revokes its linked devices. Installation identities, agents and data are preserved. The same registration can be set up again without deleting it.\n`);
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
  version: 1; previous: WorkspaceBinding; payload: WorkspacePayload; configuration: string; operationNonce: string;
  rootCid?: string; retired?: boolean; cleaned?: boolean;
}
export function saveWorkspaceReplacement(record: PendingWorkspaceReplacement): void {
  replaceFileAtomically(replacementPath(), JSON.stringify(record) + '\n', 0o600);
}
export function readWorkspaceReplacement(): PendingWorkspaceReplacement | undefined {
  const file = replacementPath(); if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw Error('Unfinished replacement must be an owned private regular file');
  let record:PendingWorkspaceReplacement;try{record=JSON.parse(readFileSync(file, 'utf8'));}catch{throw Error('Unfinished replacement record is invalid');}
  if (record.version !== 1 || !opaque.test(record.operationNonce) || typeof record.configuration !== 'string' || resolve(record.configuration) !== record.configuration
    || (record.rootCid !== undefined && !/^[a-f0-9]{64}$/i.test(record.rootCid)) || (record.retired !== undefined && typeof record.retired !== 'boolean')
    || (record.cleaned !== undefined && typeof record.cleaned !== 'boolean') || (record.cleaned && !record.retired) || (record.retired && !record.rootCid)) throw Error('Unfinished replacement record is invalid');
  record.previous = binding(record.previous);
  record.payload = decodeWorkspacePayload(Buffer.from(JSON.stringify(record.payload)).toString('base64url'), {allowExpired: true});
  return record;
}
export function clearWorkspaceReplacement(): void { rmSync(replacementPath(), {force: true}); }
export function beginWorkspaceReplacement(previous: WorkspaceBinding, payload: WorkspacePayload, configuration: string): PendingWorkspaceReplacement {
  const record: PendingWorkspaceReplacement = {version: 1, previous, payload, configuration: resolve(configuration), operationNonce: randomBytes(32).toString('base64url')};
  saveWorkspaceReplacement(record); return record;
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
  if (!current || (current.workspaceId===record.previous.workspaceId ? (current.appOrigin!==record.previous.appOrigin || current.serverCid.toUpperCase()!==record.previous.serverCid.toUpperCase() || current.hostWorkspaceId!==record.previous.hostWorkspaceId) : !sameWorkspaceBinding(current, record.payload))) throw Error('Workspace binding changed during replacement; review it before continuing');
  // A saved successor binding may predate a refreshed challenge. Enrollment
  // checks the exact proof receipt: it reuses confirmed proof, or signs the new
  // challenge, rather than assuming every challenge for this binding is done.
  if (!record.retired) {
    const manager=new WebServiceManager(),service=manager.readMetadata();
    if(service?.configuration && resolve(service.configuration)!==record.configuration)throw Error('Installed web service uses another configuration; existing setup preserved');
    if(!service && existsSync(webControlPath()))throw Error('Stop the foreground Fleet web service before replacing its registration; existing setup preserved');
    record.rootCid = await (effects.unregister ?? unregisterWorkspace)(record.previous, record.payload, record.operationNonce, effects.attach);
    record.retired = true; saveWorkspaceReplacement(record);
  }
  if (!record.cleaned) { await (effects.cleanup ?? clearReplacedWorkspaceLocalState)(); record.cleaned = true; saveWorkspaceReplacement(record); }
  if (record.payload.challenge.expiresAt <= Date.now()) throw Error('Old registration was retired, but the replacement setup window expired. Get a fresh App command and pass --replace-registration; the retirement will not be repeated');
  return (effects.enroll ?? enrollWorkspace)(record.payload, record.configuration, {preserveProfile: true, replacingWorkspace: record.previous.workspaceId, attach: effects.attach});
}
