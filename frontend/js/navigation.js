import { BookAPI } from './api/index.js';
import { LIBRIQ, createBook } from './data.js';
import { Storage } from './storage.js';
import { Utils } from './utils.js';
import { Library } from './library.js';
import { Search } from './search.js';
import { Dashboard } from './dashboard.js';
import { buildMonthlyChart, buildGenreRow } from './dashboard.js';
import { LibriqFirebase } from './firebase-client.js';
import { LibriqCloudBackup } from './cloudBackup.js';
import { Router } from './app/router.js';
import { createDashboardPage } from './features/dashboard/dashboardPage.js';
import { createLibraryPage } from './features/library/libraryPage.js';
import { createActivityPage } from './features/activity/activityPage.js';
import { createHelpPage } from './features/help/helpPage.js';
import { createGoalsPage } from './features/goals/goalsPage.js';
import { createLibraryShelvesPage } from './features/library/libraryShelvesPage.js';
import { createStatisticsPage } from './features/statistics/statisticsPage.js';
import { createSettingsPage } from './features/settings/settingsPage.js';
import { createRecommendationsPage } from './features/recommendations/recommendationsPage.js';
import { createProfilePage } from './features/profile/profilePage.js';
import { createKindleImportPage } from './features/kindleImport/kindleImportPage.js';
import { createQuotesPage } from './features/quotes/quotesPage.js';
import { createImportMerge } from './services/importMerge.js';
import { createExportPayload, parseBackupText, serializeBackup, validateBackup } from './services/backupSerialization.js';
import { createBrowserDownloadFile, createImportExportService, readBrowserFileText } from './services/importExportService.js';
import { parseKindleClippings } from './services/kindleClippingsParser.js';
import { createKindleImportService } from './services/kindleImportService.js';
import { createKindleQuoteImport } from './services/kindleQuoteImport.js';
import { resolveAccountDisplayName } from './accountDisplayName.js';

function executeKindleImport({ previewResult, storage } = {}) {
  if (!storage || typeof storage.updateBook !== 'function' || typeof storage.addBook !== 'function') {
    throw new TypeError('executeKindleImport requires Storage book APIs.');
  }
  const importPlan = previewResult?.importPlan || {};
  const quoteImportPlan = previewResult?.quoteImportPlan || {};
  const matchedBooks = Array.isArray(quoteImportPlan.matchedBooks) ? quoteImportPlan.matchedBooks : [];
  const booksToCreate = Array.isArray(quoteImportPlan.booksToCreate) ? quoteImportPlan.booksToCreate : [];
  let booksMatched = 0;
  let booksCreated = 0;

  for (const item of matchedBooks) {
    const bookId = String(item?.bookId || '').trim();
    if (!bookId) continue;
    const current = storage.getBookById?.(bookId);
    if (!current) continue;
    const quotes = mergeQuoteRecords(current.quotes, item.quotes);
    if (storage.updateBook(bookId, { quotes })) booksMatched += 1;
  }

  for (const item of booksToCreate) {
    if (!item?.candidateBook) continue;
    const candidateBook = { ...item.candidateBook, quotes: cloneQuotes(item.quotes) };
    if (storage.addBook(candidateBook)) booksCreated += 1;
  }

  const result = {
    booksCreated,
    booksMatched,
    quotesImported: Number(quoteImportPlan.importedQuotes) || 0,
    duplicatesSkipped: Number(quoteImportPlan.skippedQuotes) || 0,
    highlightsImported: Number(importPlan.totalHighlights) || 0,
    notesImported: Number(importPlan.totalNotes) || 0,
  };
  if ((booksCreated || booksMatched || result.quotesImported) && typeof storage.buildActivityEvent === 'function' && typeof storage.addActivityEvent === 'function') {
    const event = storage.buildActivityEvent('kindle_imported', null, result, 'import');
    if (event) storage.addActivityEvent(event);
  }
  return result;
}

export function completeKindleImport({ previewResult, storage, toast, rerender } = {}) {
  const result = executeKindleImport({ previewResult, storage });
  toast?.(`Kindle import complete: ${result.booksCreated} books created, ${result.booksMatched} books matched, ${result.quotesImported} quotes imported, ${result.duplicatesSkipped} duplicates skipped.`, 'success');
  rerender?.();
  return result;
}

function cloneQuotes(quotes) {
  return (Array.isArray(quotes) ? quotes : []).map(quote => ({ ...quote }));
}

function mergeQuoteRecords(currentQuotes, plannedQuotes) {
  const merged = cloneQuotes(currentQuotes);
  const identities = new Set(merged.map(quoteRecordIdentity));
  for (const quote of cloneQuotes(plannedQuotes)) {
    const identity = quoteRecordIdentity(quote);
    if (identities.has(identity)) continue;
    merged.push(quote);
    identities.add(identity);
  }
  return merged;
}

function quoteRecordIdentity(quote) {
  const id = String(quote?.id || '').trim();
  if (id) return `id:${id}`;
  return `quote:${String(quote?.text || '')}\u0000${String(quote?.note || '')}\u0000${String(quote?.page ?? '')}`;
}

