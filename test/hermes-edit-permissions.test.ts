import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNativeHermesFixture } from './fixtures/hermes-acp/native-fixture.js';

const enabled = process.env.HERMES_ACP_INTEGRATION_REQUIRED === '1'
  || process.env.HERMES_ACP_INTEGRATION === '1';

// These are real native calls against a deterministic local provider. A required
// run fails if the tested artifact is unavailable; it never converts that failure to a skip.
describe.skipIf(!enabled)('installed Hermes ACP edit permission conformance', () => {
  it.each(['write_file', 'patch'] as const)('default mode denies and approves %s before changing project bytes', async tool => {
    const fixture = await createNativeHermesFixture();
    try {
      const child = await fixture.start(`fleet-fixture-edit-${tool}`);
      await child.rpc('session/set_mode', { sessionId: child.session.sessionId, modeId: 'default' });
      const path = join(fixture.cwd, 'edit-permission.txt');
      await writeFile(path, 'before\n');
      const args = (oldText: string, newText: string) => tool === 'write_file'
        ? { path, content: newText }
        : { path, old_string: oldText, new_string: newText };

      child.setPermissionAnswer('deny');
      fixture.callToolNext(tool, args('before\n', 'approved\n'));
      await child.prompt('Apply the deterministic fixture edit.');
      expect(await readFile(path, 'utf8')).toBe('before\n');
      expect(child.permissionRequests()).toHaveLength(1);
      expect(child.permissionRequests()[0].params.toolCall).toMatchObject({ kind: 'edit', rawInput: { tool } });
      expect(fixture.toolResults()).toContain('Edit approval denied');

      child.setPermissionAnswer('allow_once');
      fixture.callToolNext(tool, args('before\n', 'approved\n'));
      await child.prompt('Apply the fixture edit with approval.');
      expect(await readFile(path, 'utf8')).toBe('approved\n');
      expect(child.permissionRequests()).toHaveLength(2);

      // A prior allow_once must not authorize the next file edit.
      child.setPermissionAnswer('deny');
      fixture.callToolNext(tool, args('approved\n', 'must-not-land\n'));
      await child.prompt('Apply the next deterministic fixture edit.');
      expect(await readFile(path, 'utf8')).toBe('approved\n');
      expect(child.permissionRequests()).toHaveLength(3);

      // Names establish advertised standard-toolset coverage, not universal
      // approval mediation or availability of an unconfigured MCP connector.
      expect(fixture.inferenceTools()).toEqual(expect.arrayContaining([
        'terminal', 'write_file', 'patch', 'browser_click', 'memory',
        'skill_manage', 'delegate_task', 'tool_search', 'tool_call',
      ]));
    } finally { await fixture.close(); }
  }, 90_000);

  it.each(['accept_edits', 'dont_ask'])('%s permits ordinary workspace edits and retains the sensitive-path prompt', async mode => {
    const fixture = await createNativeHermesFixture();
    try {
      const child = await fixture.start(`fleet-fixture-edit-${mode}`);
      await child.rpc('session/set_mode', { sessionId: child.session.sessionId, modeId: mode });
      child.setPermissionAnswer('deny'); // Any unexpected prompt must block, not be auto-approved by the fixture.
      const path = join(fixture.cwd, 'automatic-edit.txt');
      fixture.callToolNext('write_file', { path, content: 'created\n' });
      await child.prompt('Create the ordinary fixture project file.');
      expect(await readFile(path, 'utf8')).toBe('created\n');
      fixture.callToolNext('patch', { path, old_string: 'created\n', new_string: 'patched\n' });
      await child.prompt('Patch the ordinary fixture project file.');
      expect(await readFile(path, 'utf8')).toBe('patched\n');
      expect(child.permissionRequests()).toHaveLength(0);

      // This is an inert file within the temporary project, not credentials or an operator path.
      const sensitive = join(fixture.cwd, '.env');
      await writeFile(sensitive, 'FIXTURE_MARKER=before\n');
      fixture.callToolNext('write_file', { path: sensitive, content: 'FIXTURE_MARKER=must-not-land\n' });
      await child.prompt('Edit the sensitive-named fixture file.');
      expect(child.permissionRequests()).toHaveLength(1);
      expect(child.permissionRequests()[0].params.toolCall.kind).toBe('edit');
      expect(await readFile(sensitive, 'utf8')).toBe('FIXTURE_MARKER=before\n');
      expect(fixture.toolResults()).toContain('Edit approval denied');
    } finally { await fixture.close(); }
  }, 90_000);
});
