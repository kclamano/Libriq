import { Navigation } from './navigation.js';
import { Library } from './library.js';
import { Search } from './search.js';
import { LIBRIQ } from './data.js';
import { Storage } from './storage.js';
import { Utils } from './utils.js';
import { LibriqSyncBeta } from './sync.js';
import { LibriqFirebase } from './firebase-client.js';
import { LibriqCloudBackup } from './cloudBackup.js';
import { initInstallPrompt } from './installPrompt.js';

let _booted = false;
let _whatsNewTimer = null;
const RELEASE_KEY = 'libriq_seen_version';
const SESSION_PREF_KEY = 'libriq_session_pref';

function getWhatsNewVersion() {
  return LIBRIQ.VERSION;
}

function getReleaseNotes() {
  return {
    [getWhatsNewVersion()]: {
      title: "What's New in LibriQ v4.7.0",
      subtitle: 'Better discovery, synced activity, and a smoother cloud-first experience.',
      sections: [
        ['Better book discovery', 'Search results and saved books now carry richer identity signals so LibriQ can merge duplicate sources more safely.'],
        ['Source badges and richer metadata', 'Open Library, Google Books, Project Gutenberg, and Internet Archive badges make book origins easier to understand at a glance.'],
        ['Clickable recommendations', 'Recommendations, Open Library subject rails, and free classics cards now open details and add flows more naturally.'],
        ['Synced activity history', 'Activity now syncs with your account so Dashboard and Activity stay aligned after reloads and site-data clears.'],
        ['Read and archive links', 'When available, Internet Archive links appear in Book Details without changing the normal search experience.'],
      ],
      note: 'This release stays backward-compatible with older saved books and keeps search, sync, and library behavior intact.',
    },
  };
}

  function resetShellUI() {
    if (typeof Search !== 'undefined' && Search.close) Search.close();
    if (typeof Library !== 'undefined' && Library.closeAddModal) Library.closeAddModal();
    closeWhatsNew();

    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('visible');
    document.body.style.overflow = '';
  }

  function closeWhatsNew() {
    const modal = document.getElementById('whatsNewModal');
    if (modal && !modal.hasAttribute('hidden')) {
      Utils.hide(modal);
    }
  }

  function shouldShowWhatsNew() {
    const seen = localStorage.getItem(RELEASE_KEY) || '';
    if (seen === getWhatsNewVersion()) return false;

    // Suppress for fresh accounts (no prior version seen and empty library)
    // to prevent Day-1 changelog cognitive overload
    if (!seen) {
      const books = Storage.getBooks?.() || [];
      if (books.length === 0) {
        localStorage.setItem(RELEASE_KEY, getWhatsNewVersion());
        return false;
      }
    }
    return true;
  }

  function renderWhatsNew() {
    const modal = document.getElementById('whatsNewModal');
    const body = document.getElementById('whatsNewBody');
    if (!modal || !body) return;

    const notes = getReleaseNotes()[getWhatsNewVersion()];
    if (!notes) return;

    modal.querySelector('.modal-title')?.replaceChildren(document.createTextNode(notes.title));
    modal.querySelector('.whats-new-subtitle')?.replaceChildren(document.createTextNode(notes.subtitle));

    body.innerHTML = `
      <div class="whats-new-list">
        ${notes.sections.map(([title, text]) => `
          <section class="whats-new-item">
            <div class="whats-new-item-title">${Utils.sanitize(title)}</div>
            <p>${Utils.sanitize(text)}</p>
          </section>
        `).join('')}
      </div>
      <div class="whats-new-note">${Utils.sanitize(notes.note)}</div>
    `;
  }

  function openWhatsNew() {
    const modal = document.getElementById('whatsNewModal');
    if (!modal) return;
    renderWhatsNew();
    Utils.show(modal);
    document.body.style.overflow = 'hidden';
  }

  function scheduleWhatsNew() {
    cancelScheduledWhatsNew();

    if (!shouldShowWhatsNew()) return;
    if (document.body.classList.contains('session-choice-active')) return;

    _whatsNewTimer = window.setTimeout(() => {
      _whatsNewTimer = null;
      if (document.body.classList.contains('session-choice-active')) return;
      openWhatsNew();
    }, 750);
  }

  function cancelScheduledWhatsNew() {
    if (_whatsNewTimer) {
      window.clearTimeout(_whatsNewTimer);
      _whatsNewTimer = null;
    }
  }

  function dismissWhatsNew() {
    localStorage.setItem(RELEASE_KEY, getWhatsNewVersion());
    closeWhatsNew();
    document.body.style.overflow = '';
    Navigation.routeAfterAuthReady?.();
    if (Navigation.currentPage === 'session') {
      Navigation.renderCurrentPage?.();
    }
  }

  function wireGlobalEvents() {
    window.addEventListener('libriq:book:added',   () => Navigation.updateBadges());
    window.addEventListener('libriq:book:updated', () => Navigation.updateBadges());
    window.addEventListener('libriq:book:removed', () => Navigation.updateBadges());
    window.addEventListener('libriq:book:added',   () => LibriqCloudBackup.scheduleIfAllowed('book-added'));
    window.addEventListener('libriq:book:updated', () => LibriqCloudBackup.scheduleIfAllowed('book-updated'));
    window.addEventListener('libriq:book:removed', () => LibriqCloudBackup.scheduleIfAllowed('book-removed'));
    window.addEventListener('libriq:book:added',   () => LibriqSyncBeta.onLocalChange());
    window.addEventListener('libriq:book:updated', () => LibriqSyncBeta.onLocalChange());
    window.addEventListener('libriq:book:removed', () => LibriqSyncBeta.onLocalChange());
    window.addEventListener('libriq:profile:updated', () => LibriqCloudBackup.scheduleIfAllowed('profile-updated'));
    window.addEventListener('libriq:goals:updated', () => LibriqCloudBackup.scheduleIfAllowed('goals-updated'));
    window.addEventListener('libriq:streak:updated', () => LibriqCloudBackup.scheduleIfAllowed('streak-updated'));
    window.addEventListener('libriq:activity:updated', () => LibriqCloudBackup.scheduleIfAllowed('activity-updated'));
    window.addEventListener('libriq:page-changed', (event) => {
      if (event?.detail?.page === 'session') {
        cancelScheduledWhatsNew();
        closeWhatsNew();
        LibriqCloudBackup.pause('session');
        LibriqSyncBeta.refresh();
        return;
      }
      if (event?.detail?.page) {
        scheduleWhatsNew();
      }
    });

    window.addEventListener('libriq:reset', () => {
      resetShellUI();
      Navigation.applyTheme();
      Navigation.updateBadges();
      Navigation.goTo('dashboard');
      LibriqCloudBackup.scheduleIfAllowed('reset');
    });
  }

  export function bootApp() {
    if (_booted) return;
    _booted = true;

    Storage.bootstrap();

    resetShellUI();

    Navigation.init();
    Navigation.goTo('boot');
    waitForAuthThenRoute();

    Library.init();
    Search.init();

    wireGlobalEvents();
    initInstallPrompt();
    scheduleWhatsNew();

    document.getElementById('whatsNewContinue')?.addEventListener('click', dismissWhatsNew);
    document.getElementById('closeWhatsNew')?.addEventListener('click', dismissWhatsNew);
    document.getElementById('whatsNewModal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) dismissWhatsNew();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('whatsNewModal')?.hasAttribute('hidden')) {
        dismissWhatsNew();
      }
    });

    registerServiceWorker();
  }

  function registerServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (typeof location === 'undefined' || location.protocol === 'file:') return;

    const isLocalDevHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    if (isLocalDevHost) {
      navigator.serviceWorker.getRegistration?.('./service-worker.js')?.then((registration) => {
        registration?.unregister?.();
      }).catch((err) => {
        console.warn('[LibriQ] Service worker cleanup failed:', err);
      });
      navigator.serviceWorker.getRegistrations?.().then((registrations) => {
        registrations.forEach((registration) => registration.unregister());
      }).catch((err) => {
        console.warn('[LibriQ] Service worker cleanup failed:', err);
      });
      globalThis.caches?.keys?.().then((keys) => {
        return Promise.all(keys.filter((key) => key.startsWith('libriq-')).map((key) => caches.delete(key)));
      }).catch((err) => {
        console.warn('[LibriQ] Cache cleanup failed:', err);
      });
      return;
    }

    navigator.serviceWorker.register('./service-worker.js')
      .catch((err) => {
        console.warn('[LibriQ] Service worker registration failed:', err);
      });
  }

  function waitForAuthThenRoute() {
    const firebase = LibriqFirebase.getState();
    if (firebase.ready) {
      Navigation.routeAfterAuthReady?.();
      return;
    }
    let routed = false;
    const unsubscribe = LibriqFirebase.onChange((nextState) => {
      if (routed || !nextState?.ready) return;
      routed = true;
      unsubscribe?.();
      Navigation.routeAfterAuthReady?.();
    });
    window.setTimeout(() => {
      if (routed) return;
      const latest = LibriqFirebase.getState();
      if (!latest.ready) return;
      routed = true;
      unsubscribe?.();
      Navigation.routeAfterAuthReady?.();
    }, 2500);
  }

export function isAppBooted() {
  return _booted;
}
