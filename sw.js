// service-worker.js (korije pou evite kraze video streaming)
const CACHE_NAME = 'tfstream-shell-v1';
const IMAGE_CACHE = 'tfstream-thumbs-v1';
const JSON_CACHE = 'tfstream-json-v1';
const VIDEO_CACHE = 'tfstream-videos-v1'; // nou kenbe non si vle men pa kache videyo
const OFFLINE_URL = '/offline.html';
const PLACEHOLDER = '/images/placeholder-thumb.png';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  OFFLINE_URL,
  '/styles.css',
  '/main.js',
  PLACEHOLDER
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Precache core small assets; si yon fetch echwe, nou pa fè enstalasyon echwe
    await Promise.allSettled(
      PRECACHE_URLS.map(u =>
        fetch(u, { cache: 'no-cache' }).then(res => {
          if (!res || (res.status !== 200 && res.type !== 'opaque')) throw new Error(`${u} -> ${res && res.status}`);
          return cache.put(new Request(u, { credentials: 'same-origin' }), res.clone());
        }).catch(err => {
          console.warn('Precache failed for', u, err);
        })
      )
    );

    // pa pre-cache videyo! -> si index.json egziste, nou cache sèlman thumb + json, men pa media
    try {
      const resp = await fetch('/index.json', { cache: 'no-cache' });
      if (resp && (resp.ok || resp.type === 'opaque')) {
        const index = await resp.json();
        const imageCache = await caches.open(IMAGE_CACHE);
        const jsonCache = await caches.open(JSON_CACHE);
        const urls = new Set();

        if (Array.isArray(index)) {
          index.forEach(it => {
            if (it['Url Thumb']) urls.add(normalizeUrl(it['Url Thumb']));
            if (it.json) urls.add(normalizeUrl(it.json));
            // pa ajoute it.video oswa mp4
          });
        } else {
          Object.values(index).forEach(v => {
            if (typeof v === 'string' && (v.endsWith('.json') || /\.(jpg|jpeg|png|webp)$/.test(v))) urls.add(normalizeUrl(v));
          });
        }

        await Promise.allSettled(Array.from(urls).map(u => {
          if (u.endsWith('.json')) {
            return fetch(u, { cache: 'no-cache' }).then(r => {
              if (r && (r.status === 200 || r.type === 'opaque')) return jsonCache.put(u, r.clone());
            }).catch(()=>{});
          }
          if (/\.(jpg|jpeg|png|webp)$/.test(u)) {
            return fetch(u, { cache: 'no-cache' }).then(r => {
              if (r && (r.status === 200 || r.type === 'opaque')) return imageCache.put(u, r.clone());
            }).catch(()=>{});
          }
          return Promise.resolve();
        }));
      }
    } catch (e) {
      console.warn('Failed to fetch index.json during install', e);
    }

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', evt => {
  evt.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (![CACHE_NAME, IMAGE_CACHE, JSON_CACHE, VIDEO_CACHE].includes(k)) {
        return caches.delete(k);
      }
      return Promise.resolve();
    }));
    await self.clients.claim();
  })());
});

// normalize pou itilize href (evite mismatch)
function normalizeUrl(u) {
  try {
    const url = new URL(u, self.location.origin);
    return url.href;
  } catch(e) {
    return u;
  }
}

// Decide si nou dwe BYPASS Service Worker (pa entèsepte)
/* 
  - tout demann ki gen Range header
  - destination video/audio
  - url ki fini ak ekstansyon medya (mp4, webm, m3u8, mpd, mov, mkv)
  - non-GET requests
*/
function shouldBypass(request) {
  try {
    if (request.method !== 'GET') return true;
    if (request.headers && request.headers.get && request.headers.get('range')) return true;
    const dest = request.destination || '';
    if (dest === 'video' || dest === 'audio') return true;
    const url = request.url || '';
    if (/\.(mp4|webm|m3u8|mpd|mov|mkv)(\?.*)?$/i.test(url)) return true;
    // optionally bypass known media CDN hosts:
    // if (url.includes('r2.dev') || url.includes('your-media-cdn.com')) return true;
    return false;
  } catch(e) {
    return true;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (shouldBypass(req)) {
    // Bypass service worker for media-range/streaming requests
    event.respondWith(fetch(req));
    return;
  }

  // navigation (HTML): network-first fallback to offline page
  if (req.mode === 'navigate' || (req.headers.get('accept')||'').includes('text/html')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // images: cache-first, fallback to placeholder
  if (req.destination === 'image' || /\.(png|jpg|jpeg|webp|gif)$/.test(req.url)) {
    event.respondWith(cacheFirstWithFallback(req, IMAGE_CACHE, PLACEHOLDER));
    return;
  }

  // json: network-first with cache fallback
  if (req.url.endsWith('.json')) {
    event.respondWith(networkFirst(req, JSON_CACHE));
    return;
  }

  // other static assets (css/js): cache-first then network
  event.respondWith(cacheFirst(req));
});

// --- Strategies (pa cache videyo) ---
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    // cache only safe responses: status 200 and non-opaque for app shell assets
    if (resp && resp.status === 200 && resp.type !== 'opaque') {
      cache.put(request, resp.clone()).catch(()=>{});
    }
    return resp;
  } catch (e) {
    // fall back to cached asset or offline page for navigations
    const fallback = await caches.match(request) || await caches.match(OFFLINE_URL);
    return fallback;
  }
}

async function networkFirst(request, cacheName = CACHE_NAME) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type !== 'opaque') {
      cache.put(request, response.clone()).catch(()=>{});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request) || await caches.match(OFFLINE_URL);
    return cached;
  }
}

async function cacheFirstWithFallback(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && (resp.status === 200 || resp.type === 'opaque')) {
      await cache.put(request, resp.clone());
      return resp;
    }
  } catch (e) {
    // ignored
  }
  // fallback placeholder from global cache; if not found return Response.error()
  const ph = await caches.match(fallbackUrl);
  return ph || Response.error();
}