const importMerge = createImportMerge({
  createBook,
  statuses: LIBRIQ.STATUS,
  now: () => new Date().toISOString(),
  createId: () => crypto.randomUUID(),
});
const _summarizeLibrary = importMerge.summarizeLibrary;
const _mergeBooksForImport = importMerge.mergeBooksForImport;
const _mergeActivityById = importMerge.mergeActivityById;
const importExportService = createImportExportService({
  storage: Storage,
  constants: LIBRIQ,
  createBook,
  createExportPayload,
  serializeBackup,
  parseBackupText,
  validateBackup,
  downloadFile: createBrowserDownloadFile({ BlobCtor: globalThis.Blob, urlApi: globalThis.URL, documentRoot: globalThis.document }),
  readFileText: readBrowserFileText,
  clock: () => new Date(),
  createId: () => crypto.randomUUID(),
});
let profileFeature;
export const Navigation = (() => {
  let _currentPage = 'dashboard';
  const SESSION_PREF_KEY = 'libriq_session_pref';
  const SESSION_MODE_KEY = 'libriq_session_mode';
  const PREFERRED_SESSION_MODE_KEY = 'libriq_preferred_session_mode';
  const DEBUG_SYNC = () => localStorage.getItem('libriq_debug_sync') === '1';
  let _lastAuthUid = null;
  let initialized = false;

  function getMainContentRoot(context = 'navigation') {
    const main = document.getElementById('mainContent');
    if (!main) {
      console.error(`[LibriQ] Missing #mainContent while rendering ${context}.`);
      return null;
    }

    main.hidden = false;
    main.style.display = '';
    main.style.visibility = '';
    main.style.opacity = '';
    main.style.height = '';
    main.style.maxHeight = '';
    main.style.overflow = '';
    main.style.position = '';
    main.style.inset = '';
    return main;
  }

  function debugSync(message, details = null) {
    if (!DEBUG_SYNC()) return;
    const prefix = '[LibriQ][SyncDebug][Nav]';
    if (details !== null && details !== undefined) console.debug(prefix, message, details);
    else console.debug(prefix, message);
  }

  function isConfirmedSignedOut(firebase = LibriqFirebase.getState()) {
    return Boolean(firebase.ready && !firebase.user && firebase.signedOutConfirmed && !firebase.restoringSession);
  }

  function shouldRenderSessionScreen(firebase = LibriqFirebase.getState()) {
    if (!firebase.ready) return false;
    if (firebase.user || firebase.restoringSession) return false;
    return Boolean(firebase.signedOutConfirmed);
  }

  function getSessionScreenSuppressionReason(firebase = LibriqFirebase.getState()) {
    if (!firebase.ready) return 'auth not ready';
    if (firebase.user) return 'signed-in user exists';
    if (firebase.restoringSession) return 'restoring session';
    if (!firebase.signedOutConfirmed) return 'signed out not confirmed';
    return 'confirmed signed out';
  }

  function setEmailAuthMode(mode) {
    const nextMode = mode === 'signup' ? 'signup' : mode === 'reset' ? 'reset' : 'signin';
    const form = document.getElementById('emailAuthForm');
    const password = document.getElementById('sessionPasswordInput');
    const submit = document.getElementById('emailAuthSubmit');
    const forgot = document.getElementById('forgotPasswordLink');
    const resetMode = document.getElementById('sessionResetMode');
    const signinMode = document.getElementById('sessionSigninMode');
    form?.setAttribute('data-auth-mode', nextMode);
    password?.setAttribute('autocomplete', nextMode === 'signup' ? 'new-password' : 'current-password');
    if (submit) {
      const label = submit.querySelector('span');
      if (label) label.textContent = nextMode === 'signup' ? 'Create account' : 'Sign in with Email';
    }
    if (signinMode) signinMode.hidden = nextMode === 'reset';
    if (resetMode) resetMode.hidden = nextMode !== 'reset';
    if (forgot) forgot.hidden = nextMode !== 'signin';
    Utils.$$('.session-auth-tab').forEach(btn => {
      const active = btn.dataset.authMode === nextMode || (nextMode === 'reset' && btn.dataset.authMode === 'signin');
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    return nextMode;
  }

  const featureActions = {
    navigate: (page) => goTo(page),
    openSearch: () => Search.open(),
    openManualEntry: () => Search.openManualEntry(),
    importBackup: () => promptImportData(),
    clearSearch: () => libraryFeature.clearSearch(),
    showBookDetails: (bookId) => Library.showDetailsModal(bookId),
    updateProgress: (bookId) => Library.showProgressModal(bookId),
    toggleFavorite: (bookId) => {
      Library.toggleFavorite(bookId);
      updateBadges();
      renderCurrentPage();
    },
    removeBook: (bookId) => {
      const book = Storage.getBookById(bookId);
      Library.removeBook(bookId, book?.title || 'this book');
    },
    setGoalPreset: (input, yearly) => {
      if (input) input.value = yearly;
    },
    refreshGoals: () => goalsFeature(),
    getLibraryState: () => libraryFeature.getState(),
    buildMonthlyChart,
    buildGenreRow,
    isOnline: () => globalThis.navigator?.onLine !== false,
    getFirebaseState: () => LibriqFirebase.getState(),
  };
  const settingsActions = {
    ...featureActions,
    getActiveTheme: () => Navigation.getActiveTheme?.(),
    getSessionPreference: () => Navigation.getSessionPreference?.(),
    getFirebaseState: () => LibriqFirebase.getState(),
    getUserEmailAuthInfo: user => LibriqFirebase.getUserEmailAuthInfo(user),
    getCurrentUser: () => LibriqFirebase.getCurrentUser(),
    hasFirestore: () => LibriqFirebase.hasFirestore(),
    getCloudBackupState: () => LibriqCloudBackup.getState(),
    formatLastSavedLabel: value => LibriqCloudBackup.formatLastSavedLabel(value),
    getSyncState: () => window.LibriqSyncBeta?.getState?.(),
    getDisplayName: user => getDisplayNameForAccount(user),
    toggleTheme: () => Navigation.toggleTheme(),
    exportData: () => exportData(),
    promptImportData: () => promptImportData(),
    openKindleImport: () => kindleImportFeature.open(),
    importDataFromFile: file => importDataFromFile(file),
    confirmDeleteLibraryData: () => confirmDeleteLibraryData(),
    confirmDeleteAccount: () => confirmDeleteAccount(),
    clearLocalCache: () => clearLocalCache(),
    backupToCloud: () => backupToCloud(),
    openCloudRestorePreview: () => openCloudRestorePreview(),
    openCloudMergePreview: () => openCloudMergePreview(),
    accountAction: async action => {
      try {
        if (action === 'signin') await LibriqFirebase.signInWithGoogle();
        else await LibriqFirebase.signOut();
      } catch (err) {
        const code = String(err?.code || err?.message || '');
        const cancelled = code.includes('popup-closed-by-user') || code.includes('popup-blocked');
        Utils.toast(cancelled ? 'Sign-in was cancelled.' : 'Could not update account status right now.', 'error');
      }
    },
    sendVerification: async () => {
      try {
        await LibriqFirebase.sendVerificationEmailToCurrentUser?.();
        Utils.toast('Verification email sent. Check your inbox.', 'success');
        await LibriqFirebase.refreshCurrentUser?.();
        Navigation.renderCurrentPage?.();
      } catch (err) { Utils.toast(_friendlyAuthMessage(err), 'error'); }
    },
    refreshEmailStatus: async () => {
      try {
        await LibriqFirebase.refreshCurrentUser?.();
        Utils.toast('Account status refreshed.', 'info');
        Navigation.renderCurrentPage?.();
      } catch (err) { Utils.toast(_friendlyAuthMessage(err), 'error'); }
    },
    resetPassword: async () => {
      try {
        await LibriqFirebase.sendPasswordResetToEmail?.(LibriqFirebase.getState?.()?.user?.email || '');
        Utils.toast('Password reset email sent if an account exists for that address.', 'success');
      } catch (err) { Utils.toast(_friendlyAuthMessage(err), 'error'); }
    },
    changeEmail: async value => {
      try {
        await LibriqFirebase.requestEmailChange?.(String(value || '').trim());
        Utils.toast('We sent a confirmation link to your new email. Your email will update after you confirm it.', 'success');
      } catch (err) { Utils.toast(_friendlyAuthMessage(err), 'error'); }
    },
    toggleSync: enabled => {
      if (enabled) {
        window.LibriqSyncBeta?.setEnabled?.(false);
        Utils.toast('Account sync turned off', 'info');
        Navigation.renderCurrentPage?.();
        return;
      }
      const firebase = LibriqFirebase.getState();
      if (Navigation.getSessionPreference?.() === 'offline') {
        Utils.toast('Switch to account mode before enabling sync.', 'warning');
        return;
      }
      if (!firebase.user && !LibriqFirebase.getCurrentUser()) {
        Utils.toast('Sign in first to enable sync.', 'warning');
        return;
      }
      if (!firebase.user) firebase.user = LibriqFirebase.getCurrentUser() || null;
      window.LibriqSyncBeta?.setEnabled?.(true);
      Utils.toast('Sync is on. Your books will update across signed-in devices.', 'success');
    },
    refreshSync: () => {
      window.LibriqSyncBeta?.refresh?.();
      Utils.toast('Sync status refreshed', 'info');
      window.setTimeout(() => Navigation.renderCurrentPage?.(), 150);
    },
  };
  const goalsFeature = createGoalsPage({ storage: Storage, utils: Utils, actions: featureActions });
  const libraryFeature = createLibraryPage({ storage: Storage, library: Library, utils: Utils, constants: LIBRIQ, actions: featureActions });
  const libraryShelvesFeature = createLibraryShelvesPage({ storage: Storage, library: Library, utils: Utils, actions: featureActions });
  const statisticsFeature = createStatisticsPage({ storage: Storage, utils: Utils, constants: LIBRIQ, actions: featureActions });
  const quotesFeature = createQuotesPage({ storage: Storage, utils: Utils, actions: featureActions });
  const kindleImportService = createKindleImportService({
    createBook,
    createId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
  });
  const kindleQuoteImport = createKindleQuoteImport({
    createId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
  });
  const kindleImportFeature = createKindleImportPage({
    parseClippings: parseKindleClippings,
    buildImportPlan: kindleImportService.buildImportPlan,
    applyKindleImportPlan: kindleQuoteImport.applyKindleImportPlan,
    actions: {
      getExistingBooks: () => Storage.getBooks(),
      continueImport: detail => {
        try {
          return completeKindleImport({
            previewResult: detail,
            storage: Storage,
            toast: (message, type) => Utils.toast(message, type),
            rerender: () => Navigation.renderCurrentPage?.(),
          });
        } catch (error) {
          Utils.toast('Could not import Kindle clippings.', 'error');
          return false;
        }
      },
    },
  });
  const settingsFeature = createSettingsPage({ storage: Storage, utils: Utils, constants: LIBRIQ, actions: settingsActions });
  const recommendationsFeature = createRecommendationsPage({ storage: Storage, library: Library, bookApi: BookAPI, utils: Utils, constants: LIBRIQ, actions: featureActions });
  profileFeature = createProfilePage({ storage: Storage, utils: Utils, constants: LIBRIQ, actions: featureActions });

  const pages = {
    boot:      () => renderBootPage(),
    session:   () => renderSessionChoicePage(),
    dashboard: createDashboardPage({ dashboard: Dashboard, actions: featureActions }),
    library:   libraryFeature,
    reading:   () => libraryShelvesFeature.renderStatusPage(LIBRIQ.STATUS.READING,  'Currently Reading', 'ph-book-open'),
    wishlist:  () => libraryShelvesFeature.renderStatusPage(LIBRIQ.STATUS.WISHLIST, 'Want to Read',      'ph-bookmark'),
    finished:  () => libraryShelvesFeature.renderStatusPage(LIBRIQ.STATUS.FINISHED, 'Finished Books',    'ph-check-circle'),
    favorites: () => libraryShelvesFeature.renderFavoritesPage(),
    stats:     statisticsFeature,
    activity:  createActivityPage({ storage: Storage, utils: Utils, actions: featureActions }),
    quotes:    quotesFeature,
    goals:     goalsFeature,
    recommendations: recommendationsFeature,
    help:      createHelpPage({ storage: Storage, actions: featureActions }),
    profile:   profileFeature,
    settings:  settingsFeature,
  };

  const router = new Router({
    root: () => getMainContentRoot('router'),
    initialRoute: _currentPage,
    beforeNavigate: ({ name }) => {
      _currentPage = name;
      applyAuthShellStateForPage(name);

      Utils.$$('.nav-item').forEach(el => {
        const active = el.dataset.page === name;
        el.classList.toggle('active', active);
        if (active) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
      });
      Utils.$$('.mobile-bottom-item').forEach(el => {
        const tab = el.dataset.tab;
        let active = false;
        if (tab === 'dashboard' && name === 'dashboard') active = true;
        else if (tab === 'library' && ['library', 'reading', 'wishlist', 'finished', 'abandoned'].includes(name)) active = true;
        else if (tab === 'stats' && ['stats', 'goals', 'activity'].includes(name)) active = true;
        else if (tab === 'settings' && ['settings', 'help'].includes(name)) active = true;
        el.classList.toggle('active', active);
        if (active) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
      });
      closeMobileSidebar();
    },
    afterNavigate: ({ name, root }) => {
      LibriqCloudBackup.refresh();
      if (root) root.scrollTop = 0;
      window.dispatchEvent(new CustomEvent('libriq:page-changed', { detail: { page: name } }));
    },
    renderError: ({ error, name, root }) => {
      console.error(`[LibriQ] Failed to render ${name} page:`, error);
      if (root) {
        root.innerHTML = `
          <div class="page" id="${name}Page">
            <div class="page-header">
              <h1 class="page-title">${Utils.sanitize(name.charAt(0).toUpperCase() + name.slice(1))}</h1>
              <p class="page-subtitle">This page could not finish rendering.</p>
            </div>
          </div>`;
      }
    },
  }).registerAll(pages);

  function goTo(page) {
    router.navigate(page);
  }

  function renderCurrentPage() {
    applyAuthShellStateForPage(_currentPage);
    router.refresh();
  }

  function applyAuthShellStateForPage(page) {
    const body = document.body;
    body.classList.remove('auth-booting', 'auth-signed-in', 'auth-signed-out', 'auth-local-only');
    if (page === 'boot') {
      body.classList.add('auth-booting');
    } else if (page === 'session') {
      body.classList.add('auth-signed-out');
    } else if (getCurrentSessionMode() === 'offline' || getSessionPreference() === 'offline') {
      body.classList.add('auth-local-only');
    } else {
      body.classList.add('auth-signed-in');
    }
    body.classList.toggle('session-choice-active', page === 'session' || page === 'boot');
  }

  function getSessionPreference() {
    const raw = localStorage.getItem(SESSION_PREF_KEY) || 'prompt';
    return raw === 'google' ? 'account' : raw;
  }

  function setSessionPreference(value) {
    const next = value === 'google' ? 'account' : value;
    localStorage.setItem(SESSION_PREF_KEY, next);
    if (next === 'offline') {
      sessionStorage.setItem(SESSION_MODE_KEY, 'offline');
      localStorage.setItem(PREFERRED_SESSION_MODE_KEY, 'offline');
    } else if (next === 'account') {
      sessionStorage.setItem(SESSION_MODE_KEY, 'account');
      localStorage.setItem(PREFERRED_SESSION_MODE_KEY, 'account');
    } else {
      sessionStorage.removeItem(SESSION_MODE_KEY);
    }
  }

  function getCurrentSessionMode() {
    const raw = sessionStorage.getItem(SESSION_MODE_KEY) || localStorage.getItem(PREFERRED_SESSION_MODE_KEY) || getSessionPreference();
    return raw === 'google' ? 'account' : raw;
  }

  function clearAccountResume() {
    sessionStorage.removeItem(SESSION_MODE_KEY);
    localStorage.setItem(PREFERRED_SESSION_MODE_KEY, 'prompt');
  }

  function shouldResumeAccountMode() {
    const firebase = LibriqFirebase.getState();
    const stored = getCurrentSessionMode();
    const allow = Boolean(
      firebase.user &&
      firebase.ready &&
      stored !== 'offline' &&
      getSessionPreference() !== 'offline'
    );
    debugSync('resume check', {
      uid: firebase.user?.uid || null,
      ready: firebase.ready,
      currentSessionMode: stored,
      preferredSessionMode: localStorage.getItem(PREFERRED_SESSION_MODE_KEY) || null,
      sessionPref: getSessionPreference(),
      allowed: allow,
    });
    return allow;
  }

  function resumeAccountModeIfAllowed() {
    debugSync('resume attempt', {
      currentPage: _currentPage,
      sessionChoiceActive: document.body.classList.contains('session-choice-active'),
    });
    if (!shouldResumeAccountMode()) {
      debugSync('resume blocked');
      return false;
    }
    debugSync('resume allowed');
    if (_currentPage === 'session' || document.body.classList.contains('session-choice-active')) {
      goTo('dashboard');
      window.LibriqSyncBeta?.refresh?.();
      return true;
    }
    return false;
  }

  function openMobileSidebar() {
    const sidebar  = document.getElementById('sidebar');
    const overlay  = document.getElementById('sidebarOverlay');
    if (!sidebar || !overlay) return;
    sidebar.classList.add('open');
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeMobileSidebar() {
    const sidebar  = document.getElementById('sidebar');
    const overlay  = document.getElementById('sidebarOverlay');
    if (!sidebar || !overlay) return;
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
  }

  function updateBadges() {
    const stats = Storage.getStats();
    const map = {
      'badge-library':  stats.total,
      'badge-reading':  stats.reading,
      'badge-wishlist': stats.wishlist,
      'badge-finished': stats.finished,
    };
    Object.entries(map).forEach(([id, count]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = count;
    });

    const streak = Storage.getStreak();
    const streakEl = document.getElementById('streakCount');
    if (streakEl) streakEl.textContent = streak.current;
  }

  function applyTheme() {
    const theme = _getActiveTheme();
    document.documentElement.setAttribute('data-theme', theme);
    _updateThemeToggleUI(theme);
  }

  function _getActiveTheme() {
    const attrTheme = document.documentElement.getAttribute('data-theme');
    if (attrTheme === 'dark' || attrTheme === 'light') return attrTheme;
    const profile = Storage.getProfile?.();
    return profile?.theme === 'light' ? 'light' : 'dark';
  }

  function _withThemeSwitchLock(fn) {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    fn();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        root.classList.remove('theme-switching');
      });
    });
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next    = current === 'dark' ? 'light' : 'dark';
    _withThemeSwitchLock(() => {
      document.documentElement.setAttribute('data-theme', next);
      _updateThemeToggleUI(next);
    });
    Storage.saveProfile({ theme: next });
    if (_currentPage === 'settings') settingsFeature();
  }

  function _updateThemeToggleUI(theme) {
    const icon  = document.getElementById('themeIcon');
    const label = document.getElementById('themeLabel');
    const iconDesktop = document.getElementById('themeIconDesktop');
    if (icon)  icon.className   = theme === 'dark' ? 'ph ph-moon' : 'ph ph-sun';
    if (iconDesktop) iconDesktop.className = theme === 'dark' ? 'ph ph-moon' : 'ph ph-sun';
    if (label) label.textContent = theme === 'dark' ? 'Dark mode' : 'Light mode';
  }

  function updateDesktopStatusPill() {
    const el = document.getElementById('desktopStatusPill');
    if (!el) return;
    const firebase = LibriqFirebase.getState();
    const syncState = window.LibriqSyncBeta?.getState?.() || {};
    const offline = getSessionPreference() === 'offline' || getCurrentSessionMode() === 'offline';
    const label = !firebase.user
      ? 'Signed out'
      : offline
        ? 'Offline mode'
        : syncState.enabled
          ? 'Sync on'
          : 'Ready';
    el.querySelector('span')?.replaceChildren(document.createTextNode(label));
    const icon = el.querySelector('i');
    if (icon) icon.className = !firebase.user ? 'ph ph-user-circle' : offline ? 'ph ph-wifi-slash' : syncState.enabled ? 'ph ph-swap' : 'ph ph-signal';
  }

  function init() {
    if (initialized) return;
    initialized = true;
    Utils.$$('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => goTo(btn.dataset.page));
    });

    Utils.$$('.mobile-bottom-item').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab) goTo(btn.dataset.tab);
      });
    });
    document.getElementById('mobileBottomSearchBtn')?.addEventListener('click', () => {
      Search.open();
    });

    document.getElementById('mobileMenuBtn')?.addEventListener('click', openMobileSidebar);
    document.getElementById('sidebarOverlay')?.addEventListener('click', closeMobileSidebar);
    document.getElementById('sidebarOverlay')?.addEventListener('touchstart', closeMobileSidebar, { passive: true });

    document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);
    document.getElementById('themeToggleDesktop')?.addEventListener('click', toggleTheme);

    applyTheme();
    updateBadges();
    updateDesktopStatusPill();
    const tryResume = () => {
    const firebase = LibriqFirebase.getState();
      debugSync('startup resume check', {
        uid: firebase.user?.uid || null,
        ready: firebase.ready,
        hasUser: Boolean(firebase.user),
        sessionPref: getSessionPreference(),
        currentSessionMode: getCurrentSessionMode(),
      });
      if (firebase.ready && firebase.user && shouldResumeAccountMode()) {
        resumeAccountModeIfAllowed();
      }
    };
    tryResume();
    window.setTimeout(tryResume, 500);
    window.addEventListener('libriq:auth-changed', () => {
      const firebase = LibriqFirebase.getState();
      const nextUid = firebase.user?.uid || null;
      const uidChanged = _lastAuthUid !== nextUid;
      _lastAuthUid = nextUid;
      debugSync('auth state resolved', {
        uid: firebase.user?.uid || null,
        ready: firebase.ready,
        hasUser: Boolean(firebase.user),
        restoringSession: Boolean(firebase.restoringSession),
        currentSessionMode: getCurrentSessionMode(),
        preferredSessionMode: localStorage.getItem(PREFERRED_SESSION_MODE_KEY) || null,
        sessionPref: getSessionPreference(),
      });
      if (uidChanged) {
        window.LibriqSyncBeta?.detachForAccountSwitch?.('navigation-auth-change');
        Navigation.updateBadges?.();
      }
      if (!firebase.user && firebase.signedOutConfirmed) {
        clearAccountResume();
        if (getCurrentSessionMode() !== 'offline' && getSessionPreference() !== 'offline') {
          if (_currentPage !== 'session') goTo('session');
          else renderSessionChoicePage();
          return;
        }
      }
      if (firebase.user && shouldResumeAccountMode()) {
        resumeAccountModeIfAllowed();
      } else if (firebase.ready && _currentPage === 'boot') {
        routeAfterAuthReady();
      } else if (firebase.restoringSession && _currentPage === 'session') {
        renderSessionChoicePage();
      } else if (firebase.restoringSession && firebase.user && _currentPage !== 'session') {
        renderCurrentPage?.();
      } else if (_currentPage === 'settings') settingsFeature();
      if (_currentPage === 'session') renderSessionChoicePage();
      LibriqCloudBackup.refresh();
      window.LibriqSyncBeta?.refresh?.();
      updateDesktopStatusPill();
      maybeShowNewDeviceCloudPrompt();
    });
    window.addEventListener('libriq:activity:updated', () => {
      if (['dashboard', 'activity'].includes(_currentPage)) {
        Navigation.renderCurrentPage?.();
      }
    });
    if (DEBUG_SYNC()) {
      debugSync('init state', {
        currentPage: _currentPage,
        sessionPref: getSessionPreference(),
        currentSessionMode: getCurrentSessionMode(),
        preferredSessionMode: localStorage.getItem(PREFERRED_SESSION_MODE_KEY) || null,
      });
    }
  }

  return {
    init, goTo, renderCurrentPage, updateBadges, toggleTheme, applyTheme,
    getActiveTheme: _getActiveTheme,
    updateDesktopStatusPill,
    routeAfterAuthReady,
    setSessionPreference,
    getSessionPreference,
    getCurrentSessionMode,
    shouldResumeAccountMode,
    resumeAccountModeIfAllowed,
    clearAccountResume,
    clearLibrarySearch: () => libraryFeature.clearSearch(),
    clearLocalCache,
    confirmDeleteLibraryData,
    confirmDeleteAccount,
    setEmailAuthMode,
    shouldRenderSessionScreen,
    isConfirmedSignedOut,
    get currentPage() { return _currentPage; },
  };
})();

