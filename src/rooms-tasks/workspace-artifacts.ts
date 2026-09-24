import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { stateRoot } from '../paths.js';
import { assertSafeAncestors, auditWorkspaceGit, validateWorkspace, ensureWorkspace, WorkspaceError, type OwnedWorkspace } from './workspace.js';

/** Runtime control state stays in Fleet's live roster and recovery store. Its
 * durable launch descriptor, not a name prefix or caller-supplied path, proves
 * artifact ownership. Audit receipts/journals intentionally outlive deletion.
 */
export function collectWorkspaceArchives(workspace: OwnedWorkspace): void {
  validateWorkspace(workspace);
  const root = join(stateRoot(), 'recovery', 'temporary');
  assertSafeAncestors(root);
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  const owned: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    const roleFile = join(path, 'role.yaml');
    let role: { name?: string; roomMemberStartup?: { workspace?: OwnedWorkspace } };
    try {
      const s = lstatSync(roleFile);
      if (!s.isFile() || s.isSymbolicLink()) continue;
      role = parse(readFileSync(roleFile, 'utf8'));
    } catch { continue; } // no ownership proof: never adopt a foreign archive
    const recorded = role?.roomMemberStartup?.workspace;
    if (recorded?.owner !== workspace.owner || recorded.id !== workspace.id) continue;
    if (JSON.stringify(recorded) !== JSON.stringify(workspace))
      throw new WorkspaceError('workspace archive ownership mismatch');
    assertSafeAncestors(path);
    const termination = join(path, 'termination.jsonl');
    if (!lstatSync(termination).isFile() || lstatSync(termination).isSymbolicLink())
      throw new WorkspaceError('unsafe workspace archive termination evidence');
    const supervisorPath = join(path, '.temp-supervisor.json');
    let supervisor: { role?: string; launchId?: string } | undefined;
    try {
      if (!lstatSync(supervisorPath).isFile() || lstatSync(supervisorPath).isSymbolicLink())
        throw new WorkspaceError('unsafe workspace archive supervisor evidence');
      supervisor = JSON.parse(readFileSync(supervisorPath, 'utf8'));
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (supervisor && (supervisor.role !== role.name || !supervisor.launchId))
      throw new WorkspaceError('workspace archive launch ownership mismatch');
    const terminated = readFileSync(termination, 'utf8').trim().split('\n').some(line => {
      const value = JSON.parse(line);
      return value.version === 1 && value.role === role.name
        && value.launchId === supervisor?.launchId
        && ['retired', 'reclaimed', 'failed'].includes(value.outcome);
    });
    if (!terminated || entry.name.endsWith('.retiring'))
      throw new WorkspaceError('workspace archive retirement is incomplete');
    auditWorkspaceGit(path);
    owned.push(path);
  }
  // Preflight the entire set before mutation; task/room record remains until all succeed.
  if (!owned.length) return;
  ensureWorkspace(workspace);
  const destination = join(workspace.path, '.fleet-retired-agents');
  assertSafeAncestors(destination);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const path of owned) {
    const target = join(destination, basename(path));
    try { lstatSync(target); throw new WorkspaceError('archive collection destination exists'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    // Atomic transfer before workspace deletion: a crash never loses ownership
    // evidence halfway through recursively removing a global recovery archive.
    renameSync(path, target);
  }
}
