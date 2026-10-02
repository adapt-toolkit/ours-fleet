import { existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { withFileLock } from './atomic-file.js';
import { loadConfig, splitRootFor } from './config.js';
import { preflightInitPaths } from './init-wizard.js';
import { workspaceOwnerInvite } from './paths.js';

/** Prepare only the web configuration; App onboarding chooses agents and brains later. */
export async function ensureMinimalSetup(configuration: string): Promise<void> {
  const initial = preflightInitPaths(configuration);
  await withFileLock(join(initial.parent, `.${basename(initial.splitRoot)}.init.lock`), async () => {
    const selected = preflightInitPaths(configuration);
    if (selected.manifestExisted) { loadConfig(selected.configPath, { yamlMode: 'strict', deferredOwnerInviteFile: workspaceOwnerInvite() }); return; }
    if (selected.rootExisted) throw new Error('Fleet split configuration exists without its manifest; retain it and recover the existing setup before setting up a tunnel');
    const stage = mkdtempSync(join(selected.parent, '.fleet-web-setup-'));
    const manifest = join(stage, 'fleet.yaml');
    const root = splitRootFor(manifest);
    let publishedRoot = false;
    try {
      mkdirSync(join(root, 'agents'), { recursive: true, mode: 0o700 });
      writeFileSync(manifest, 'api_version: ours.network/fleet/v2\n', { mode: 0o600, flag: 'wx' });
      loadConfig(manifest, { yamlMode: 'strict' });
      if (existsSync(selected.splitRoot) || existsSync(selected.configPath)) throw new Error('Fleet setup targets changed; refusing replacement');
      renameSync(root, selected.splitRoot); publishedRoot = true;
      // Same-filesystem link publishes without replacing an unexpected manifest.
      linkSync(manifest, selected.configPath); unlinkSync(manifest);
      loadConfig(selected.configPath, { yamlMode: 'strict' });
    } catch (cause) {
      if (publishedRoot) throw new Error('Minimal Fleet setup stopped after publishing its empty split directory; existing files were retained for recovery', { cause });
      throw cause;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
}
