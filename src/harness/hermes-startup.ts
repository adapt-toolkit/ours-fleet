import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
export { validateHermesInitialize as validateHermesHandshake } from './hermes-compatibility.js';

/** Compare a native provisioned identity, never infer it from the child's report. */
export function hermesConfiguredProvider(home: string): string {
  let provider: unknown;
  try { provider = YAML.parse(readFileSync(join(home, 'config.yaml'), 'utf8'))?.model?.provider; }
  catch { throw new Error('Cannot read Hermes native provider; repair config.yaml in the stopped role home'); }
  if (typeof provider !== 'string' || !provider.trim() || provider.trim().toLowerCase() === 'auto' || provider.includes('${'))
    throw new Error('Hermes requires a literal native model.provider in the stopped role home so startup can detect provider fallback');
  const canonical = provider.trim().toLowerCase();
  // The tested runtime collapses named custom endpoints to custom, while its
  // ACP model catalog reports Ollama under custom:ollama.
  return canonical === 'ollama' || canonical === 'custom:ollama' ? 'custom:ollama'
    : canonical.startsWith('custom:') ? 'custom' : canonical;
}
