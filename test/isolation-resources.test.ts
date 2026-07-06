import { describe, it, expect } from 'vitest';
import { resourceArgs } from '../src/isolation/resources.js';

describe('resourceArgs', () => {
  it('returns no prefix when no resources are set', () => {
    expect(resourceArgs({}, true).argv).toEqual([]);
  });

  it('maps mem to a systemd-run --user --scope MemoryMax scope', () => {
    const { argv } = resourceArgs({ mem: '2G' }, true);
    expect(argv.slice(0, 3)).toEqual(['systemd-run', '--user', '--scope']);
    expect(argv).toContain('MemoryMax=2G');
    expect(argv[argv.length - 1]).toBe('--');
  });

  it('pins MemorySwapMax=0 with MemoryMax so the cap is a hard OOM bound (swap cannot escape it)', () => {
    // On hosts with swap, MemoryMax alone only pushes overflow to swap; a rogue
    // agent could exhaust host swap. MemorySwapMax=0 makes the mem cap enforce.
    const { argv } = resourceArgs({ mem: '256M' }, true);
    expect(argv).toContain('MemoryMax=256M');
    expect(argv).toContain('MemorySwapMax=0');
  });

  it('maps pids to TasksMax', () => {
    const { argv } = resourceArgs({ pids: 512 }, true);
    expect(argv).toContain('TasksMax=512');
  });

  it('maps cpu cores to CPUQuota percent when the controller is delegated', () => {
    expect(resourceArgs({ cpu: '1.5' }, true).argv).toContain('CPUQuota=150%');
    expect(resourceArgs({ cpu: '0.5' }, true).argv).toContain('CPUQuota=50%');
    expect(resourceArgs({ cpu: '2' }, true).argv).toContain('CPUQuota=200%');
  });

  it('composes mem + cpu + pids together', () => {
    const { argv } = resourceArgs({ mem: '1G', cpu: '1', pids: 256 }, true);
    expect(argv).toContain('MemoryMax=1G');
    expect(argv).toContain('CPUQuota=100%');
    expect(argv).toContain('TasksMax=256');
  });

  it('degrades cpu to a warning when the controller is not delegated (mem/pids still enforced)', () => {
    const { argv, warnings } = resourceArgs({ mem: '1G', cpu: '1', pids: 256 }, false);
    expect(argv).toContain('MemoryMax=1G');
    expect(argv).toContain('TasksMax=256');
    expect(argv.some(a => a.startsWith('CPUQuota'))).toBe(false);
    expect(warnings.join(' ')).toMatch(/cpu|CPUQuota|delegat/i);
  });

  it('no cpu warning when cpu is not requested even if undelegated', () => {
    expect(resourceArgs({ mem: '1G' }, false).warnings).toEqual([]);
  });
});