function renderBootPage() {
  const main = document.getElementById('mainContent');
  if (!main) return;
  main.hidden = false;
  main.innerHTML = `
    <div class="session-page">
      <section class="session-hero">
        <div class="session-card-stack session-card-stack--compact">
          <div class="session-loading-card" aria-live="polite">
            <div class="session-loading-spinner"></div>
            <div>
              <div class="session-card-title">Opening LibriQ</div>
              <div class="session-card-body">Checking your account before loading your library.</div>
            </div>
          </div>
        </div>
      </section>
    </div>`;
}

function routeAfterAuthReady() {
      const firebase = LibriqFirebase.getState();
  if (!firebase.ready) {
    Navigation.goTo('boot');
    return false;
  }
  if (firebase.user || firebase.restoringSession) {
    if (firebase.user) {
    Storage.setActiveAccountUid?.(firebase.user.uid);
    Navigation.setSessionPreference?.('account');
    }
    if (Navigation.currentPage === 'session') {
      Navigation.goTo('dashboard');
    } else if (Navigation.currentPage === 'boot') {
      Navigation.goTo('dashboard');
    }
    window.LibriqSyncBeta?.maybeAutoEnable?.('auth-ready');
    return true;
  }
  if (!firebase.signedOutConfirmed && firebase.available) {
    debugSync('auth ready preserved while session restores', {
      restoringSession: Boolean(firebase.restoringSession),
      signedOutConfirmed: Boolean(firebase.signedOutConfirmed),
      hasUser: Boolean(firebase.user),
    });
    if (Navigation.currentPage !== 'boot') return true;
  }
  Storage.clearActiveAccountScope?.();
  if (Navigation.getCurrentSessionMode?.() === 'offline' || Navigation.getSessionPreference?.() === 'offline') {
    Navigation.goTo('dashboard');
    return true;
  }
  if (Navigation.currentPage !== 'session') Navigation.goTo('session');
  else renderSessionChoicePage();
  return true;
}

