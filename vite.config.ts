import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'web',
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web-app'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: { host: '127.0.0.1', port: 5173 },
});
