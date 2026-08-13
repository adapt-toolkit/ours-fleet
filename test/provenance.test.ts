import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { realExec } from '../src/exec.js';
import { VERSION } from '../src/version.js';
import {
  analyzeInstalls, buildInfo, buildLabel, contentDigest, discoverInstalls, readInstall,
} from '../src/provenance.js';
import { binPath, cliPath, installPrefix, pkgRoot } from './install-fixtures.js';

let root: string;
let legacy: string;
let current: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ours-fleet-prov-'));
  legacy = installPrefix(root, 'legacy');
  current = installPrefix(root, 'current');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the divergent-install fixtures', () => {
  it('report the same semver from two binaries that disagree about after_tool', async () => {
    const cfg = join(root, 'fleet.yaml');
    writeFileSync(cfg, 'roles:\n  Probe:\n    monitor:\n      interrupt: after_tool\n');

    const versions = await Promise.all([legacy, current].map(async p =>
      (await realExec(binPath(p), ['--version'])).stdout.trim()));
    expect(versions).toEqual(['0.16.0', '0.16.0']);

    expect((await realExec(binPath(legacy), ['config', cfg])).code).toBe(1);
    expect((await realExec(binPath(current), ['config', cfg])).code).toBe(0);
  });
});

describe('readInstall', () => {
  it('reads the version, build id and capabilities of an install root', () => {
    const install = readInstall(pkgRoot(current));
    expect(install?.version).toBe('0.16.0');
    expect(install?.build?.buildId).toBe('c0ffee123456');
    expect(install?.build?.capabilities).toContain('monitor.interrupt.after_tool');
  });

  it('leaves the build undefined for a pre-provenance install', () => {
    const install = readInstall(pkgRoot(legacy));
    expect(install?.version).toBe('0.16.0');
    expect(install?.build).toBeUndefined();
  });

  it('ignores a directory that is not a fleet package', () => {
    expect(readInstall(root)).toBeUndefined();
  });
});

describe('discoverInstalls', () => {
  it('finds every ours-fleet on PATH and marks the one that is running', () => {
    const found = discoverInstalls({
      path: [join(legacy, 'bin'), join(current, 'bin')].join(delimiter),
      argv1: cliPath(current),
    });
    expect(found.map(i => i.packageRoot)).toEqual([pkgRoot(legacy), pkgRoot(current)]);
    expect(found.map(i => i.pathIndex)).toEqual([0, 1]);
    expect(found.map(i => i.running)).toEqual([false, true]);
  });

  it('reports a running install that is not on PATH at all', () => {
    const found = discoverInstalls({
      path: join(legacy, 'bin'),
      argv1: cliPath(current),
    });
    const running = found.find(i => i.running);
    expect(running?.packageRoot).toBe(pkgRoot(current));
    expect(running?.pathIndex).toBeUndefined();
  });

  it('ignores a PATH entry that the shell itself would not execute', () => {
    // A partially-installed prefix whose command lost its mode bits: the shell
    // skips it and runs the next one. Counting it would let a broken install
    // shadow the real one in every provenance verdict.
    const broken = installPrefix(join(root, 'broken'), 'current');
    chmodSync(cliPath(broken), 0o644);

    const found = discoverInstalls({
      path: [join(broken, 'bin'), join(current, 'bin')].join(delimiter),
      argv1: undefined,
    });
    expect(found.map(i => i.bin)).toEqual([binPath(current)]);
  });

  it('ignores a PATH entry that resolves to a directory', () => {
    const odd = installPrefix(join(root, 'odd'), 'current');
    rmSync(binPath(odd));
    symlinkSync('../lib/node_modules/@ours.network/fleet/dist', binPath(odd));

    expect(discoverInstalls({ path: join(odd, 'bin'), argv1: undefined })).toEqual([]);
  });

  it('lists a shared install root once even when several PATH entries reach it', () => {
    const found = discoverInstalls({
      path: [join(current, 'bin'), join(current, 'bin')].join(delimiter),
      argv1: undefined,
    });
    expect(found).toHaveLength(1);
  });
});

