import { describe, expect, it } from 'vitest';
import { blankResource, parseResourceDraft, stableResources } from '../../web/src/resource-edit-model.js';

describe('typed resource edit model', () => {
  it('keeps Role, Brain, and Agent distinct', () => {
    expect(blankResource('Role').spec).toHaveProperty('mission');
    expect(blankResource('Brain').spec).toHaveProperty('harness');
    expect(blankResource('Agent').spec).toMatchObject({ lifecycle: 'persistent' });
  });
  it('rejects unsupported kinds and path-like ids and sorts deterministically', () => {
    expect(() => parseResourceDraft('{"kind":"Role","version":1,"id":"../x","spec":{}}')).toThrow();
    expect(stableResources([
      { kind: 'Role', version: 1, id: 'b', spec: {} }, { kind: 'Brain', version: 1, id: 'a', spec: {} },
    ]).map(value => `${value.kind}:${value.id}`)).toEqual(['Brain:a', 'Role:b']);
  });
});
