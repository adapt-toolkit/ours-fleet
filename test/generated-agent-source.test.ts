import {
  chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GENERATED_AGENT_SOURCE_MARKER, provesGeneratedAgentSource, recordGeneratedAgentSource,
} from '../src/generated-agent-source.js';

let dir: string;
let marker: string;
const config = '/tmp/fleet.yaml';
const agent = '/tmp/fleet/agents/A.yaml';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-generated-source-'));
  marker = join(dir, GENERATED_AGENT_SOURCE_MARKER);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('generated Agent source deletion authority', () => {
  it('records an exact regular 0600 marker and proves only matching paths', () => {
    recordGeneratedAgentSource(dir, config, agent);
    const stat = lstatSync(marker);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(provesGeneratedAgentSource(dir, config, agent)).toBe(true);
    expect(provesGeneratedAgentSource(dir, '/tmp/other.yaml', agent)).toBe(false);
    expect(provesGeneratedAgentSource(dir, config, '/tmp/fleet/agents/B.yaml')).toBe(false);
  });

  it('fails closed for malformed and permissive markers', () => {
    writeFileSync(marker, '{broken', { mode: 0o600 });
    expect(provesGeneratedAgentSource(dir, config, agent)).toBe(false);
    recordGeneratedAgentSource(dir, config, agent);
    chmodSync(marker, 0o622);
    expect(provesGeneratedAgentSource(dir, config, agent)).toBe(false);
  });

  it('never follows a marker symlink when proving or recording authority', () => {
    const target = join(dir, 'target.json');
    writeFileSync(target, 'do not overwrite', { mode: 0o600 });
    symlinkSync(target, marker);
    expect(provesGeneratedAgentSource(dir, config, agent)).toBe(false);

    recordGeneratedAgentSource(dir, config, agent);
    expect(readFileSync(target, 'utf8')).toBe('do not overwrite');
    expect(lstatSync(marker).isSymbolicLink()).toBe(false);
    expect(provesGeneratedAgentSource(dir, config, agent)).toBe(true);
  });
});
