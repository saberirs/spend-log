/*
 * Spenderrr – offline support (service worker)
 * Version 2026.10.27
 *
 * Network first: when online, every open gets the latest version from Netlify,
 * so Android, iPhone and desktop always run the same release.
 * When offline, it falls back to the last saved copy so the app still opens.
 * Google sign-in / Drive and other outside addresses are never touched.
 */
var CACHE = 'spendlog-2026.10.27';
var APP_FILES = [
  '/',
  '/index.html',
  '/backup.js',
  '/whatsapp.js',
  '/ledger.js',
  '/reminders.js',
  '/fonts/plus-jakarta-sans-latin-400-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-ext-400-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-500-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-ext-500-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-600-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-ext-600-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-700-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-ext-700-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-800-normal.woff2',
  '/fonts/plus-jakarta-sans-latin-ext-800-normal.woff2',
  '/manifest.webmanifest',
  '/privacy.html',
  '/xlsx.full.min.js',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Save each file on its own, so one missing file never blocks the update.
      return Promise.all(APP_FILES.map(function (url) {
        return fetch(url, { cache: 'no-store' })
          .then(function (res) { if (res.ok) return cache.put(url, res); })
          .catch(function () { /* offline or missing: skip */ });
      }));
    }).then(function () { return self.skipWaiting(); })   // take over right away
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      // Remove every older saved copy (e.g. spendlog-v4).
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // let Google, fonts etc. go straight through
  if (url.pathname.indexOf('/.netlify/') === 0) return;
  if (url.pathname.indexOf('/t/') === 0) return;           // daily check-in: always the network, never saved

  var isPage = req.mode === 'navigate';
  // Each page under its own name (so opening privacy.html never replaces the app's offline copy); ignore ?v=…
  var key = url.pathname === '/' ? '/index.html' : url.pathname;

  event.respondWith(
    fetch(req, { cache: 'no-store' }).then(function (res) {
      if (res.ok && res.type === 'basic' && !res.redirected) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(key, copy); });
      }
      return res;
    }).catch(function () {
      return caches.open(CACHE).then(function (cache) {
        return cache.match(key)
          .then(function (hit) { return hit || (isPage ? cache.match('/index.html') : null); })
          .then(function (hit) { return hit || new Response('Offline', { status: 503, statusText: 'Offline' }); });
      });
    })
  );
});