function _cloudRestoreDismissKey(uid) {
  return uid ? `libriq_cloud_restore_dismissed_${uid}` : 'libriq_cloud_restore_dismissed';
}

async function maybeShowNewDeviceCloudPrompt() {
  const firebase = LibriqFirebase.getState();
  if (!firebase.user || !firebase.ready || !LibriqFirebase.hasFirestore()) return;
  if (Storage.getBooks().length > 0) return;
  if (Navigation.currentPage === 'session' || document.body.classList.contains('session-choice-active')) return;
  if (Navigation.getSessionPreference?.() === 'offline') return;

  const dismissKey = _cloudRestoreDismissKey(firebase.user.uid);
  if (localStorage.getItem(dismissKey) === '1') return;

  try {
    const snap = await LibriqFirebase.readBackupDoc(['users', firebase.user.uid, 'backups', 'current']);
    if (!snap?.exists?.()) return;
    const docData = LibriqCloudBackup.normalizeBackup(snap.data());
    if (!docData) return;

    const main = document.getElementById('mainContent');
    if (!main || !document.body.classList.contains('session-choice-active')) return;

    const card = document.createElement('div');
    card.className = 'goal-widget';
    card.id = 'newDeviceCloudPrompt';
    card.style.marginTop = 'var(--space-6)';
    card.innerHTML = `
      <div class="goal-header"><div class="goal-title">Cloud backup found</div></div>
      <div class="activity-item activity-item--static">
        <div class="activity-text">
          <div class="activity-title">We found a cloud backup for your account.</div>
          <div class="activity-subtitle">Restore here or keep this device empty for now.</div>
        </div>
      </div>
      <div class="inline-actions">
        <button class="btn btn-primary btn-sm" id="newDeviceCloudRestoreBtn" type="button">Restore here</button>
        <button class="btn btn-secondary btn-sm" id="newDeviceCloudDismissBtn" type="button">Keep this device empty for now</button>
      </div>
    `;
    main.prepend(card);
    document.getElementById('newDeviceCloudRestoreBtn')?.addEventListener('click', async () => {
      card.remove();
      await confirmAndRestoreCloud(docData, _summarizeLibrary(Storage.getBooks(), Storage.getActivityLog?.() || []));
    });
    document.getElementById('newDeviceCloudDismissBtn')?.addEventListener('click', () => {
      localStorage.setItem(dismissKey, '1');
      card.remove();
    });
  } catch (err) {
    console.warn('[Libriq] New-device cloud prompt failed:', err);
  }
}

