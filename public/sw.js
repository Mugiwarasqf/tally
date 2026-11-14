/*
 * Tally service worker.
 *
 *  1. Offline shell: the app works with no connection after the first visit.
 *  2. Notifications: shows alerts and opens the right page when one is tapped.
 *  3. Background checks (installed Chrome/Edge only): on a periodic wake-up, shows alerts
 *     that Tally scheduled earlier, reading them straight from IndexedDB. No server involved.
 */
const VERSION = 'tally-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './favicon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch third-party requests

  // Page loads: newest version when online, cached shell when not.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  // Everything else (hashed JS/CSS/fonts/icons): cache first, fill the cache on a miss.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

// ---- notifications ---------------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = (event.notification.data && event.notification.data.route) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows[0];
      if (open) {
        open.postMessage({ type: 'navigate', route });
        return open.focus();
      }
      return self.clients.openWindow(`./#${route}`);
    }),
  );
});

// ---- background checks -------------------------------------------------------------------
function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name); // no version: open whatever exists
    req.onupgradeneeded = () => req.transaction.abort(); // never create an empty database from here
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function showDueAlerts() {
  const db = await openDb('tally');
  try {
    const read = db.transaction(['alerts', 'kv'], 'readonly');
    const settings = await request(read.objectStore('kv').get('settings'));
    if (!settings || !settings.value || !settings.value.notifications || !settings.value.notifications.enabled) return;
    const all = await request(read.objectStore('alerts').getAll());
    const now = Date.now();
    const due = all.filter((a) => a.at <= now && !a.shown && !a.read).sort((a, b) => b.at - a.at).slice(0, 5);
    for (const a of due) {
      await self.registration.showNotification(a.title, { body: a.body, tag: a.id, icon: './icon-192.png', badge: './icon-192.png', data: { route: a.route } });
      const write = db.transaction('alerts', 'readwrite');
      write.objectStore('alerts').put({ ...a, shown: true });
    }
  } finally {
    db.close();
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'tally-alerts') event.waitUntil(showDueAlerts().catch(() => {}));
});
