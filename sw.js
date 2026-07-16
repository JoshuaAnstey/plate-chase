/* Plate Chase service worker — keeps images and libraries cached so the app
   opens instantly and plates don't re-download on every launch. */
const SHELL = "pc-shell-v1";   // the app itself (network-first so deploys arrive)
const IMGS  = "pc-img-v1";     // plate images from Wikimedia (cache-first, effectively immutable)
const LIBS  = "pc-lib-v1";     // CDN libraries: supabase-js, leaflet, qrcode (cache-first)
const TILES = "pc-tile-v1";    // map tiles (cache-first, capped)
const TILE_CAP = 600;

self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keep = [SHELL, IMGS, LIBS, TILES];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await clients.claim();
  })());
});

async function cacheFirst(cacheName, request, cap) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const resp = await fetch(request);
  if (resp && (resp.ok || resp.type === "opaque")) {
    cache.put(request, resp.clone()).then(async () => {
      if (cap) {
        const keys = await cache.keys();
        if (keys.length > cap) for (const k of keys.slice(0, keys.length - cap)) await cache.delete(k);
      }
    }).catch(() => {});
  }
  return resp;
}

async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put(request, resp.clone()).catch(() => {});
    return resp;
  } catch (e) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // Never intercept the database/auth/realtime — always live.
  if (url.hostname.endsWith("supabase.co")) return;

  // The app itself: freshest when online, cached when offline (offline startup!).
  if (url.origin === location.origin) {
    e.respondWith(networkFirst(SHELL, e.request));
    return;
  }
  // Plate images (Special:FilePath redirects + upload.wikimedia.org): load once, keep forever.
  if (url.hostname.endsWith("wikimedia.org")) {
    e.respondWith(cacheFirst(IMGS, e.request));
    return;
  }
  // CDN libraries: pinned versions, safe to cache hard.
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(cacheFirst(LIBS, e.request));
    return;
  }
  // Map tiles: cache with a cap so storage stays sane.
  if (url.hostname.endsWith("cartocdn.com") || url.hostname.endsWith("openstreetmap.org")) {
    e.respondWith(cacheFirst(TILES, e.request, TILE_CAP));
    return;
  }
  // Everything else passes through untouched.
});
