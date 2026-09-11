import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { hermesConfiguredProvider, validateHermesHandshake } from '../src/harness/hermes-startup.js';
const homes: string[] = [];
const provision = (provider: unknown) => { const home = mkdtempSync(join(tmpdir(), 'hermes-startup-')); homes.push(home); writeFileSync(join(home, 'config.yaml'), YAML.stringify({ model: { provider } })); return home; };
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
describe('Hermes startup identity', () => {
  it.each([[' OpenAI ', 'openai'], ['custom:fixture', 'custom'], ['ollama', 'custom:ollama'], ['custom:ollama', 'custom:ollama']])('reads native provider %s', (provider, expected) => {
    expect(hermesConfiguredProvider(provision(provider))).toBe(expected);
  });
  it.each([undefined, null, '', 'auto', '${PROVIDER}', '${env:PROVIDER}'])('refuses unproven native provider %s', provider => {
    expect(() => hermesConfiguredProvider(provision(provider))).toThrow(/provider/);
  });
  it('accepts the tested handshake and rejects missing or unknown reports', () => {
    expect(() => validateHermesHandshake({ protocolVersion: 1, agentInfo: { name: 'hermes-agent', version: '0.21.1' }, agentCapabilities: {} })).not.toThrow();
    for (const version of [undefined, '0.0.0']) expect(() => validateHermesHandshake({ protocolVersion: 1, agentInfo: { name: 'hermes-agent', version }, agentCapabilities: {} })).toThrow(/compatib|tested/);
    expect(() => validateHermesHandshake({ protocolVersion: 999, agentCapabilities: {} })).toThrow();
  });
});
