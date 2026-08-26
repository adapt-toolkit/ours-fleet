import { describe, expect, it } from 'vitest';
import {
  MAX_BRAIN_FIELD_BYTES, MAX_CAPABILITIES, MAX_CAPABILITY_BYTES, MAX_ROLE_TEXT_BYTES,
  parseBrainRef, parseTypedResource, ResourceValidationError,
} from '../src/config-resources.js';

describe('typed configuration resources', () => {
  it('accepts named and complete inline Brain references', () => {
    expect(parseBrainRef({ template: 'cheap' })).toEqual({ template: 'cheap' });
    expect(parseBrainRef({
      harness: 'codex', model: 'gpt-5.6-sol', effort: 'high', session: 'acp',
    })).toEqual({
      harness: 'codex', model: 'gpt-5.6-sol', effort: 'high', session: 'acp',
    });
  });

  it.each([
    [{ harness: 'codex', model: 'gpt', session: 'acp' }],
    [{ template: 'cheap', effort: 'low' }],
    [{ harness: 'codex', model: 'gpt', effort: 'high', session: 'acp', extra: true }],
  ])('rejects partial, ambiguous, and extra-field Brain references', value => {
    expect(() => parseBrainRef(value)).toThrow(/exactly \{template\}/u);
  });

  it('never normalizes IDs, template references, or Brain fields', () => {
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: " cheap "
spec: {}
`)).toThrow(/leading or trailing whitespace/u);
    expect(() => parseBrainRef({ template: ' cheap ' })).toThrow(/leading or trailing whitespace/u);
    expect(() => parseBrainRef({ template: 'not.a.resource' })).toThrow(/must match/u);
    expect(() => parseBrainRef({
      harness: ' codex', model: 'gpt', effort: 'high', session: 'acp',
    })).toThrow(/leading or trailing whitespace/u);
  });

  it('keeps Role resources behavior-only', () => {
    expect(parseTypedResource('secretary.yaml', `
kind: Role
version: 1
id: Secretary
spec:
  bio: Public card
  persona: Deliberate first
  capabilities: [implementation, deliberation]
`)).toEqual({
      kind: 'Role', version: 1, id: 'Secretary',
      spec: {
        bio: 'Public card', persona: 'Deliberate first',
        capabilities: ['implementation', 'deliberation'],
      },
    });
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: Secretary
spec: { harness: codex }
`)).toThrow(/unknown key\(s\): harness/u);
  });

  it('requires Brain resources to contain exactly the four defining fields', () => {
    expect(parseTypedResource('cheap.yaml', `
kind: Brain
version: 1
id: cheap
spec: { harness: claude-code, model: claude-haiku, effort: low, session: acp }
`)).toMatchObject({ kind: 'Brain', id: 'cheap' });
    expect(() => parseTypedResource('bad.yaml', `
kind: Brain
version: 1
id: bad
spec: { template: cheap }
`)).toThrow(/require a complete inline definition/u);
  });

  it('rejects duplicate capabilities, invalid IDs, unknown top-level fields, and YAML streams', () => {
    const cases = [
      [`kind: Role\nversion: 1\nid: bad.id\nspec: {}\n`, /must match/u],
      [`kind: Role\nversion: 1\nid: ok\nextra: true\nspec: {}\n`, /unknown key/u],
      [`kind: Role\nversion: 1\nid: ok\nspec:\n  capabilities: [same, same]\n`, /duplicates/u],
      [`kind: Role\nversion: 1\nid: one\nspec: {}\n---\nkind: Role\nversion: 1\nid: two\nspec: {}\n`, /exactly one YAML document/u],
    ] as const;
    for (const [source, error] of cases)
      expect(() => parseTypedResource('resource.yaml', source)).toThrow(error);
  });

  it('requires bounded stable capability tokens and bounded Role/Brain strings', () => {
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec: { capabilities: ["two words"] }
`)).toThrow(/stable ASCII token/u);
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec: { capabilities: [" padded "] }
`)).toThrow(/leading or trailing whitespace/u);
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec: { capabilities: [${Array.from({ length: MAX_CAPABILITIES + 1 }, (_, i) => `c${i}`).join(', ')}] }
`)).toThrow(/at most 64 entries/u);
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec: { capabilities: [${'x'.repeat(MAX_CAPABILITY_BYTES + 1)}] }
`)).toThrow(/at most 128 UTF-8 bytes/u);
    expect(() => parseTypedResource('bad.yaml', `
kind: Role
version: 1
id: role
spec:
  bio: ${'x'.repeat(MAX_ROLE_TEXT_BYTES + 1)}
`)).toThrow(/at most 65536 UTF-8 bytes/u);
    expect(() => parseBrainRef({
      harness: 'x'.repeat(MAX_BRAIN_FIELD_BYTES + 1), model: 'gpt', effort: 'high', session: 'acp',
    })).toThrow(/at most 256 UTF-8 bytes/u);
  });

  it('reports the source file and exact field path', () => {
    try {
      parseTypedResource('/config/brains.d/cheap.yaml', `
kind: Brain
version: 1
id: cheap
spec: { harness: claude-code, model: '', effort: low, session: acp }
`);
      expect.fail('expected validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceValidationError);
      expect((error as Error).message).toContain('/config/brains.d/cheap.yaml:$.spec.model');
    }
  });
});
