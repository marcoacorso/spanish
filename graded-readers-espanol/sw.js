// Service worker: guarda a app para funcionar offline. Os episódios ficam no IndexedDB, não aqui.
const CACHE = 'leitor-v1.1.1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'creator.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'leitor-fonts').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // fontes do Google: guardar na primeira visita
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    e.respondWith(caches.open('leitor-fonts').then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      try { const r = await fetch(e.request); c.put(e.request, r.clone()); return r; } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // app: rede primeiro (para receber logo as atualizações); sem rede usa a cópia guardada
  e.respondWith(caches.open(CACHE).then(async c => {
    try {
      // no metro a rede pode estar lenta: ao fim de 3 s usa a cópia guardada
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
      const r = await fetch(e.request, { cache: 'no-cache', signal: ctl.signal }).finally(() => clearTimeout(t));
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      return (await c.match(e.request, { ignoreSearch: true })) || (e.request.mode === 'navigate' ? await c.match('index.html') : null) || new Response('Offline', { status: 503 });
    }
  }));
});
