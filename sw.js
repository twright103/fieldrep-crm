// sw.js — service worker: caches the app shell so FieldRep opens instantly
// (and offline). Data is NOT cached here — it lives in IndexedDB; API calls
// go straight to the network.
//
// To ship an update: bump CACHE_VERSION. Old caches are cleaned on activate.

const CACHE_VERSION = 'fieldrep-v8';

const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/leaflet.markercluster.js',
  './vendor/MarkerCluster.css',
  './vendor/MarkerCluster.Default.css',
  './js/app.js',
  './js/api.js',
  './js/db.js',
  './js/sync.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only handle our own shell files; API calls (other origins) pass through.
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request))
  );
});
