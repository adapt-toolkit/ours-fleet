/**
 * Packing runs the prepack build, which cleans this checkout's dist/. Keep this
 * subprocess-heavy install probe in the serial package gate so the ordinary
 * suite can safely use the dist built by its global setup.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CODEX_ACP_VERSION = '1.1.7';

describe('packed root package', () => {
  it('fresh-installs the gated codex-acp and reports coupled allow full access', () => {
    const root = mkdtempSync(join(tmpdir(), 'ours-fleet-packed-'));
    const packDir = join(root, 'pack');
    const consumerDir = join(root, 'consumer');
    const consumerWithoutOptionalDir = join(root, 'consumer-without-optional');
    try {
      mkdirSync(packDir);
      mkdirSync(consumerDir);
      mkdirSync(consumerWithoutOptionalDir);
      const packOutput = execFileSync('npm', [
        'pack', '--json', '--pack-destination', packDir,
      ], {
        encoding: 'utf8',
        env: { ...process.env, npm_config_foreground_scripts: 'true' },
      });
      // Foreground lifecycle scripts can prefix npm's JSON (with ANSI color in CI).
      const packJson = packOutput.slice(packOutput.lastIndexOf('\n[') + 1);
      const packed = JSON.parse(packJson)[0] as { filename: string };
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
        import { readFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { pathToFileURL } from 'node:url';
        const modules = join(process.cwd(), 'node_modules');
        const fleetRoot = join(modules, '@ours.network', 'fleet');
        const codexRoot = join(modules, '@agentclientprotocol', 'codex-acp');
        const codex = JSON.parse(readFileSync(join(codexRoot, 'package.json'), 'utf8'));
        const { makeCodexAdapter } = await import(
          pathToFileURL(join(fleetRoot, 'dist', 'harness', 'codex.js')).href
        );
        const index = await import(
          pathToFileURL(join(fleetRoot, 'dist', 'index.js')).href
        );
        const { createAgentProductionRuntime, AgentInstallationService } = index;
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
        const claim = adapter.effectivePermissions(role);
        process.stdout.write(JSON.stringify({
          version: codex.version,
          claim,
          productExport: {
            runtime: typeof createAgentProductionRuntime,
            rawPermanent: typeof index.createProductionAgentSupervisorRehydration,
            rawTemporary: typeof index.createProductionTempAgentSupervisorRehydration,
            installer: typeof AgentInstallationService,
          },
          legacyAttempt: typeof adapter.prepareAcpLegacy,
        }));
      `;
      const result = JSON.parse(execFileSync(process.execPath, [
        '--input-type=module', '--eval', probe,
      ], { cwd: consumerDir, encoding: 'utf8' }));

      expect(result.version).toBe(CODEX_ACP_VERSION);
      expect(result.productExport).toEqual({ runtime: 'function', rawPermanent: 'undefined',
        rawTemporary: 'undefined', installer: 'function' });
      expect(result.legacyAttempt).toBe('undefined');
      expect(result.claim).toMatchObject({
        supported: true,
        exact: false,
        native: {
          mode: 'agent-full-access', approval: 'never', sandbox: 'danger-full-access',
        },
      });
      expect(result.claim.warnings.join('\n'))
        .toContain("mode 'agent-full-access' couples approval and filesystem");

      writeFileSync(join(consumerWithoutOptionalDir, 'package.json'), JSON.stringify({
        private: true,
        dependencies: { '@ours.network/fleet': `file:${tarball}` },
      }));
      execFileSync('npm', [
        'install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional',
      ], {
        cwd: consumerWithoutOptionalDir,
        encoding: 'utf8',
        env: { ...process.env, npm_config_update_notifier: 'false' },
        timeout: 180_000,
      });

      const fallbackProbe = `
        import { existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { pathToFileURL } from 'node:url';
        const modules = join(process.cwd(), 'node_modules');
        const fleetRoot = join(modules, '@ours.network', 'fleet');
        const codexRoot = join(modules, '@agentclientprotocol', 'codex-acp');
        const { makeCodexAdapter } = await import(
          pathToFileURL(join(fleetRoot, 'dist', 'harness', 'codex.js')).href
        );
        const adapter = makeCodexAdapter(async () => ({
          code: 1, stdout: '', stderr: '',
        }));
        const role = {
          name: 'PackedFallback',
          harness: 'codex',
          identity: 'PackedFallback',
          sourceFile: 'fixture',
          session: 'acp',
          permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'wait' },
        };
        process.stdout.write(JSON.stringify({
          bundledPresent: existsSync(codexRoot),
          adapterAvailable: typeof adapter.prepareSession === 'function',
          legacyAttempt: typeof adapter.prepareAcpLegacy,
        }));
      `;
      const fallback = JSON.parse(execFileSync(process.execPath, [
        '--input-type=module', '--eval', fallbackProbe,
      ], { cwd: consumerWithoutOptionalDir, encoding: 'utf8' }));
      expect(fallback).toEqual({
        bundledPresent: false,
        adapterAvailable: true,
        legacyAttempt: 'undefined',
      });
      expect(existsSync(join(
        consumerWithoutOptionalDir, 'node_modules', '@agentclientprotocol', 'codex-acp',
      ))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
