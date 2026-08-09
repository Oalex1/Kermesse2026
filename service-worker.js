// ⚠️ IMPORTANTE: cada vez que subas cambios nuevos a Vercel/Netlify,
// sube también este archivo con el número de versión aumentado en 1.
// Eso es lo único que hace que los celulares de la gente bajen la
// versión nueva de la app en vez de quedarse con una vieja guardada.
const CACHE_VERSION = "v9";
const CACHE_NAME = `kermesse-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/app.js",
  "./js/config.js",
  "./js/supabaseClient.js",
  "./js/offlineQueue.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// No tocar las llamadas reales a Supabase (datos): esas siempre van directo a la red.
function isSupabaseCall(url) {
  return url.hostname.endsWith(".supabase.co");
}

// Para todo lo demás (el "cascarón" de la app, tipografías, la librería de Supabase):
// intenta la red primero (para que siempre haya lo último si hay internet),
// y si no hay internet, usa lo que haya en caché.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (isSupabaseCall(url)) return; // deja pasar Supabase sin tocarlo

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
