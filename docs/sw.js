/* Service worker for ohanaclubs.
 *
 * Strategy:
 *   - Static shell: cache-first with background update.
 *   - API responses (cross-origin .json/.ics): network-first with 3s timeout
 *     and cached fallback so the app still loads at fields with bad WiFi.
 *
 * Bump CACHE_VERSION whenever the static shell changes.
 */

const CACHE_VERSION = "v15";
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const API_CACHE = `api-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/landing.css",
  "/assets/theme.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/schedule/",
  "/schedule/index.html",
  "/schedule/style.css",
  "/schedule/app.js",
  "/schedule/config.js",
  "/map/",
  "/map/index.html",
  "/map/style.css",
  "/map/app.js",
  "/map/waipio.svg",
  "/contact/",
  "/contact/index.html",
  "/contact/style.css",
  "/contact/app.js",
  "/contact/config.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
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

function isStaticAsset(url) { return url.origin === self.location.origin; }
function isApi(url) {
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
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (network && network.ok) cache.put(request, network.clone()).catch(() => {});
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
    fetch(request).then((resp) => {
      if (resp && resp.ok) cache.put(request, resp.clone());
    }).catch(() => {});
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
  if (isApi(url)) { event.respondWith(networkFirst(req, API_CACHE)); return; }
  if (isStaticAsset(url)) { event.respondWith(cacheFirst(req, STATIC_CACHE)); return; }
});
