import { describe, expect, it, vi } from 'vitest';
import { agentDir } from '../../src/paths.js';
import { makeFleetBackend } from '../../src/supervisor/fleet.js';
import { StructuredLogService } from '../../src/application/log-service.js';
import { join } from 'node:path';

describe('per-member structured logs under the shared parent', () => {
  it.each(['linux', 'darwin'] as const)('reads only the requested member file on %s and preserves redaction/limit', async platform => {
    const query = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe('tail');
      expect(args).toEqual(['-n', '2', join(agentDir('PersonalAssistant'), 'supervisor.log')]);
      return { code: 0, stdout: 'older\nPersonalAssistant own output\ntoken=fixture-private-value\n', stderr: '' };
    });
    const logs = new StructuredLogService(makeFleetBackend(query, platform), query);
    const page = await logs.source('PersonalAssistant').tail(2);
    expect(page.records.map(record => record.text)).toEqual(['PersonalAssistant own output', 'token=[REDACTED]']);
    expect(page.records[1].redactionApplied).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(page)).not.toContain('fixture-private-value');
  });
});