function renderSessionChoicePage() {
  const main = document.getElementById('mainContent');
  if (!main) {
    console.error('[LibriQ] Missing #mainContent while rendering session choice page.');
    return;
  }
  main.hidden = false;
  const firebase = LibriqFirebase.getState();
  if (!Navigation.shouldRenderSessionScreen?.(firebase)) {
    if (localStorage.getItem('libriq_debug_sync') === '1') {
      console.debug('[LibriQ][SyncDebug][Nav] session screen blocked', {
        reason: Navigation.isConfirmedSignedOut?.(firebase) ? 'not on session screen' : getSessionScreenSuppressionReason(firebase),
        hasUser: Boolean(firebase.user),
        restoringSession: Boolean(firebase.restoringSession),
        signedOutConfirmed: Boolean(firebase.signedOutConfirmed),
        ready: Boolean(firebase.ready),
        currentPage: Navigation.currentPage,
      });
    }
    if (firebase.user || firebase.restoringSession) {
      Navigation.goTo('dashboard');
      return;
    }
    if (Navigation.currentPage !== 'session') {
      Navigation.goTo('dashboard');
      return;
    }
  }
  const sessionContext = LibriqFirebase.getSessionContext();
  const hasUser = Boolean(firebase.user);
  const accountName = getDisplayNameForAccount(firebase.user);
  const loading = !firebase.initialized || (firebase.available && !firebase.ready);
  const inAppBrowser = Boolean(sessionContext.isInAppBrowser);
  const signInButtonLabel = hasUser ? `Continue as ${Utils.sanitize(accountName)}` : 'Continue with Google';
  const signInButtonHelp = inAppBrowser
    ? 'Google sign-in may not work inside this app browser.'
    : 'Use your account for cloud backup and Account Sync.';
  const browserHelp = inAppBrowser
    ? 'Open LibriQ in Chrome or Safari to sign in with Google.'
    : '';
  const openInBrowserHref = 'https://libriq.app';
  const authUnavailable = !firebase.available || (typeof navigator !== 'undefined' && navigator.onLine === false);
  const offlineCheckDelayMs = 900;
  const offlineStabilityMs = 1400;

  if (!window.LibriqSessionFallback) {
    window.LibriqSessionFallback = {
      timer: null,
      lastRequestedAt: 0,
      dismissAt: 0,
      modalVisible: false,
    };
  }
  const fallbackState = window.LibriqSessionFallback;

  main.innerHTML = `
    <div class="session-page">
      <section class="session-hero">
        <div class="session-hero-orb session-hero-orb-a"></div>
        <div class="session-hero-orb session-hero-orb-b"></div>

        <div class="session-copy">
          <a class="session-brand" href="./" aria-label="LibriQ home">
            <span class="session-brand-mark">Q</span>
            <span><strong>LibriQ</strong><small>Your reading life, in one place</small></span>
          </a>
          <span class="session-eyebrow"><i class="ph ph-book-open-text"></i> A calmer way to track what you read</span>
          <h1 class="session-title">Build a reading life worth remembering.</h1>
          <p class="session-subtitle">
            Keep your library, progress, notes, quotes, and reading patterns together in a private space designed around books.
          </p>

          <div class="session-points">
            <div class="session-point">
              <i class="ph ph-lock-key"></i>
              <span>Your library stays private and under your control.</span>
            </div>
            ${inAppBrowser ? `
            <div class="session-point session-point-warning">
              <i class="ph ph-warning-circle"></i>
              <span>Google sign-in may not work inside this app browser.</span>
            </div>` : ''}
            <div class="session-point">
              <i class="ph ph-cloud-check"></i>
              <span>Account Sync keeps your reading space available across signed-in devices.</span>
            </div>
          </div>

          <div class="session-product-preview" aria-label="Preview of the LibriQ reading dashboard">
            <div class="session-preview-topbar">
              <span>Good evening, Reader</span>
              <span class="session-preview-avatar">R</span>
            </div>
            <div class="session-preview-heading">Your reading rhythm</div>
            <div class="session-preview-grid">
              <div class="session-preview-book">
                <span class="session-preview-cover"><i class="ph ph-book-open"></i></span>
                <span><small>Reading now</small><strong>Continue your current book</strong></span>
              </div>
              <div class="session-preview-stat"><strong>12</strong><span>books this year</span></div>
              <div class="session-preview-stat"><strong>7</strong><span>day streak</span></div>
            </div>
            <div class="session-preview-progress"><span style="width: 68%"></span></div>
          </div>

          <div class="session-demo-showcase" id="sessionDemoShowcase" aria-label="Interactive preview: Search any book">
            <div class="session-demo-header">
              <span class="session-demo-badge"><i class="ph ph-sparkle"></i> Live Book Search</span>
              <span class="session-demo-subtitle">Try finding your current read</span>
            </div>
            <div class="session-demo-searchbar">
              <i class="ph ph-magnifying-glass session-demo-search-icon"></i>
              <input type="text" id="sessionDemoInput" class="session-demo-input" placeholder="Search title or author (e.g. Dune)..." autocomplete="off" />
              <span class="session-demo-spinner" id="sessionDemoSpinner" hidden></span>
            </div>
            <div class="session-demo-tags">
              <span class="session-demo-tag-label">Try:</span>
              <button type="button" class="session-demo-tag" data-query="Project Hail Mary">Project Hail Mary</button>
              <button type="button" class="session-demo-tag" data-query="Atomic Habits">Atomic Habits</button>
              <button type="button" class="session-demo-tag" data-query="Dune">Dune</button>
            </div>
            <div class="session-demo-results" id="sessionDemoResults" hidden></div>
          </div>
        </div>

        <div class="session-card-stack session-auth-panel">
          <div class="session-auth-heading">
            <span>Welcome to LibriQ</span>
            <h2>${hasUser ? `Continue your library` : 'Start your reading space'}</h2>
            <p>${hasUser ? 'Your account is ready on this device.' : 'Sign in or create an account to begin.'}</p>
          </div>
          ${inAppBrowser ? `
            <div class="session-inapp-notice" role="alert">
              <div class="session-inapp-icon"><i class="ph ph-warning-circle"></i></div>
              <div class="session-inapp-body">
                <strong>In-App Browser Detected</strong>
                <p>Social apps (Instagram, Reddit, TikTok) block Google sign-in. Use email sign-up below or open in your system browser.</p>
                <a class="session-inapp-link" href="${openInBrowserHref}" target="_blank" rel="noopener noreferrer">
                  <i class="ph ph-arrow-square-out"></i> Open in Safari / Chrome
                </a>
              </div>
            </div>
          ` : ''}
          ${loading ? `
            <div class="session-loading-card" aria-live="polite">
              <div class="session-loading-spinner"></div>
              <div>
                <div class="session-card-title">Checking your sign-in status</div>
                <div class="session-card-body">Just a moment while LibriQ checks whether you are already signed in.</div>
              </div>
            </div>
          ` : ''}

          ${loading ? '' : hasUser ? `
            <button class="session-card session-card-primary" id="googleContinueBtn" type="button">
              <div class="session-card-icon"><i class="ph ph-user-circle"></i></div>
              <div class="session-card-content">
                <div class="session-card-title">Continue as ${Utils.sanitize(accountName)}</div>
                <div class="session-card-body">Enter LibriQ with your current Google account. Automatic cloud backup is enabled for this session.</div>
              </div>
              <div class="session-card-action"><i class="ph ph-arrow-right"></i></div>
            </button>
          ` : firebase.initialized ? `
            <button class="session-card session-card-primary ${inAppBrowser ? 'session-card-disabled' : ''}" id="googleSignInBtn" type="button" ${inAppBrowser ? 'aria-describedby="googleSignInHelp"' : ''}>
              <div class="session-card-icon"><i class="ph ph-google-logo"></i></div>
              <div class="session-card-content">
                <div class="session-card-title">${signInButtonLabel}</div>
                <div class="session-card-body" id="googleSignInHelp">${Utils.sanitize(signInButtonHelp)}</div>
              </div>
              <div class="session-card-action"><i class="ph ph-arrow-right"></i></div>
            </button>
          ` : `
            <div class="session-card session-card-unavailable">
              <div class="session-card-icon"><i class="ph ph-warning-circle"></i></div>
              <div class="session-card-content">
                <div class="session-card-title">Account sign-in unavailable</div>
                <div class="session-card-body">LibriQ cannot reach account services right now.</div>
              </div>
            </div>
          `}

          ${!loading && !hasUser && firebase.initialized && firebase.available ? `
            <div class="session-auth-tabs" role="tablist" aria-label="Email account options">
              <button class="session-auth-tab active" type="button" data-auth-mode="signin" aria-selected="true">Sign in with Email</button>
              <button class="session-auth-tab" type="button" data-auth-mode="signup" aria-selected="false">Create account</button>
            </div>
            <form class="session-email-form" id="emailAuthForm" novalidate>
              <div class="session-reset-mode" id="sessionResetMode" hidden>
                <input class="form-input" id="sessionResetEmailInput" type="email" placeholder="Email address" autocomplete="email" />
                <button class="btn btn-primary" id="sessionResetSubmit" type="button">
                  <i class="ph ph-envelope-simple"></i>
                  <span>Send reset email</span>
                </button>
                <button class="btn btn-secondary" id="sessionResetBackBtn" type="button">
                  Back to sign in
                </button>
              </div>
              <div class="session-signin-mode" id="sessionSigninMode">
                <input class="form-input" id="sessionEmailInput" type="email" placeholder="Email address" autocomplete="email" required />
                <input class="form-input" id="sessionPasswordInput" type="password" placeholder="Password" autocomplete="current-password" required />
                <p class="session-auth-error" id="sessionAuthError" role="alert" hidden></p>
                <button class="btn btn-primary" id="emailAuthSubmit" type="submit">
                  <i class="ph ph-envelope-simple"></i>
                  <span>Sign in with Email</span>
                </button>
                <button class="session-link-btn" id="forgotPasswordLink" type="button">Forgot password?</button>
              </div>
            </form>
          ` : ''}

          ${browserHelp ? `
            <div class="session-help-callout">
              <div class="session-help-copy">${Utils.sanitize(browserHelp)}</div>
              <a class="session-help-link" href="${openInBrowserHref}" target="_blank" rel="noopener noreferrer">Open in browser</a>
            </div>
          ` : ''}

          ${hasUser ? `
            <button class="session-link-btn" id="switchAccountBtn" type="button">
              Use another account
            </button>
          ` : ''}

          <p class="session-fineprint">
            Account mode keeps existing backup and sync behavior. Offline mode remains available when the network is unavailable.
          </p>
        </div>
      </section>
      <div class="session-fallback-modal" id="sessionFallbackModal" role="dialog" aria-modal="true" aria-labelledby="sessionFallbackTitle" hidden>
        <div class="session-fallback-card">
          <div class="session-card-icon"><i class="ph ph-wifi-slash"></i></div>
          <div>
            <h2 class="session-fallback-title" id="sessionFallbackTitle">No internet connection</h2>
            <p class="session-fallback-copy">LibriQ needs internet to sign in and sync your library. You can continue offline on this device, and your changes will stay local.</p>
          </div>
          <div class="session-fallback-actions">
            <button class="btn btn-primary" id="authRetryBtn" type="button"><i class="ph ph-arrow-clockwise"></i> Retry</button>
            <button class="btn btn-secondary" id="fallbackOfflineBtn" type="button"><i class="ph ph-house-simple"></i> Continue offline</button>
          </div>
        </div>
      </div>
    </div>`;

  const continueOffline = () => {
    Navigation.setSessionPreference('offline');
    window.LibriqSyncBeta?.pauseForOffline?.();
    Navigation.goTo('dashboard');
  };
  const hideFallback = () => {
    const modal = document.getElementById('sessionFallbackModal');
    if (!modal) return;
    modal.hidden = true;
    fallbackState.modalVisible = false;
    fallbackState.dismissAt = Date.now();
  };
  const showFallback = () => {
    const modal = document.getElementById('sessionFallbackModal');
    if (!modal) return;
    modal.hidden = false;
    fallbackState.modalVisible = true;
    fallbackState.dismissAt = 0;
  };
  const clearFallbackTimer = () => {
    if (fallbackState.timer) {
      window.clearTimeout(fallbackState.timer);
      fallbackState.timer = null;
    }
  };
  const shouldShowBlockingOffline = () => {
    if (typeof navigator === 'undefined') return false;
    if (navigator.onLine !== false) return false;
    if (document.visibilityState && document.visibilityState !== 'visible') return false;
    if (Navigation.getSessionPreference?.() === 'offline') return false;
    if (Navigation.getCurrentSessionMode?.() === 'offline') return false;
    return true;
  };
  const scheduleFallback = (reason = 'network') => {
    fallbackState.lastRequestedAt = Date.now();
    clearFallbackTimer();
    if (!shouldShowBlockingOffline()) {
      hideFallback();
      return;
    }
    fallbackState.timer = window.setTimeout(() => {
      fallbackState.timer = null;
      if (!shouldShowBlockingOffline()) {
        hideFallback();
        return;
      }
      if (Date.now() - fallbackState.lastRequestedAt < offlineStabilityMs) return;
      showFallback();
    }, offlineCheckDelayMs);
  };
  const reconcileFallback = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
      clearFallbackTimer();
      hideFallback();
      renderSessionChoicePage();
      return;
    }
    scheduleFallback('recheck');
  };
  const showAuthError = (message) => {
    const errorEl = document.getElementById('sessionAuthError');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
  };
  const clearAuthError = () => {
    const errorEl = document.getElementById('sessionAuthError');
    if (!errorEl) return;
    errorEl.textContent = '';
    errorEl.hidden = true;
  };
  const retryAuth = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      scheduleFallback('retry');
      return;
    }
    renderSessionChoicePage();
  };
  const getCurrentEmail = () => String(document.getElementById('sessionEmailInput')?.value || document.getElementById('sessionResetEmailInput')?.value || '').trim();
  const showResetMode = () => {
    const resetEmail = document.getElementById('sessionResetEmailInput');
    const currentEmail = getCurrentEmail();
    clearAuthError();
    if (resetEmail && currentEmail) resetEmail.value = currentEmail;
    Navigation.setEmailAuthMode?.('reset');
  };
  const showSigninMode = () => {
    Navigation.setEmailAuthMode?.('signin');
    clearAuthError();
  };

  if (!firebase.initialized) {
    hideFallback();
  } else if (authUnavailable && !loading) {
    scheduleFallback('initial');
  } else {
    hideFallback();
  }

  document.getElementById('googleContinueBtn')?.addEventListener('click', () => {
    Navigation.setSessionPreference('google');
    window.LibriqSyncBeta?.maybeAutoEnable?.('account-continue');
    Navigation.goTo('dashboard');
  });

  document.getElementById('googleSignInBtn')?.addEventListener('click', async () => {
    if (inAppBrowser) {
      Utils.toast('Google sign-in may not work inside this app browser.', 'warning');
      return;
    }
    try {
      await LibriqFirebase.signInWithGoogle();
      Navigation.setSessionPreference('google');
      window.LibriqSyncBeta?.maybeAutoEnable?.('google-sign-in');
      Utils.toast('Sync is on. Your books will update across signed-in devices.', 'success');
      Navigation.goTo('dashboard');
    } catch (err) {
      console.warn('[Libriq] Google sign-in failed:', {
        code: err?.code || '',
        message: err?.message || '',
        details: err?.details || null,
      });
      const message = getFriendlyAuthError(err, 'google');
      if (isAuthNetworkError(err)) {
        showFallback();
      } else {
        Utils.toast(message, getAuthToastType(err));
      }
    }
  });

  Utils.$$('.session-auth-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      clearAuthError();
      Navigation.setEmailAuthMode?.(btn.dataset.authMode);
    });
  });

  document.getElementById('forgotPasswordLink')?.addEventListener('click', () => {
    const email = String(document.getElementById('sessionEmailInput')?.value || '').trim();
    if (email && document.getElementById('sessionResetEmailInput')) {
      document.getElementById('sessionResetEmailInput').value = email;
    }
    showResetMode();
  });

  document.getElementById('sessionResetBackBtn')?.addEventListener('click', () => {
    showSigninMode();
  });

  document.getElementById('sessionResetSubmit')?.addEventListener('click', async () => {
    const email = String(document.getElementById('sessionResetEmailInput')?.value || '').trim();
    try {
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw Object.assign(new Error('Enter a valid email address.'), { code: 'auth/invalid-email' });
      }
      await LibriqFirebase.sendPasswordResetToEmail(email);
      Utils.toast('Password reset email sent if an account exists for that address.', 'success');
      showSigninMode();
    } catch (err) {
      const code = String(err?.code || '').toLowerCase();
      const message = code.includes('invalid-email')
        ? 'Enter a valid email address.'
        : code.includes('too-many-requests')
          ? 'Please wait before trying again.'
          : code.includes('network-request-failed')
            ? 'Check your connection and try again.'
            : 'Something went wrong. Please try again.';
      showAuthError(message);
    }
  });

  document.getElementById('emailAuthForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAuthError();
    const form = event.currentTarget;
    const mode = form?.getAttribute('data-auth-mode') === 'signup' ? 'signup' : 'signin';
    const email = document.getElementById('sessionEmailInput')?.value || '';
    const password = document.getElementById('sessionPasswordInput')?.value || '';
    const submit = document.getElementById('emailAuthSubmit');
    submit?.setAttribute('disabled', '');
    try {
      if (mode === 'signup') {
        await LibriqFirebase.createAccountWithEmail(email, password);
      } else {
        await LibriqFirebase.signInWithEmail(email, password);
      }
      Navigation.setSessionPreference('account');
      window.LibriqSyncBeta?.maybeAutoEnable?.(mode === 'signup' ? 'email-sign-up' : 'email-sign-in');
      Utils.toast('Sync is on. Your books will update across signed-in devices.', 'success');
      Navigation.goTo('dashboard');
    } catch (err) {
      console.warn('[Libriq] Email auth failed:', { code: err?.code || '', message: err?.message || '' });
      const message = getFriendlyAuthError(err, mode);
      if (isAuthNetworkError(err)) showFallback();
      showAuthError(message);
    } finally {
      submit?.removeAttribute('disabled');
    }
  });

  document.getElementById('authRetryBtn')?.addEventListener('click', retryAuth);
  document.getElementById('fallbackOfflineBtn')?.addEventListener('click', continueOffline);

  document.getElementById('switchAccountBtn')?.addEventListener('click', async () => {
    try {
      await LibriqFirebase.signOut();
      Navigation.setSessionPreference('prompt');
      Navigation.clearAccountResume?.();
    } catch (err) {
      const code = String(err?.code || err?.message || '');
      const cancelled = code.includes('popup-closed-by-user') || code.includes('popup-blocked');
      Utils.toast(cancelled ? 'Sign-out was cancelled.' : 'Could not switch accounts right now.', 'error');
    }
  });

  if (inAppBrowser) {
    Navigation.setEmailAuthMode?.('signup');
  }

  // Interactive Live Book Search Preview handlers
  const demoInput = document.getElementById('sessionDemoInput');
  const demoSpinner = document.getElementById('sessionDemoSpinner');
  const demoResults = document.getElementById('sessionDemoResults');
  let demoDebounceTimer = null;

  const triggerSignupForBook = (title) => {
    Navigation.setEmailAuthMode?.('signup');
    const form = document.getElementById('emailAuthForm');
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('sessionEmailInput')?.focus();
    Utils.toast?.(`Create an account to save "${title}" to your library!`, 'info');
  };

  const executeDemoSearch = async (query) => {
    const q = (query || '').trim();
    if (!q || q.length < 2) {
      if (demoResults) {
        demoResults.innerHTML = '';
        demoResults.hidden = true;
      }
      return;
    }
    if (demoSpinner) demoSpinner.hidden = false;
    try {
      const results = await BookAPI.searchBooks(q);
      if (demoSpinner) demoSpinner.hidden = true;
      if (!demoResults) return;
      if (!results || results.length === 0) {
        demoResults.innerHTML = `<div class="session-demo-empty">No books found for "${Utils.sanitize(q)}". Try another title!</div>`;
        demoResults.hidden = false;
        return;
      }
      const topBooks = results.slice(0, 3);
      demoResults.innerHTML = topBooks.map(b => {
        const cover = b.coverUrl
          ? `<img src="${Utils.sanitize(b.coverUrl)}" class="session-demo-book-cover" alt="" onerror="this.src='./icons/icon-192.png'" />`
          : `<div class="session-demo-book-cover-placeholder"><i class="ph ph-book"></i></div>`;
        return `
          <div class="session-demo-book-card" data-title="${Utils.sanitize(b.title)}">
            ${cover}
            <div class="session-demo-book-info">
              <div class="session-demo-book-title">${Utils.sanitize(b.title)}</div>
              <div class="session-demo-book-author">${Utils.sanitize(b.author || 'Unknown')}</div>
              <div class="session-demo-book-meta">${b.year ? b.year : ''}${b.pageCount ? ` • ${b.pageCount} pages` : ''}</div>
            </div>
            <button type="button" class="btn btn-sm btn-primary session-demo-save-btn" data-title="${Utils.sanitize(b.title)}">
              <i class="ph ph-plus"></i> Save
            </button>
          </div>
        `;
      }).join('');
      demoResults.hidden = false;

      demoResults.querySelectorAll('.session-demo-save-btn, .session-demo-book-card').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const title = el.dataset.title || el.closest('.session-demo-book-card')?.dataset.title;
          if (title) triggerSignupForBook(title);
        });
      });
    } catch (err) {
      if (demoSpinner) demoSpinner.hidden = true;
      console.warn('[Libriq] Demo search error:', err);
    }
  };

  demoInput?.addEventListener('input', (e) => {
    if (demoDebounceTimer) clearTimeout(demoDebounceTimer);
    const val = e.target.value;
    demoDebounceTimer = setTimeout(() => executeDemoSearch(val), 350);
  });

  Utils.$$('.session-demo-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.query;
      if (demoInput) demoInput.value = q;
      executeDemoSearch(q);
    });
  });

  if (!window.LibriqSessionFallback.listenersAttached) {
    window.addEventListener('online', reconcileFallback);
    window.addEventListener('offline', () => scheduleFallback('offline-event'));
    document.addEventListener('visibilitychange', reconcileFallback);
    window.LibriqSessionFallback.listenersAttached = true;
  }
}

