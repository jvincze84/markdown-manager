// Markdown Manager – service worker (PWA).
// A verziót a szerver illeszti be (a VERSION helyőrzője → a kliens fájlok hash-e), így minden új build új gyorsítótárat kap,
// a régi az aktiváláskor törlődik.
// Stratégia:
//  - /api/*, /assets/* (repó tartalom, feltöltések): nem nyúlunk hozzá, mindig hálózat (friss adat, nincs offline másolat);
//  - oldal-navigáció: hálózat, ha nem elérhető → offline oldal;
//  - statikus fájlok (app, css, vendor, ikonok): cache-first a verziózott gyorsítótárból (az app héja gyorsan betölt).
const VERSION = '__VERSION__';
const CACHE = `mm-shell-${VERSION}`;
const OFFLINE = '/offline.html';
const PRECACHE = [
  OFFLINE, '/style.css', '/code-theme.css', '/app.js', '/mdtable.js', '/manifest.webmanifest',
  '/vendor-built/toastui-editor-all.min.js',
  '/vendor/github-markdown-css/github-markdown-light.css', '/vendor/github-markdown-css/github-markdown-dark.css',
  '/vendor/toastui/toastui-editor.css', '/vendor/toastui/theme/toastui-editor-dark.css',
  '/vendor/code-syntax-highlight/toastui-editor-plugin-code-syntax-highlight.css',
  '/vendor/diff2html/css/diff2html.min.css',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // egyenként: egy hiányzó fájl ne buktassa el a telepítést
    await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('mm-shell-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|assets)\//.test(url.pathname) || url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE)) || Response.error()));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: false });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  })());
});
