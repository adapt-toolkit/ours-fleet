import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CODEX_ACP_VERSION = '1.1.7';

describe('packed root package', () => {
  it('fresh-installs the gated codex-acp and reports the exact allow + workspace policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'ours-fleet-packed-'));
    const packDir = join(root, 'pack');
    const consumerDir = join(root, 'consumer');
    try {
      mkdirSync(packDir);
      mkdirSync(consumerDir);
      const packed = JSON.parse(execFileSync('npm', [
        'pack', '--json', '--pack-destination', packDir,
      ], { encoding: 'utf8' }))[0] as { filename: string };
      const tarball = join(packDir, packed.filename);

      writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
        private: true,
        dependencies: { '@ours.network/fleet': `file:${tarball}` },
      }));
      execFileSync('npm', [
        'install', '--ignore-scripts', '--no-audit', '--no-fund', '--include=optional',
      ], {
        cwd: consumerDir,
        encoding: 'utf8',
        env: { ...process.env, npm_config_update_notifier: 'false' },
        timeout: 180_000,
      });

      const fleetRoot = join(consumerDir, 'node_modules', '@ours.network', 'fleet');
      const fleetPackage = JSON.parse(readFileSync(join(fleetRoot, 'package.json'), 'utf8'));
      expect(fleetPackage.optionalDependencies['@agentclientprotocol/codex-acp'])
        .toBe(CODEX_ACP_VERSION);

      const probe = `
        import { existsSync, mkdirSync, readFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { pathToFileURL } from 'node:url';
        const modules = join(process.cwd(), 'node_modules');
        const fleetRoot = join(modules, '@ours.network', 'fleet');
        const codexRoot = join(modules, '@agentclientprotocol', 'codex-acp');
        const codex = JSON.parse(readFileSync(join(codexRoot, 'package.json'), 'utf8'));
        const { makeCodexAdapter } = await import(
          pathToFileURL(join(fleetRoot, 'dist', 'harness', 'codex.js')).href
        );
        const adapter = makeCodexAdapter(async cmd => ({
          code: cmd === 'sh' ? 1 : 0, stdout: '', stderr: '',
        }));
        const role = {
          name: 'PackedConsumer',
          harness: 'codex',
          identity: 'PackedConsumer',
          sourceFile: 'fixture',
          session: 'acp',
          permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
        };
        const stateDir = join(process.cwd(), 'state');
        mkdirSync(stateDir);
        const prep = await adapter.prepareSession(role, { stateDir, runCwd: process.cwd() });
        const launch = adapter.buildAcpLaunch(role, prep);
        const claim = adapter.effectivePermissions(role);
        process.stdout.write(JSON.stringify({
          version: codex.version,
          claim,
          prepared: {
            codeXPathExists: existsSync(prep.env.CODEX_PATH),
            approval: prep.env.OURS_FLEET_CODEX_APPROVAL,
            sandbox: prep.env.OURS_FLEET_CODEX_SANDBOX,
            initialAgentMode: launch.env.INITIAL_AGENT_MODE,
          },
        }));
      `;
      const result = JSON.parse(execFileSync(process.execPath, [
        '--input-type=module', '--eval', probe,
      ], { cwd: consumerDir, encoding: 'utf8' }));

      expect(result.version).toBe(CODEX_ACP_VERSION);
      expect(result.claim).toMatchObject({
        supported: true,
        exact: true,
        native: { mode: 'agent', approval: 'never', sandbox: 'workspace-write' },
      });
      expect(result.claim.warnings).toEqual([]);
      expect(result.prepared).toEqual({
        codeXPathExists: true,
        approval: 'never',
        sandbox: 'workspace-write',
        initialAgentMode: 'agent',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