function isAuthNetworkError(err) {
  const code = String(err?.code || err?.message || '').toLowerCase();
  return code.includes('network-request-failed') || code.includes('unavailable') || code.includes('failed to fetch') || (typeof navigator !== 'undefined' && navigator.onLine === false);
}

function getAuthToastType(err) {
  const code = String(err?.code || err?.message || '').toLowerCase();
  if (code.includes('popup-closed-by-user')) return 'info';
  if (code.includes('popup-blocked') || code.includes('disallowed')) return 'warning';
  return 'error';
}

function getFriendlyAuthError(err, mode = 'signin') {
  const code = String(err?.code || err?.message || '').toLowerCase();
  if (code.includes('invalid-email')) return 'Enter a valid email address.';
  if (code.includes('wrong-password') || code.includes('invalid-credential') || code.includes('user-not-found')) return 'The email or password does not look right.';
  if (code.includes('weak-password')) return 'Choose a stronger password with at least 6 characters.';
  if (code.includes('email-already-in-use') || code.includes('account-exists-with-different-credential')) return 'An account already exists for that email. Try signing in instead.';
  if (code.includes('missing-password')) return 'Enter your password to continue.';
  if (code.includes('network-request-failed') || code.includes('unavailable') || code.includes('failed to fetch')) return 'LibriQ cannot reach account services right now.';
  if (code.includes('unauthorized-domain')) return 'This domain is not authorized for account sign-in yet.';
  if (code.includes('invalid-api-key')) return 'Account sign-in is not configured correctly for this build.';
  if (code.includes('configuration-not-found')) return 'Account setup is incomplete for this build.';
  if (code.includes('popup-blocked')) return 'Your browser blocked the sign-in popup.';
  if (code.includes('popup-closed-by-user')) return 'Sign-in was cancelled.';
  if (code.includes('disallowed-useragent')) return 'Google sign-in may not work inside this app browser. Open LibriQ in Chrome or Safari.';
  if (mode === 'signup') return 'Could not create the account right now.';
  return 'Could not sign in right now.';
}

Navigation.exportData = exportData;
Navigation.promptImportData = promptImportData;
Navigation.importDataFromFile = importDataFromFile;
Navigation.clearAllData = clearAllData;

function getDisplayNameForAccount(user) {
  return resolveAccountDisplayName(Storage.getProfile(), user);
}

function _friendlyAuthMessage(err) {
  const code = String(err?.code || '').trim();
  const map = {
    'auth/too-many-requests': 'Please wait before trying again.',
    'auth/requires-recent-login': 'For security, please sign in again and retry.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/user-disabled': 'This account is disabled.',
    'auth/network-request-failed': 'Check your connection and try again.',
  };
  try { console.warn('[LibriQ] Auth action failed:', code || 'unknown'); } catch {}
  return map[code] || 'Something went wrong. Please try again.';
}

function _buildRestoreSummaryMarkup(label, summary, extra = []) {
  return `
    <section class="whats-new-item">
      <div class="whats-new-item-title">${Utils.sanitize(label)}</div>
      <p>
        Books: ${summary.bookCount}<br>
        Reading: ${summary.readingCount}<br>
        Finished: ${summary.finishedCount}<br>
        Notes: ${summary.notesCount}<br>
        Quotes: ${summary.quotesCount}
        ${summary.activityCount !== null ? `<br>Activity: ${summary.activityCount}` : ''}
        ${summary.lastUpdatedAt ? `<br>Last updated: ${Utils.formatDate(summary.lastUpdatedAt)}` : ''}
        ${extra.map(line => `<br>${Utils.sanitize(line)}`).join('')}
      </p>
    </section>`;
}

async function openCloudRestorePreview() {
  const firebase = LibriqFirebase.getState();
  if (!firebase.user || !LibriqFirebase.hasFirestore()) return restoreFromCloud();
  const currentBooks = Storage.getBooks();
  let docData = null;
  try {
    const snap = await LibriqFirebase.readBackupDoc(['users', firebase.user.uid, 'backups', 'current']);
    if (!snap?.exists?.()) {
      Utils.toast('No cloud backup found yet.', 'info');
      return;
    }
    docData = LibriqCloudBackup.normalizeBackup(snap.data());
  } catch (err) {
    console.error('[Libriq] Cloud restore preview failed:', err);
    Utils.toast('Could not load the cloud backup preview.', 'error');
    return;
  }
  if (!docData) {
    Utils.toast('The cloud backup data is invalid.', 'error');
    return;
  }
  const currentSummary = _summarizeLibrary(currentBooks, Storage.getActivityLog?.() || []);
  const cloudSummary = _summarizeLibrary(docData.data.books, docData.data.activity);
  const cloudIsOlder = Boolean(currentSummary.lastUpdatedAt && docData.updatedAt && new Date(docData.updatedAt).getTime() < new Date(currentSummary.lastUpdatedAt).getTime());
  const modal = document.getElementById('backupImportModal');
  const body = document.getElementById('backupImportBody');
  const title = document.getElementById('backupImportTitle');
  const subtitle = document.getElementById('backupImportSubtitle');
  const cancel = document.getElementById('backupImportCancel');
  const merge = document.getElementById('backupImportMerge');
  const replace = document.getElementById('backupImportReplace');
  const close = document.getElementById('closeBackupImport');
  if (!modal || !body || !title || !subtitle || !cancel || !merge || !replace || !close) return;
  title.textContent = 'Review before restoring';
  subtitle.textContent = 'Cloud restore replaces the library on this device. Export a JSON copy first if you want a safety copy.';
  body.innerHTML = `
    <div class="whats-new-list">
      ${_buildRestoreSummaryMarkup('Local library', currentSummary)}
      ${_buildRestoreSummaryMarkup('Cloud backup', cloudSummary, [
        `Backup version: ${Utils.sanitize(String(docData.backupVersion ?? 'Unknown'))}`,
        `App version: ${Utils.sanitize(String(docData.appVersion ?? docData.version ?? 'Unknown'))}`,
        `Schema: ${Utils.sanitize(String(docData.schemaVersion ?? 'Unknown'))}`,
        `Device ID: ${Utils.sanitize(String(docData.deviceId ?? 'Unknown'))}`,
      ])}
      ${cloudIsOlder ? `<section class="whats-new-item"><div class="whats-new-item-title">Warning</div><p>This cloud backup may be older than your current library.</p></section>` : ''}
    </div>
  `;
  merge.textContent = 'Export local JSON first';
  replace.textContent = 'Restore cloud backup';
  cancel.textContent = 'Cancel';
  modal.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';

  const cleanup = () => {
    modal.setAttribute('hidden', '');
    document.body.style.overflow = '';
    replace.onclick = null;
    merge.onclick = null;
    cancel.onclick = null;
    close.onclick = null;
    modal.onclick = null;
  };

  merge.onclick = async () => {
    await exportData();
  };
  replace.onclick = async () => {
    cleanup();
    await confirmAndRestoreCloud(docData, currentSummary);
  };
  cancel.onclick = cleanup;
  close.onclick = cleanup;
  modal.onclick = (e) => { if (e.target === modal) cleanup(); };
}

