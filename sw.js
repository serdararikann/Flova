/* ====================================================================
   FLOVA AUDIO STUDIO - SERVICE WORKER (PWA)
   - Cache-first & Stale-While-Revalidate caching for instant offline boot
   - Bypass for /api/* backend dynamic routes (YouTube, Demucs AI, Streaming)
   - Clean cache lifecycle management
   ==================================================================== */

const CACHE_NAME = 'flova-studio-v2.0';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './logo.png',
  './css/style.css?v=12.0',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './js/app.js?v=12.0',
  './js/audio/audio-engine.js',
  './js/audio/audio-processor.js',
  './js/audio/audio-encoders.js',
  './js/audio/bpm-key-detector.js',
  './js/audio/vocal-splitter.js',
  './js/audio/api-client.js?v=9.1',
  './js/ui/waveform-canvas.js',
  './js/ui/visualizer-canvas.js',
  './js/ui/merger-ui.js?v=9.6',
  './js/ui/vocal-splitter-ui.js?v=9.6',
  './js/ui/stem-splitter-ui.js?v=9.6',
  './js/ui/youtube-ui.js?v=9.6',
  './js/ui/export-modal.js?v=9.6',
  './js/ui/hotkeys-modal.js?v=9.6',
  './js/ui/smart-tools-modal.js',
  './js/ui/lyrics-modal.js?v=9.1',
  './js/ui/audiogram-modal.js',
  './js/ui/server-modal.js?v=9.1',
  './js/security/code-guard.js?v=9.1',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
];

// Install: Pre-cache static assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use map with catch so individual CDN failures don't abort entire SW installation
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[PWA SW] Precache warning for ${url}:`, err);
          })
        )
      );
    })
  );
});

// Activate: Purge older version caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Strategy dispatcher
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Never cache non-GET requests or backend dynamic API endpoints
  if (req.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/temp_')) {
    event.respondWith(fetch(req));
    return;
  }

  // 2. Google Fonts & CDNs: Cache First with Network Fallback
  if (url.origin.includes('fonts.googleapis.com') ||
      url.origin.includes('fonts.gstatic.com') ||
      url.origin.includes('cdn.jsdelivr.net')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // 3. App Shell & Static Assets: Network-First with Cache Fallback for instant updates
  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
