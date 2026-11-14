/* Hindi News service worker — app-shell cache, versioned.
   Network-first for index + videos.json (freshness matters), cache-first for
   versioned assets and icons. Only same-origin requests are handled; YouTube
   embeds and API calls pass through untouched. Old caches are deleted on
   activate, so a new deploy never serves a stale shell. */
var CACHE = 'hindi-news-v6';
var SHELL = [
  './',
  'index.html',
  'styles.css?v=6',
  'app.js?v=6',
  'videos.json?v=6',
  'manifest.json',
  'icon.svg',
  'icon-maskable.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  var fresh = url.pathname.endsWith('videos.json') ||
              url.pathname.endsWith('/') ||
              url.pathname.endsWith('index.html');
  if (fresh) {
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () { return caches.match(e.request); })
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          return res;
        });
      })
    );
  }
});
