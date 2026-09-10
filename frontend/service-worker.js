importScripts('./js/version-classic.js');
const CACHE_VERSION = `libriq-v${self.LIBRIQ_APP_VERSION}`;
const CACHE_NAME = `${CACHE_VERSION}-shell-v2`;
const IS_LOCAL_DEV = ['localhost', '127.0.0.1', '::1'].includes(self.location.hostname);

const SHELL_ASSETS = [
  './index.html',
  './manifest.json',
  './assets/icons/icon.svg',
  './assets/icons/favicon-16x16.png',
  './assets/icons/favicon-32x32.png',
  './assets/icons/favicon-48x48.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-icon-512.png',
  './css/tokens.css',
  './css/reset.css',
  './css/base.css',
  './css/components/button.css',
  './css/components/card.css',
  './css/components/toast.css',
  './css/components/form.css',
  './css/components/polish.css',
  './css/components/utilities.css',
  './css/components/dialog.css',
  './css/features/settings.css',
  './css/features/library.css',
  './css/features/insights.css',
  './css/features/session.css',
  './css/features/dashboard.css',
  './css/sidebar.css',
  './css/animations.css',
  './js/version-classic.js',
  './js/version.js',
  './js/config.js',
  './js/appModules.js',
  './js/data.js',
  './js/storage.js',
  './js/utils.js',
  './js/search.js',
  './js/library.js',
  './js/dashboard.js',
  './js/navigation.js',
  './js/app.js',
  './js/firebase-client.js',
  './js/cloudBackup.js',
  './js/accountDisplayName.js',
  './js/installPrompt.js',
  './js/sync.js',
  './js/app/router.js',
  './js/components/ui/dialog.js',
  './js/features/activity/activityPage.js',
  './js/features/bookDetails/bookDetailsPage.js',
  './js/features/dashboard/dashboardPage.js',
  './js/features/goals/goalsPage.js',
  './js/features/help/helpPage.js',
  './js/features/kindleImport/kindleImportPage.js',
  './js/features/library/libraryPage.js',
  './js/features/library/libraryShelvesPage.js',
  './js/features/profile/profilePage.js',
  './js/features/quotes/quotesPage.js',
  './js/features/recommendations/recommendationsPage.js',
  './js/features/settings/settingsPage.js',
  './js/features/statistics/statisticsCalculations.js',
  './js/features/statistics/statisticsPage.js',
  './js/services/backupSerialization.js',
  './js/services/importExportService.js',
  './js/services/importMerge.js',
  './js/services/kindleClippingsParser.js',
  './js/services/kindleImportService.js',
  './js/services/kindleQuoteImport.js',
  './js/api/bookIdentity.js',
  './js/api/cache.js',
  './js/api/googleBooks.js',
  './js/api/gutendex.js',
  './js/api/index.js',
  './js/api/internetArchive.js',
  './js/api/mergeBooks.js',
  './js/api/normalizeBook.js',
  './js/api/openLibrary.js',
  './js/shared/fetchClient.js',
  './vendor/firebase-app.js',
  './vendor/firebase-auth.js',
  './vendor/firebase-firestore.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (IS_LOCAL_DEV) {
      self.skipWaiting();
      return;
    }
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_ASSETS.map(scopeUrl));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (IS_LOCAL_DEV) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      return;
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => {
      if (key.startsWith('libriq-') && key !== CACHE_NAME) {
        return caches.delete(key);
      }
      return Promise.resolve(false);
    }));
    await clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (isApiRequest(url)) {
      event.respondWith(fetch(request));
    }
    return;
  }

  if (IS_LOCAL_DEV) {
    event.respondWith(fetch(request));
    return;
  }

  if (isNavigationRequest(request)) {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  if (isAppShellAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});

async function handleNavigationRequest(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(scopeUrl('./index.html'));
    if (cached) return cached;
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    fetchAndCache(request, cache);
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return cached || Response.error();
  }
}

async function fetchAndCache(request, cache) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
  } catch {
    // Ignore network failures; cached response is already being served.
  }
}

function isNavigationRequest(request) {
  const accept = request.headers.get('accept') || '';
  return request.mode === 'navigate'
    || request.destination === 'document'
    || accept.includes('text/html');
}

function isAppShellAsset(url) {
  const pathname = url.pathname;
  return pathname.endsWith('.css')
    || pathname.endsWith('.js')
    || pathname.endsWith('.png')
    || pathname.endsWith('.svg')
    || pathname.endsWith('.webmanifest')
    || pathname.endsWith('.json');
}

function isApiRequest(url) {
  return url.hostname === 'openlibrary.org' || url.hostname === 'www.googleapis.com';
}

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}
