import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('installable PWA cache boundary', () => {
  it('declares a scoped standalone localhost application with brand icons', () => {
    const manifest = JSON.parse(readFileSync(resolve('web/public/manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({
      id: '/', start_url: '/', scope: '/', display: 'standalone',
      theme_color: '#111318', background_color: '#111318',
    });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    ]));
  });

  it('allows only content-hashed static assets and rejects every sensitive URL class', async () => {
    // Public service-worker source is an ES module so the exact production
    // policy—not a test duplicate—can be exercised in Node.
    // @ts-expect-error public JavaScript intentionally has no declaration file
    const { isCacheableAsset, isForbiddenCacheUrl } = await import('../../web/public/sw.js');
    expect(isCacheableAsset('/assets/index-B_X8ClvF.js')).toBe(true);
    expect(isCacheableAsset('/assets/index-CCtmtf83.css')).toBe(true);
    for (const path of [
      '/api/v1/auth/session', '/api/v1/auth/exchange', '/api/v1/auth/resume',
      '/api/v1/roles', '/api/v1/audit', '/api/v1/events',
      '/assets/index-HASH.js?bootstrap=secret', '/?device=secret', '/#bootstrap=secret',
      '/sw.js', '/manifest.webmanifest', '/offline.html',
    ]) expect(isCacheableAsset(path), path).toBe(false);
    expect(isForbiddenCacheUrl('https://evil.invalid/assets/index-HASH.js')).toBe(true);
  });

  it('uses network-first navigation, does not cache errors, and has a data-free offline shell', () => {
    const source = readFileSync(resolve('web/public/sw.js'), 'utf8');
    expect(source).toContain("request.mode === 'navigate'");
    expect(source).toContain("fetch(request, { cache: 'no-store' }).catch");
    expect(source).toContain('response.ok');
    const offline = readFileSync(resolve('web/public/offline.html'), 'utf8');
    expect(offline).toContain('Local daemon unavailable');
    expect(offline).toContain('No fleet data is available offline');
  });
});