describe('discoverInstalls against the real environment', () => {
  // The one place that exercises the ambient code path on purpose. It still
  // controls PATH, so the verdict cannot depend on what this machine happens to
  // have installed — that is the difference between an integration test and a
  // test that reads the host's mind.
  it('reads process.env.PATH and process.argv[1] when given neither', () => {
    const savedPath = process.env.PATH;
    process.env.PATH = join(current, 'bin');
    try {
      const found = discoverInstalls();
      expect(found.map(i => i.packageRoot)).toContain(pkgRoot(current));
      expect(found.find(i => i.packageRoot === pkgRoot(current))?.bin).toBe(binPath(current));
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});

describe('analyzeInstalls', () => {
  const both = () => discoverInstalls({
    path: [join(legacy, 'bin'), join(current, 'bin')].join(delimiter),
    argv1: cliPath(current),
  });

  it('flags two installs that share a semver but not a build', () => {
    const conflict = analyzeInstalls(both()).find(s => s.kind === 'version-build-conflict');
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain('0.16.0');
    expect(conflict?.message).toContain(pkgRoot(legacy));
    expect(conflict?.message).toContain(pkgRoot(current));
  });

  it('flags that the running executable is not the one PATH resolves to', () => {
    const shadowed = analyzeInstalls(both()).find(s => s.kind === 'shadowed-runtime');
    expect(shadowed?.message).toContain(binPath(legacy));
  });

  it('tells two pre-provenance installs apart by what their dist actually contains', () => {
    const a = installPrefix(join(root, 'pair-a'), 'legacy');
    const b = installPrefix(join(root, 'pair-b'), 'legacy');
    appendFileSync(cliPath(b), '\n// a later fix, same 0.16.0\n');
    const found = discoverInstalls({
      path: [join(a, 'bin'), join(b, 'bin')].join(delimiter),
      argv1: undefined,
    });

    expect(analyzeInstalls(found).map(s => s.kind)).toContain('version-build-conflict');
    // Without a content fallback both are just "0.16.0+unknown" and the skew is invisible.
    expect(analyzeInstalls(found, () => undefined).map(s => s.kind))
      .not.toContain('version-build-conflict');
  });

  it('says nothing when PATH and the runtime are two copies of the same artifact', () => {
    // A second prefix holding byte-identical content is not a skew: whichever
    // one answers, the operator gets the same behaviour. Calling that an error
    // trains people to ignore the check.
    const copy = installPrefix(join(root, 'copy'), 'current');
    const skews = analyzeInstalls(discoverInstalls({
      path: join(copy, 'bin'),
      argv1: cliPath(current),
    }));
    expect(skews.map(s => s.kind)).not.toContain('shadowed-runtime');
  });

  it('says nothing for identical copies that predate build stamps either', () => {
    const a = installPrefix(join(root, 'legacy-a'), 'legacy');
    const b = installPrefix(join(root, 'legacy-b'), 'legacy');
    const skews = analyzeInstalls(discoverInstalls({ path: join(a, 'bin'), argv1: cliPath(b) }));
    expect(skews.map(s => s.kind)).not.toContain('shadowed-runtime');
  });

  it('still flags a shadowing install whose content actually differs', () => {
    const other = installPrefix(join(root, 'other'), 'legacy');
    const skews = analyzeInstalls(discoverInstalls({
      path: join(other, 'bin'),
      argv1: cliPath(current),
    }));
    expect(skews.find(s => s.kind === 'shadowed-runtime')?.severity).toBe('error');
  });

  it('reports nothing when a single install serves both PATH and the runtime', () => {
    const found = discoverInstalls({
      path: join(current, 'bin'),
      argv1: cliPath(current),
    });
    expect(analyzeInstalls(found)).toEqual([]);
  });
});

describe('buildLabel', () => {
  it('appends the build id to the semver', () => {
    expect(buildLabel(readInstall(pkgRoot(current))!)).toBe('0.16.0+c0ffee123456');
  });

  it('says the build identity is unknown for a pre-provenance install', () => {
    expect(buildLabel(readInstall(pkgRoot(legacy))!)).toBe('0.16.0+unknown');
  });
});

describe('buildInfo', () => {
  it('describes this build with a content-derived id and declared capabilities', () => {
    const info = buildInfo();
    expect(info.version).toBe(VERSION);
    expect(info.buildId).toMatch(/^[0-9a-f]{12}$/);
    expect(info.capabilities).toContain('monitor.interrupt.after_tool');
  });
});

describe('contentDigest', () => {
  it('reproduces the build id this repo\'s own build stamped', () => {
    expect(contentDigest(process.cwd())).toBe(buildInfo().buildId);
  });

  it('is undefined for a directory with no dist', () => {
    expect(contentDigest(root)).toBeUndefined();
  });
});
