/*
 * Spenderrr – offline support (service worker)
 * Version 2026.11.1
 *
 * Saved copy first: the app opens instantly from the copy saved on the device,
 * and the latest version is fetched from Netlify in the background for next time.
 * A new release also changes this file, so the browser installs the new copy
 * right away (see install below); every device is on the new release by the next open.
 * When offline, the saved copy is all it needs.
 * Google sign-in / Drive and other outside addresses are never touched.
 */
var CACHE = 'spendlog-2026.11.1';
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
    caches.open(CACHE).then(function (cache) {
      // Fetch the latest copy in the background and save it for the next open.
      var fresh = fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res.ok && res.type === 'basic' && !res.redirected) cache.put(key, res.clone());
        return res;
      });
      return cache.match(key).then(function (hit) {
        if (hit) {
          event.waitUntil(fresh.catch(function () { /* offline: keep the saved copy */ }));
          return hit;                                      // open instantly from the saved copy
        }
        // Not saved yet (first visit): wait for the network, fall back to the app page when offline.
        return fresh.catch(function () {
          return (isPage ? cache.match('/index.html') : Promise.resolve(null))
            .then(function (h) { return h || new Response('Offline', { status: 503, statusText: 'Offline' }); });
        });
      });
    })
  );
});
