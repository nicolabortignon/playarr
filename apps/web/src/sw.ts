/// <reference lib="webworker" />
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { API_CACHE, ART_CACHE, AUDIO_CACHE } from './lib/cacheNames';
import { rangeResponse } from './lib/rangeResponse';

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | PrecacheEntry)[] };

// Auto-update: a new version takes over open tabs straight away.
void self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/stream\//, /^\/art\//] }));

registerRoute(
  ({ url }) => url.pathname.startsWith('/art/'),
  new CacheFirst({
    cacheName: ART_CACHE,
    plugins: [new CacheableResponsePlugin({ statuses: [200] }), new ExpirationPlugin({ maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 60 })],
  }),
);

registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({ cacheName: API_CACHE, networkTimeoutSeconds: 4, plugins: [new ExpirationPlugin({ maxEntries: 200 })] }),
);

/**
 * Audio: songs the page has kept on this device play from disk, answering the byte ranges <audio>
 * asks for (seeking included). Everything else streams from the server untouched; the service worker
 * never stores audio itself, so the page stays in charge of what's kept and how much.
 */
registerRoute(
  ({ url }) => url.pathname.startsWith('/stream/'),
  async ({ request }) => {
    const kept = await caches.match(request.url, { cacheName: AUDIO_CACHE });
    return kept ? rangeResponse(request, kept) : fetch(request);
  },
);

