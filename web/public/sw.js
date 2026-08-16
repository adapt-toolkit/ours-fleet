const CACHE = 'ours-fleet-shell-v1';
const OFFLINE = '/offline.html';

export function isForbiddenCacheUrl(input) {
  const localOrigin = globalThis.location?.origin ?? 'http://127.0.0.1';
  const url = new URL(input, localOrigin);
  return url.origin !== localOrigin
    || url.pathname.startsWith('/api/')
    || url.search.length > 0
    || url.hash.length > 0;
}

export function isCacheableAsset(input) {
  if (isForbiddenCacheUrl(input)) return false;
  const url = new URL(input, globalThis.location?.origin ?? 'http://127.0.0.1');
  return /^\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname);
}

if (typeof globalThis.addEventListener === 'function'
    && 'skipWaiting' in globalThis && 'clients' in globalThis) {
  self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.add(OFFLINE)).then(() => self.skipWaiting()));
  });

  self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('ours-fleet-shell-') && key !== CACHE)
        .map(key => caches.delete(key)),
    )).then(() => self.clients.claim()));
  });

  self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET' || isForbiddenCacheUrl(request.url)) return;
    if (request.mode === 'navigate') {
      const offline = async () => (await caches.match(OFFLINE)) ?? Response.error();
      event.respondWith(self.navigator.onLine === false
        ? offline()
        : fetch(request, { cache: 'no-store' }).catch(offline));
      return;
    }
    if (!isCacheableAsset(request.url)) return;
    event.respondWith(caches.match(request).then(async cached => {
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic')
        await (await caches.open(CACHE)).put(request, response.clone());
      return response;
    }));
  });
}
