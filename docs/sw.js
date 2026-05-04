/* Service worker for the Oahu League schedule PWA.
 *
 * Strategy:
 *   - Static shell (HTML/CSS/JS/manifest/icons): cache-first, with background
 *     update on each install. Pages load instantly when offline.
 *   - API (teams.json, preview.json, calendar.ics from the Worker):
 *     network-first with a 3-second timeout, fallback to cache. Parents
 *     opening the app at a field with bad WiFi still see the last-known
 *     team list and recent preview.
 *
 * Bump CACHE_VERSION whenever you ship breaking changes to the static shell.
 */

const CACHE_VERSION = "v1";
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const API_CACHE = `api-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        // Use addAll where possible; fall back to per-asset add so a single
        // missing icon doesn't break installation.
        Promise.all(
          STATIC_ASSETS.map((url) =>
            cache.add(new Request(url, { cache: "reload" })).catch(() => {})
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== API_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  return url.origin === self.location.origin;
}

function isApi(url) {
  // The Worker URL is configured in config.js; we treat any cross-origin
  // .json or .ics fetch as an API call worth caching.
  return (
    url.origin !== self.location.origin &&
    (url.pathname.endsWith(".json") || url.pathname.endsWith(".ics"))
  );
}

async function networkFirst(request, cacheName, timeoutMs = 3000) {
  const cache = await caches.open(cacheName);
  try {
    const network = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs)
      ),
    ]);
    if (network && network.ok) {
      cache.put(request, network.clone()).catch(() => {});
    }
    return network;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request)
      .then((resp) => {
        if (resp && resp.ok) cache.put(request, resp.clone());
      })
      .catch(() => {});
    return cached;
  }
  const network = await fetch(request);
  if (network && network.ok) cache.put(request, network.clone()).catch(() => {});
  return network;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (isApi(url)) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }
});
