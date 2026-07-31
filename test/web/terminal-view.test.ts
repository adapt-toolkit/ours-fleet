import { describe, expect, it } from 'vitest';
import { TERMINAL_OPTIONS } from '../../web/src/terminal-options.js';

describe('browser terminal fidelity', () => {
  it('uses the installed Nerd Font first and defines a complete high-contrast ANSI theme', () => {
    expect(TERMINAL_OPTIONS.fontFamily).toMatch(/^"JetBrainsMono Nerd Font"/);
    expect(TERMINAL_OPTIONS.fontFamily).toContain('monospace');
    expect(TERMINAL_OPTIONS.fontWeight).toBe('400');
    expect(TERMINAL_OPTIONS.fontWeightBold).toBe('700');
    expect(TERMINAL_OPTIONS.cursorStyle).toBe('block');
    expect(Object.keys(TERMINAL_OPTIONS.theme)).toEqual(expect.arrayContaining([
      'background', 'foreground', 'cursor', 'black', 'red', 'green', 'yellow', 'blue',
      'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen',
      'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ]));
  });
});