async function openCloudMergePreview() {
  const firebase = LibriqFirebase.getState();
  if (!firebase.user || !LibriqFirebase.hasFirestore()) return;

  const currentBooks = Storage.getBooks();
  let docData = null;
  try {
    const snap = await LibriqFirebase.readBackupDoc(['users', firebase.user.uid, 'backups', 'current']);
    if (!snap?.exists?.()) {
      Utils.toast('No cloud backup found yet.', 'info');
      return;
    }
    docData = LibriqCloudBackup.normalizeBackup(snap.data());
  } catch (err) {
    console.error('[Libriq] Cloud merge preview failed:', err);
    Utils.toast('Could not load the cloud backup preview.', 'error');
    return;
  }
  if (!docData) {
    Utils.toast('Couldn\'t read this cloud backup. Your local data was not changed.', 'error');
    return;
  }

  const currentSummary = _summarizeLibrary(currentBooks, Storage.getActivityLog?.() || []);
  const cloudSummary = _summarizeLibrary(docData.data.books, docData.data.activity);
  const plan = LibriqCloudBackup.previewMerge(docData, currentBooks);
  const modal = document.getElementById('backupImportModal');
  const body = document.getElementById('backupImportBody');
  const title = document.getElementById('backupImportTitle');
  const subtitle = document.getElementById('backupImportSubtitle');
  const cancel = document.getElementById('backupImportCancel');
  const merge = document.getElementById('backupImportMerge');
  const replace = document.getElementById('backupImportReplace');
  const close = document.getElementById('closeBackupImport');
  if (!modal || !body || !title || !subtitle || !cancel || !merge || !replace || !close) return;

  title.textContent = 'Review before merging';
  subtitle.textContent = 'Merge adds safe cloud-only items without replacing local conflicts. Export a JSON copy first if you want a safety copy.';
  body.innerHTML = `
    <div class="whats-new-list">
      ${_buildRestoreSummaryMarkup('Local library', currentSummary)}
      ${_buildRestoreSummaryMarkup('Cloud backup', cloudSummary, [
        `Backup version: ${Utils.sanitize(String(docData.backupVersion ?? 'Unknown'))}`,
        `App version: ${Utils.sanitize(String(docData.appVersion ?? docData.version ?? 'Unknown'))}`,
        `Schema: ${Utils.sanitize(String(docData.schemaVersion ?? 'Unknown'))}`,
        `Device ID: ${Utils.sanitize(String(docData.deviceId ?? 'Unknown'))}`,
      ])}
      <section class="whats-new-item">
        <div class="whats-new-item-title">Merge result preview</div>
        <p>
          New books to add from cloud: ${plan.newBooksToAdd.length}<br>
          Local books kept: ${plan.localBooksKept.length}<br>
          Duplicates skipped: ${plan.duplicatesSkipped.length}<br>
          Possible conflicts: ${plan.conflicts.length}<br>
          Notes to add safely: ${plan.notesToAdd}<br>
          Quotes to add safely: ${plan.quotesToAdd}<br>
          Items unchanged: ${plan.itemsUnchanged}
        </p>
      </section>
      ${plan.conflicts.length ? `<section class="whats-new-item"><div class="whats-new-item-title">Conflict notice</div><p>Some items looked different on this device and in your cloud backup. LibriQ kept this device's version for now.</p></section>` : ''}
    </div>
  `;
  merge.textContent = 'Merge cloud with this device';
  replace.textContent = 'Export local JSON first';
  cancel.textContent = 'Cancel';
  modal.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';

  const cleanup = () => {
    modal.setAttribute('hidden', '');
    document.body.style.overflow = '';
    replace.onclick = null;
    merge.onclick = null;
    cancel.onclick = null;
    close.onclick = null;
    modal.onclick = null;
  };

  replace.onclick = async () => {
    await exportData();
  };
  merge.onclick = async () => {
    cleanup();
    await confirmAndMergeCloud(docData, plan, currentSummary);
  };
  cancel.onclick = cleanup;
  close.onclick = cleanup;
  modal.onclick = (e) => { if (e.target === modal) cleanup(); };
}

async function confirmAndRestoreCloud(docData, currentSummary) {
  const proceed = confirm('Restoring will replace this device\'s current library with the cloud backup. Continue?');
  if (!proceed) return;
  if (currentSummary.bookCount > 0 && !confirm('This cloud restore will overwrite your local library. Export first if you want a safety copy. Restore now?')) {
    return;
  }
  await restoreFromCloud(docData);
}

async function confirmAndMergeCloud(docData, plan, currentSummary) {
  const proceed = confirm('Merge cloud with this device? LibriQ will add safe cloud-only items and keep this device\'s version for conflicts.');
  if (!proceed) return;
  if (currentSummary.bookCount > 0 && !confirm('Export first if you want a safety copy. Apply the merge now?')) {
    return;
  }
  await mergeCloudWithThisDevice(docData, plan);
}

async function exportData() {
  const result = importExportService.exportCurrentLibrary();
  const { payload: data, exportedAt, activityCount } = result;
  Storage.saveBackupMeta?.({ lastExportedAt: exportedAt });
  Storage.addActivityEvent?.(Storage.buildActivityEvent?.('backup_exported', null, { itemCount: data.data.books.length, activityCount }, 'export'));
  Utils.toast('Library exported', 'success');
  if (document.getElementById('mainContent')?.querySelector('#importLibraryInput')) {
    try {
      Navigation.renderCurrentPage?.();
    } catch (uiErr) {
      console.warn('[Libriq] Export UI refresh failed:', uiErr);
    }
  }
}

async function mergeCloudWithThisDevice(docData, plan) {
  const firebase = LibriqFirebase.getState();
  if (!firebase.user) {
    Utils.toast('Sign in first to merge from cloud.', 'warning');
    return;
  }
  if (!LibriqFirebase.hasFirestore()) {
    Utils.toast('Cloud backup is unavailable right now.', 'error');
    return;
  }
  if (!docData?.data || !Array.isArray(docData.data.books)) {
    Utils.toast('Couldn\'t read this cloud backup. Your local data was not changed.', 'error');
    return;
  }

  const result = LibriqCloudBackup.applyMerge(docData, plan);
  if (!result.ok) {
    Utils.toast('Couldn\'t read this cloud backup. Your local data was not changed.', 'error');
    return;
  }
  Utils.toast('Cloud merge completed', 'success');
  try {
    Navigation.updateBadges?.();
    Navigation.renderCurrentPage?.();
  } catch (uiErr) {
    console.warn('[Libriq] Cloud merge UI refresh failed:', uiErr);
  }
}

async function backupToCloud() {
  const firebase = LibriqFirebase.getState();
  if (!firebase.user) {
    Utils.toast('Sign in first to use cloud backup.', 'warning');
    return;
  }
  if (!LibriqFirebase.hasFirestore()) {
    Utils.toast('Cloud backup is unavailable right now.', 'error');
    return;
  }
  const ok = await LibriqCloudBackup.runBackup('manual', false);
  if (ok) {
    Utils.toast('Cloud backup saved', 'success');
    try {
      Navigation.renderCurrentPage?.();
    } catch (uiErr) {
      console.warn('[LibriQ] Cloud backup UI refresh failed:', uiErr);
    }
  }
}

async function restoreFromCloud(preloadedDoc = null) {
  const firebase = LibriqFirebase.getState();
  if (!firebase.user) {
    Utils.toast('Sign in first to restore from cloud.', 'warning');
    return;
  }
  if (!LibriqFirebase.hasFirestore()) {
    Utils.toast('Cloud backup is unavailable right now.', 'error');
    return;
  }

  const currentBooks = Storage.getBooks();
  let docData = preloadedDoc;
  try {
    if (!docData) {
      const snap = await LibriqFirebase.readBackupDoc(['users', firebase.user.uid, 'backups', 'current']);
      if (!snap?.exists?.()) {
        Utils.toast('No cloud backup found yet.', 'info');
        return;
      }
      docData = LibriqCloudBackup.normalizeBackup(snap.data());
    }
    if (!docData) {
      Utils.toast("Couldn't restore this backup. Your local data was not changed.", 'error');
      return;
    }
  } catch (err) {
    console.error('[Libriq] Cloud restore failed:', err);
    const code = String(err?.code || err?.message || '').toLowerCase();
    if (code.includes('permission-denied')) {
      Utils.toast('You do not have permission to read this cloud backup.', 'error');
    } else if (code.includes('unauthenticated') || code.includes('authentication-required')) {
      Utils.toast('Please sign in again before restoring your cloud backup.', 'error');
    } else if (code.includes('unavailable') || code.includes('network')) {
      Utils.toast('Network error while loading cloud backup.', 'error');
    } else {
      Utils.toast("Couldn't restore this backup. Your local data was not changed.", 'error');
    }
    return;
  }

  const data = docData.data;
  let result;
  try {
    result = LibriqCloudBackup.applyRestore(docData);
  } catch (err) {
    console.error('[Libriq] Cloud restore local replacement failed:', err);
    Utils.toast("Couldn't restore this backup. Your local data was not changed.", 'error');
    return;
  }
  if (!result?.ok) {
    Utils.toast("Couldn't restore this backup. Your local data was not changed.", 'error');
    return;
  }

  Utils.toast('Cloud backup restored', 'success');
  try {
    Navigation.updateBadges?.();
    Navigation.renderCurrentPage?.();
  } catch (uiErr) {
    console.warn('[Libriq] Cloud restore UI refresh failed:', uiErr);
  }
}

function promptImportData() {
  document.getElementById('importLibraryInput')?.click();
}

async function importDataFromFile(file) {
  if (!file) return;
  const result = await importExportService.parseImportFile(file);
  if (!result.ok && result.reason === 'invalid-json') {
    Utils.toast('That file is not valid JSON.', 'error');
    return;
  }
  if (!result.ok) {
    Utils.toast('That file is not a valid LibriQ backup.', 'error');
    return;
  }
  _openImportPreview(file, result.payload);
}

function _openImportPreview(file, parsed) {
  const modal = document.getElementById('backupImportModal');
  const body = document.getElementById('backupImportBody');
  const title = document.getElementById('backupImportTitle');
  const subtitle = document.getElementById('backupImportSubtitle');
  const cancel = document.getElementById('backupImportCancel');
  const merge = document.getElementById('backupImportMerge');
  const replace = document.getElementById('backupImportReplace');
  const close = document.getElementById('closeBackupImport');
  if (!modal || !body || !title || !subtitle || !cancel || !merge || !replace || !close) return;

  const importedBooks = Array.isArray(parsed?.data?.books) ? parsed.data.books : [];
  const importedActivity = Array.isArray(parsed?.data?.activity) ? parsed.data.activity.filter(Boolean) : [];
  const localBooks = Storage.getBooks();
  const backupVersion = parsed?.version || 'Unknown';
  const exportedAt = parsed?.exportedAt || null;

  title.textContent = 'Import Backup Preview';
  subtitle.textContent = 'Choose how to apply this backup to your local library.';
  body.innerHTML = `
    <div class="whats-new-list">
      <section class="whats-new-item">
        <div class="whats-new-item-title">Backup details</div>
        <p>Exported: ${exportedAt ? Utils.formatDate(exportedAt) : 'Unknown'}<br>Version: ${Utils.sanitize(backupVersion)}</p>
      </section>
      <section class="whats-new-item">
        <div class="whats-new-item-title">Contents</div>
        <p>${importedBooks.length} book${importedBooks.length === 1 ? '' : 's'} in backup<br>${localBooks.length} current local book${localBooks.length === 1 ? '' : 's'}<br>${importedActivity.length} backup activity event${importedActivity.length === 1 ? '' : 's'}</p>
      </section>
      <section class="whats-new-item">
        <div class="whats-new-item-title">What happens next</div>
        <p>Replace swaps your local library with the backup. Merge keeps your current data and combines obvious duplicates safely.</p>
      </section>
    </div>
  `;

  const cleanup = () => {
    modal.setAttribute('hidden', '');
    document.body.style.overflow = '';
    title.textContent = 'Import Backup';
    subtitle.textContent = 'Review the backup before choosing how to apply it.';
    replace.textContent = 'Replace local library';
    merge.textContent = 'Merge with current library';
    cancel.textContent = 'Cancel';
    replace.onclick = null;
    merge.onclick = null;
    cancel.onclick = null;
    close.onclick = null;
    modal.onclick = null;
    const input = document.getElementById('importLibraryInput');
    if (input) input.value = '';
  };

  const runImport = (replaceMode) => {
    cleanup();
    _applyImportedBackup(parsed, replaceMode);
  };

  replace.textContent = 'Replace local library';
  merge.textContent = 'Merge with current library';
  cancel.textContent = 'Cancel';
  modal.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';

  replace.onclick = () => runImport(true);
  merge.onclick = () => runImport(false);
  cancel.onclick = cleanup;
  close.onclick = cleanup;
  modal.onclick = (e) => { if (e.target === modal) cleanup(); };
}

function _applyImportedBackup(parsed, replaceMode) {
  const importedBooks = Array.isArray(parsed?.data?.books) ? parsed.data.books.map(book => createBook(book)) : [];
  const importedActivity = Array.isArray(parsed?.data?.activity) ? parsed.data.activity.filter(Boolean) : [];
  const currentBooks = Storage.getBooks();
  const mergedBooks = replaceMode ? importedBooks : _mergeBooksForImport(currentBooks, importedBooks);
  const mergedActivity = replaceMode ? importedActivity : _mergeActivityById(Storage.getActivityLog?.() || [], importedActivity);

  Storage.saveBooks(mergedBooks);

  if (parsed.data.profile && typeof parsed.data.profile === 'object') {
    Storage.saveProfile(parsed.data.profile);
  }
  if (parsed.data.goals && typeof parsed.data.goals === 'object') {
    Storage.saveGoals(parsed.data.goals);
  }
  if (parsed.data.streak && typeof parsed.data.streak === 'object') {
    Storage.saveStreak?.(parsed.data.streak);
  }
  Storage.replaceActivityLog?.(mergedActivity);
  Storage.addActivityEvent?.(Storage.buildActivityEvent?.('backup_imported', null, { itemCount: mergedBooks.length, activityCount: mergedActivity.length, mode: replaceMode ? 'replace' : 'merge' }, 'import'));

  Utils.toast(replaceMode ? 'Library replaced from backup' : 'Library merged from backup', 'success');
  try {
    Navigation.updateBadges?.();
    Navigation.renderCurrentPage?.();
  } catch (uiErr) {
    console.warn('[Libriq] Import UI refresh failed:', uiErr);
  }
}

function _dangerConfirmElements() {
  return {
    modal: document.getElementById('dangerConfirmModal'),
    title: document.getElementById('dangerConfirmTitle'),
    body: document.getElementById('dangerConfirmBody'),
    bodyCopy: document.getElementById('dangerConfirmBodyCopy'),
    prompt: document.getElementById('dangerConfirmPrompt'),
    input: document.getElementById('dangerConfirmInput'),
    action: document.getElementById('dangerConfirmAction'),
    cancel: document.getElementById('dangerConfirmCancel'),
    close: document.getElementById('closeDangerConfirm'),
    error: document.getElementById('dangerConfirmError'),
  };
}

function confirmDangerAction({ title, body, prompt, expected, actionLabel }) {
  return new Promise((resolve) => {
    const els = _dangerConfirmElements();
    if (!els.modal || !els.title || !els.body || !els.bodyCopy || !els.prompt || !els.input || !els.action || !els.cancel || !els.close || !els.error) {
      console.error('[Libriq] Danger modal unavailable for confirmation dialog:', title);
      resolve(false);
      return;
    }
    els.title.textContent = title;
    els.bodyCopy.textContent = body;
    els.prompt.textContent = prompt;
    els.error.hidden = true;
    els.error.textContent = '';
    els.input.value = '';
    els.input.placeholder = prompt;
    els.action.textContent = actionLabel;
    els.action.disabled = true;
    const cleanup = (result = false) => {
      els.modal.setAttribute('hidden', '');
      document.body.style.overflow = '';
      els.input.oninput = null;
      window.removeEventListener('keydown', onKeyDown);
      els.cancel.onclick = null;
      els.close.onclick = null;
      els.action.onclick = null;
      els.modal.onclick = null;
      resolve(result);
    };
    els.input.oninput = () => {
      els.error.hidden = true;
      els.action.disabled = els.input.value.trim() !== expected;
    };
    els.cancel.onclick = () => cleanup(false);
    els.close.onclick = () => cleanup(false);
    els.action.onclick = async () => {
      try {
        if (els.input.value.trim() !== expected) return;
        cleanup(true);
      } catch (err) {
        console.warn('[Libriq] Danger action failed:', err);
        els.error.textContent = 'Something went wrong. Please try again.';
        els.error.hidden = false;
        els.action.disabled = false;
      }
    };
    els.modal.onclick = (e) => {
      if (e.target === els.modal) cleanup(false);
    };
    function onKeyDown(e) {
      if (e.key === 'Escape' && !els.modal.hasAttribute('hidden')) cleanup(false);
    }
    window.addEventListener('keydown', onKeyDown);
    els.modal.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => els.input.focus(), 50);
  });
}

async function clearLocalCache() {
  const confirmed = await confirmDangerAction({
    title: 'Clear local cache?',
    body: 'This will remove this device\'s local cache only. It will not delete your cloud library or account.',
    prompt: 'Type CLEAR CACHE to continue',
    expected: 'CLEAR CACHE',
    actionLabel: 'Clear cache',
  });
  if (!confirmed) return;
  const firebase = LibriqFirebase.getState();
  if (firebase.user?.uid) {
    Storage.clearAccountScopedData?.(firebase.user.uid, { keys: ['BOOKS', 'ACTIVITY', 'STREAK', 'GOALS', 'BACKUP', 'CLOUD_BACKUP', 'SYNC_META', 'SYNC_TOMBSTONES'] });
  }
  Utils.toast('Local cache cleared.', 'info');
  Navigation.renderCurrentPage?.();
  Navigation.updateBadges?.();
}

async function confirmDeleteLibraryData() {
  const firebase = LibriqFirebase.getState();
  if (!firebase.user?.uid) {
    Utils.toast('Sign in first to delete library data.', 'warning');
    return;
  }
  const confirmed = await confirmDangerAction({
    title: 'Delete library data?',
    body: 'This permanently removes your books, notes, progress, activity, streak, and cloud backup for this account. This cannot be undone.',
    prompt: 'Type DELETE to continue',
    expected: 'DELETE',
    actionLabel: 'Delete library data',
  });
  if (!confirmed) return;
  try {
    window.LibriqSyncBeta?.detachForAccountSwitch?.('delete-library-data');
    await LibriqFirebase.deleteCurrentUserLibraryData();
    Storage.clearAccountScopedData?.(firebase.user.uid, { keys: ['BOOKS', 'ACTIVITY', 'STREAK', 'GOALS', 'BACKUP', 'CLOUD_BACKUP', 'SYNC_META', 'SYNC_TOMBSTONES'] });
    Navigation.updateBadges?.();
    Navigation.renderCurrentPage?.();
    Utils.toast('Library data deleted.', 'success');
  } catch (err) {
    console.warn('[Libriq] Delete library data failed:', err);
    Utils.toast('Could not delete library data right now.', 'error');
  }
}

async function confirmDeleteAccount() {
  const firebase = LibriqFirebase.getState();
  if (!firebase.user?.uid) {
    Utils.toast('Sign in first to delete your account.', 'warning');
    return;
  }
  const confirmed = await confirmDangerAction({
    title: 'Delete account?',
    body: 'This permanently deletes your LibriQ account and all reading data connected to it. This cannot be undone.',
    prompt: 'Type DELETE ACCOUNT to continue',
    expected: 'DELETE ACCOUNT',
    actionLabel: 'Delete account',
  });
  if (!confirmed) return;
  try {
    window.LibriqSyncBeta?.detachForAccountSwitch?.('delete-account');
    await LibriqFirebase.deleteCurrentUserAccount();
    Storage.clearAccountScopedData?.(firebase.user.uid, { keys: ['BOOKS', 'ACTIVITY', 'PROFILE', 'STREAK', 'GOALS', 'BACKUP', 'CLOUD_BACKUP', 'SYNC_META', 'SYNC_TOMBSTONES'] });
    Storage.clearActiveAccountScope?.();
    Navigation.goTo('session');
    Utils.toast('Account deleted.', 'success');
  } catch (err) {
    const code = String(err?.code || '');
    if (code.includes('requires-recent-login')) {
      Utils.toast('For security, please sign in again before deleting your account.', 'warning');
    } else {
      console.warn('[Libriq] Delete account failed:', err);
      Utils.toast('Could not delete your account right now.', 'error');
    }
  }
}

function clearAllData() {
  return clearLocalCache();
}
