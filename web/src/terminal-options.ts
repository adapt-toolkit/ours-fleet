import type { ITerminalOptions } from '@xterm/xterm';

export const TERMINAL_OPTIONS = {
  convertEol: true,
  cursorBlink: true,
  cursorStyle: 'block',
  scrollback: 5_000,
  fontSize: 13,
  lineHeight: 1.15,
  fontWeight: '400',
  fontWeightBold: '700',
  fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "Noto Sans Mono", "DejaVu Sans Mono", monospace',
  theme: {
    background: '#050707', foreground: '#d8e2dc', cursor: '#b7f7d2', cursorAccent: '#050707',
    selectionBackground: '#315d4f99',
    black: '#101513', red: '#ff6b6b', green: '#7bd88f', yellow: '#f2c96d', blue: '#6ea8fe',
    magenta: '#c792ea', cyan: '#65d1d4', white: '#d8e2dc', brightBlack: '#65736d',
    brightRed: '#ff8b8b', brightGreen: '#9beaab', brightYellow: '#ffe08a', brightBlue: '#8fc0ff',
    brightMagenta: '#dda7f2', brightCyan: '#8ae6e8', brightWhite: '#f4faf7',
  },
} satisfies ITerminalOptions;
