// Sumiran Lite service worker.
//
// Why this exists: before it, the app described itself as "offline-first"
// but only its *data* was offline (IndexedDB). The app shell was never
// cached, so launching without a network depended entirely on incidental
// HTTP cache — unreliable, and on a cold PWA launch usually a failure. It
// also meant app.js's fetch of i18n/translations.json could fail on every
// launch, which is the whole reason that file has a retry-and-fallback path.
//
// Strategy: precache the critical shell on install, then serve same-origin
// GETs stale-while-revalidate — cache answers immediately (fast, and works
// with no network), while a background fetch refreshes the entry for next
// time. That means a user is at most one launch behind after a deploy and
// self-heals without any manual cache-busting, which matters because this
// project has no build step and therefore no content-hashed filenames.
//
// Bump CACHE_VERSION to force a clean re-precache (e.g. if an asset is
// renamed or removed). Routine deploys do NOT require it — stale-while-
// revalidate already picks changed files up on the next launch.
const CACHE_VERSION = "v1";
const CACHE_NAME = `sumiran-lite-${CACHE_VERSION}`;

// The true critical path for a correct first paint and first render. Other
// same-origin assets (the remaining background themes, the PNG splash
// fallback, the 512px icons) are deliberately left out and picked up by the
// runtime handler below the first time they're actually used — precaching
// everything would push ~2.8MB at install for files many users never touch.
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.json",
  "./i18n/translations.json",
  "./fonts/Inter-Variable.woff2",
  "./fonts/PlayfairDisplay-Variable.woff2",
  "./splash/hanuman-splash.webp",
  "./splash/splash-background.webp",
  "./icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // addAll() is atomic — one 404 would reject the whole install and
      // leave the app uncached. Add individually and tolerate misses so a
      // single renamed asset can't cost us offline support entirely.
      .then((cache) =>
        Promise.all(
          PRECACHE_URLS.map((url) =>
            // Deliberately NOT cache.add(): that fetches through the HTTP
            // cache, so a freshly-installing worker could precache the
            // very stale copies it exists to replace. See revalidate().
            fetch(new Request(url, { cache: "reload" }))
              .then((res) => {
                if (res && res.ok) return cache.put(url, res);
                throw new Error("HTTP " + (res && res.status));
              })
              .catch((err) => {
                console.warn("[sw] precache skipped:", url, err);
              })
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
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("sumiran-lite-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      // Take over already-open pages, so the very first visit becomes
      // offline-capable without needing a reload first.
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only GETs are cacheable, and only our own origin. Everything else —
  // most importantly the Google Identity script and every googleapis.com
  // Drive call — must go straight to the network, untouched and never
  // cached: those are authenticated, one-shot, and sometimes non-GET.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(staleWhileRevalidate(event));
});

async function staleWhileRevalidate(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // `cache: "no-cache"` forces a conditional request to the server (it still
  // gets a cheap 304 when nothing changed) instead of letting the browser's
  // own HTTP cache answer. Without this the revalidation can be served the
  // same stale bytes it is meant to replace, which silently degrades
  // stale-while-revalidate into cache-forever — a user would be pinned to
  // whatever build they first loaded, with no way out but clearing site
  // data. This project's files are unhashed and long-lived, so heuristic
  // HTTP caching bites hard here; verified against a real deploy simulation.
  const networkFetch = fetch(new Request(request.url, { cache: "no-cache" }))
    .then((response) => {
      // Only store genuinely successful, non-opaque responses — caching an
      // error page would serve that error back on every later launch.
      if (response && response.ok && response.type === "basic") {
        // RETURN the put, so this promise settles when the cache write has
        // actually landed rather than when the response headers arrived.
        // Without the return, event.waitUntil(networkFetch) below covered
        // only the fetch and not the write — so the browser was free to kill
        // the worker mid-write, the cache silently never updated, and
        // stale-while-revalidate quietly degraded into cache-forever. The
        // comment on that waitUntil claimed this protection; it did not have
        // it. Chaining .then(() => response) keeps the resolved value the
        // same for the no-cache path further down, which returns it.
        return cache.put(request, response.clone()).then(() => response);
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // The refresh must outlive this response, or the browser is free to kill
    // the worker before it lands and the cache would never actually update —
    // silently turning stale-while-revalidate into cache-forever.
    event.waitUntil(networkFetch);
    return cached;
  }

  const network = await networkFetch;
  if (network) return network;

  // Offline with nothing cached for this exact URL. For a navigation, fall
  // back to the cached shell so the app still opens (it renders from
  // IndexedDB anyway); otherwise there's nothing honest to return.
  if (request.mode === "navigate") {
    const shell = (await cache.match("./index.html")) || (await cache.match("./"));
    if (shell) return shell;
  }

  return Response.error();
}
