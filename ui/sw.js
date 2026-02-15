// FlightsAboveMe — Service Worker (static assets only)
// Cache-first for same-origin CSS/JS/images/fonts to improve repeat load speed.
// Intentionally does NOT cache HTML documents or API responses.

const CACHE_NAME = "fab-static-v1.5.2-1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const warm = [
      "./app.js",
      "./style.css",
      "./kiosk.css",
      "./flightsaboveme-logo-tight.png",
      "./flightsaboveme-logo.png",
      "./header-logo.png",
      "./logo.png"
    ];
    await Promise.allSettled(warm.map((u) => cache.add(u)));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k.startsWith("fab-static-") && k !== CACHE_NAME) ? caches.delete(k) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Same-origin only
  if (url.origin !== self.location.origin) return;

  // Never cache HTML documents or API routes
  const dest = req.destination || "";
  if (dest === "document") return;
  if (url.pathname.startsWith("/opensky/") || url.pathname.startsWith("/aircraft/") || url.pathname.startsWith("/adsb/") || url.pathname.startsWith("/api/")) return;

  const shouldCache =
    ["style", "script", "image", "font"].includes(dest) ||
    url.pathname.endsWith(".css") || url.pathname.endsWith(".js") ||
    /\.(png|jpg|jpeg|webp|svg|gif|woff2?|ttf|otf)$/i.test(url.pathname);

  if (!shouldCache) return;

  // Normalize cache key (strip querystring like ?v=123)
  const cacheKey = url.origin + url.pathname;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const res = await fetch(req);
    if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
      await cache.put(cacheKey, res.clone());
    }
    return res;
  })());
});
