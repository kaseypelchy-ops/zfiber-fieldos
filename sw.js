/* ============================================================
   Zito FieldOS — Service Worker
   Bump CACHE_VERSION whenever you deploy a new build so all
   reps get fresh files on their next open.
   ============================================================ */

var CACHE_VERSION = 'fieldos-nextdoor-offline-v1.3.1-20260706';

/* Files that make up the app shell — cached on install so the
   app loads instantly even with no signal. */
var APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

/* ── INSTALL: cache the app shell ── */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache) {
      return cache.addAll(APP_SHELL);
    }).then(function() {
      return self.skipWaiting(); // activate immediately, don't wait for old tab to close
    })
  );
});

/* ── ACTIVATE: delete old caches ── */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_VERSION; })
            .map(function(k)    { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim(); // take control of all open tabs immediately
    })
  );
});

/* ── FETCH: serve from cache when possible ── */
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Never intercept POST requests (webhook calls to Google Sheets)
  if (e.request.method !== 'GET') return;

  // Never intercept Google Sheets / Apps Script calls
  if (url.includes('script.google.com') || url.includes('docs.google.com')) return;

  // Never intercept Nominatim (reverse geocode must always be fresh)
  if (url.includes('nominatim.openstreetmap.org')) return;

  // ── index.html: network-first ─────────────────────────────
  // Always try the network first so reps get fresh HTML after a deploy.
  // Cache-first here means reps who never close the app tab can be stuck on
  // stale markup for days even after a CACHE_VERSION bump activates.
  var isIndex = url.endsWith('/') || url.endsWith('/index.html') || url.endsWith('index.html');
  if (isIndex) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_VERSION).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        // Offline — fall back to cached copy so the app still opens
        return caches.match(e.request);
      })
    );
    return;
  }

  // ── Map tiles: cache-first with network fallback ──────────
  // Tiles are large in number but small individually. Cache them
  // so zooming around a visited area works offline.
  var isTile = url.includes('arcgisonline.com') ||
             url.includes('services.arcgisonline.com') ||
             url.includes('tile.openstreetmap.org') ||
             url.includes('rainviewer.com');

  if (isTile) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        return fetch(e.request).then(function(response) {
          // Only cache successful tile responses
          if (!response || response.status !== 200) return response;
          var clone = response.clone();
          caches.open(CACHE_VERSION).then(function(cache) {
            cache.put(e.request, clone);
          });
          return response;
        }).catch(function() {
          // Offline and not cached — return nothing (tile stays blank)
          return new Response('', { status: 503 });
        });
      })
    );
    return;
  }

  // ── App shell: cache-first ────────────────────────────────
  // App files (index.html, app.js, style.css, CDN libs) are
  // served from cache. They only change when CACHE_VERSION bumps.
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      // Not in cache yet — fetch it, cache it, return it
      return fetch(e.request).then(function(response) {
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        var clone = response.clone();
        caches.open(CACHE_VERSION).then(function(cache) {
          cache.put(e.request, clone);
        });
        return response;
      });
    })
  );
});
