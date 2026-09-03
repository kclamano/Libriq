import {
  LIBRIQ,
  createBook,
  createProfile,
  SEED_BOOKS,
} from './data.js';

export const Storage = (() => {
  const INSTALL_KEY = 'libriq_installed';

  const DATA_KEYS = {
    BOOKS:   'libriq_books',
    PROFILE: 'libriq_profile',
    STREAK:  'libriq_streak',
    GOALS:   'libriq_goals',
    ACTIVITY:'libriq_activity',
    DEVICE_ID: 'libriq_device_id',
    BACKUP:  'libriq_backup_meta',
    CLOUD_BACKUP: 'libriq_cloud_backup_meta',
    SYNC_META: 'libriq_sync_meta',
    SYNC_TOMBSTONES: 'libriq_sync_delete_tombstones',
  };
  const ACTIVE_UID_KEY = 'libriq_active_account_uid';
  const SCOPED_DATA_KEYS = new Set(['BOOKS', 'PROFILE', 'STREAK', 'GOALS', 'ACTIVITY', 'BACKUP', 'CLOUD_BACKUP', 'SYNC_META', 'SYNC_TOMBSTONES']);
  let activeUid = null;
  let scopeInitialized = false;
  let bootstrapped = false;

  const DEFAULTS = {
    profile: () => createProfile({ name: 'Reader', theme: 'dark' }),
    goals:   () => ({ yearly: 12, year: new Date().getFullYear() }),
    streak:  () => ({ current: 0, longest: 0, lastRead: null }),
    books:   () => [],
    activity: () => [],
    backup: () => ({ lastExportedAt: null }),
    cloudBackup: () => ({ lastCloudBackupAt: null, bookCount: null, activityCount: null, deviceId: null, backupVersion: null, appVersion: null, schemaVersion: null, createdAt: null, updatedAt: null, notesCount: null, quotesCount: null, lastLocalUpdatedAt: null, syncReady: false }),
    syncMeta: () => ({ pending: false, pendingSince: null, pendingReason: null, pendingBookIds: [], pendingDeleteIds: [], lastSyncAttemptAt: null, lastSyncSuccessAt: null, lastError: null }),
    syncTombstones: () => ({}),
  };

  function _read(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn(`[Libriq] Storage read error (${key}):`, e);
      return null;
    }
  }

  function _write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn(`[Libriq] Storage write error (${key}):`, e);
      return false;
    }
  }

  function _writeDefaults() {
    Object.keys(DATA_KEYS).forEach(_migrateLegacyLocalValue);

    const rawProfile = _read(_key('PROFILE'));
    if (!rawProfile || typeof rawProfile !== 'object' || !rawProfile.name) {
      _write(_key('PROFILE'), DEFAULTS.profile());
    } else {
      _write(_key('PROFILE'), { ...DEFAULTS.profile(), ...rawProfile });
    }

    const rawGoals = _read(_key('GOALS'));
    if (!rawGoals || typeof rawGoals.yearly !== 'number') {
      _write(_key('GOALS'), DEFAULTS.goals());
    }

    const rawStreak = _read(_key('STREAK'));
    if (!rawStreak || typeof rawStreak.current !== 'number') {
      _write(_key('STREAK'), DEFAULTS.streak());
    }

    const rawBooks = _read(_key('BOOKS'));
    if (!Array.isArray(rawBooks)) {
      _write(_key('BOOKS'), DEFAULTS.books());
    }

    const rawActivity = _read(_key('ACTIVITY'));
    if (!Array.isArray(rawActivity)) {
      _write(_key('ACTIVITY'), DEFAULTS.activity());
    }

    const rawBackup = _read(_key('BACKUP'));
    if (!rawBackup || typeof rawBackup !== 'object') {
      _write(_key('BACKUP'), DEFAULTS.backup());
    }

    const rawCloudBackup = _read(_key('CLOUD_BACKUP'));
    if (!rawCloudBackup || typeof rawCloudBackup !== 'object') {
      _write(_key('CLOUD_BACKUP'), DEFAULTS.cloudBackup());
    }
  }

  function bootstrap() {
    if (bootstrapped) return;
    _ensureScopeInitialized();
    const isFirstLaunch = !localStorage.getItem(INSTALL_KEY);

    if (isFirstLaunch) {
      localStorage.setItem(INSTALL_KEY, new Date().toISOString());
      _writeDefaults();
    } else {
      _writeDefaults();
    }
    getDeviceId();
    bootstrapped = true;
  }

  function _ensureScopeInitialized() {
    if (scopeInitialized) return;
    activeUid = localStorage.getItem(ACTIVE_UID_KEY) || null;
    scopeInitialized = true;
  }

  function getActiveAccountUid() {
    _ensureScopeInitialized();
    return activeUid;
  }

  function setActiveAccountUid(uid) {
    _ensureScopeInitialized();
    const nextUid = uid ? String(uid) : null;
    const changed = activeUid !== nextUid;
    const previousUid = activeUid;
    activeUid = nextUid;
    if (changed && nextUid) {
      _migrateLegacyScopedData(previousUid, nextUid);
    }
    if (activeUid) localStorage.setItem(ACTIVE_UID_KEY, activeUid);
    else localStorage.removeItem(ACTIVE_UID_KEY);
    _writeDefaults();
    if (changed) _dispatchChange('storage:scope-changed', { uid: activeUid });
    return changed;
  }

  function clearActiveAccountScope() {
    return setActiveAccountUid(null);
  }

  function clearAccountScopedData(uid = undefined, options = {}) {
    _ensureScopeInitialized();
    const targetUid = uid === undefined ? activeUid : uid;
    const nextUid = targetUid ? String(targetUid) : null;
    if (!nextUid) return false;
    const keys = Array.isArray(options.keys) && options.keys.length
      ? new Set(options.keys)
      : SCOPED_DATA_KEYS;
    Object.entries(DATA_KEYS).forEach(([name, key]) => {
      if (!keys.has(name)) return;
      localStorage.removeItem(_userKey(nextUid, key));
    });
    return true;
  }

  function getDeviceId() {
    _ensureScopeInitialized();
    let deviceId = localStorage.getItem(DATA_KEYS.DEVICE_ID);
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem(DATA_KEYS.DEVICE_ID, deviceId);
    }
    return deviceId;
  }

  function _userKey(uid, key) {
    const suffix = key.replace(/^libriq_/, '');
    return `libriq:users:${uid}:${suffix}`;
  }

  function _localKey(key) {
    const suffix = key.replace(/^libriq_/, '');
    return `libriq:local:${suffix}`;
  }

  function _key(name) {
    _ensureScopeInitialized();
    const base = DATA_KEYS[name];
    if (!SCOPED_DATA_KEYS.has(name)) return base;
    return activeUid ? _userKey(activeUid, base) : _localKey(base);
  }

  function _migrateLegacyLocalValue(name) {
    if (activeUid || !SCOPED_DATA_KEYS.has(name)) return;
    const scopedKey = _key(name);
    if (localStorage.getItem(scopedKey) !== null) return;
    const legacyValue = localStorage.getItem(DATA_KEYS[name]);
    if (legacyValue !== null) localStorage.setItem(scopedKey, legacyValue);
  }

  function _mergeActivityEvents(currentEvents, incomingEvents) {
    const byId = new Map();
    const pushEvent = (event, fallbackPrefix) => {
      if (!event || typeof event !== 'object') return;
      const normalized = {
        ...event,
        id: String(event.id || `${fallbackPrefix}_${event.timestamp || new Date().toISOString()}_${Math.random().toString(36).slice(2, 8)}`),
        type: String(event.type || 'unknown'),
        timestamp: event.timestamp || event.createdAt || new Date().toISOString(),
        createdAt: event.createdAt || event.timestamp || new Date().toISOString(),
        updatedAt: event.updatedAt || event.timestamp || event.createdAt || new Date().toISOString(),
        sourceDeviceId: event.sourceDeviceId || event.deviceId || null,
      };
      byId.set(normalized.id, normalized);
    };
    (Array.isArray(currentEvents) ? currentEvents : []).forEach(event => pushEvent(event, 'current'));
    (Array.isArray(incomingEvents) ? incomingEvents : []).forEach(event => pushEvent(event, 'incoming'));
    return Array.from(byId.values()).sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  }

  function _migrateLegacyScopedData(previousUid, nextUid) {
    if (!nextUid) return;
    const migrateNames = ['ACTIVITY', 'BOOKS', 'PROFILE', 'STREAK', 'GOALS', 'BACKUP', 'CLOUD_BACKUP', 'SYNC_META', 'SYNC_TOMBSTONES'];
    migrateNames.forEach((name) => {
      const targetKey = _userKey(nextUid, DATA_KEYS[name]);
      const localKey = _localKey(DATA_KEYS[name]);
      const legacyValue = _read(localKey);
      if (legacyValue === null || legacyValue === undefined) return;
      const currentTarget = _read(targetKey);

      if (name === 'ACTIVITY') {
        const merged = _mergeActivityEvents(Array.isArray(currentTarget) ? currentTarget : [], Array.isArray(legacyValue) ? legacyValue : []);
        _write(targetKey, merged);
        return;
      }

      if (currentTarget === null || currentTarget === undefined || (Array.isArray(currentTarget) && currentTarget.length === 0) || (typeof currentTarget === 'object' && Object.keys(currentTarget).length === 0)) {
        _write(targetKey, legacyValue);
      }
    });
    if (previousUid !== nextUid) {
      _write(_userKey(nextUid, DATA_KEYS.ACTIVITY), _mergeActivityEvents(_read(_userKey(nextUid, DATA_KEYS.ACTIVITY)) || [], _read(_localKey(DATA_KEYS.ACTIVITY)) || []));
    }
  }

  function getSyncReadiness() {
    const books = getBooks();
    const activity = getActivityLog();
    const hasDeviceId = Boolean(getDeviceId());
    const hasUpdatedAtCoverage = books.length === 0 || books.every(book => Boolean(book && (book.updatedAt || book.createdAt)));
    const hasDeletedAtSupport = books.every(book => book.deletedAt === undefined || book.deletedAt === null || typeof book.deletedAt === 'string');
    const cloudMeta = getCloudBackupMeta();
    const hasBackupMetadata = Boolean(cloudMeta && (cloudMeta.backupVersion !== null || cloudMeta.appVersion !== null || cloudMeta.createdAt !== null || cloudMeta.updatedAt !== null));
    return {
      hasDeviceId,
      hasUpdatedAtCoverage,
      hasDeletedAtSupport,
      hasBackupMetadata,
      syncReady: false,
      notesCount: books.reduce((sum, book) => sum + (book?.notes ? 1 : 0), 0),
      quotesCount: books.reduce((sum, book) => sum + (Array.isArray(book?.quotes) ? book.quotes.length : 0), 0),
      activityCount: activity.length,
    };
  }

  function getBooks() {
    const data = _read(_key('BOOKS'));
    if (!Array.isArray(data)) {
      _write(_key('BOOKS'), []);
      return [];
    }
    return data;
  }

  function saveBooks(books) {
    return _write(_key('BOOKS'), books);
  }

  function addBook(bookData) {
    const books = getBooks();
    const book  = createBook(bookData);
    books.unshift(book);
    saveBooks(books);
    _dispatchChange('book:added', book);
    return book;
  }

  function updateBook(id, updates) {
    const books = getBooks();
    const idx   = books.findIndex(b => b.id === id);
    if (idx === -1) return null;
    books[idx] = { ...books[idx], ...updates, updatedAt: new Date().toISOString() };
    saveBooks(books);
    _dispatchChange('book:updated', books[idx]);
    return books[idx];
  }

  function removeBook(id) {
    const books    = getBooks();
    const filtered = books.filter(b => b.id !== id);
    saveBooks(filtered);
    _dispatchChange('book:removed', { id });
    return true;
  }

  function getBookById(id) {
    return getBooks().find(b => b.id === id) || null;
  }

  function getBooksByStatus(status) {
    return getBooks().filter(b => b.status === status);
  }

  function _getEffectiveFinishedDate(book) {
    if (!book || book.status !== LIBRIQ.STATUS.FINISHED) return null;
    const candidates = [
      book.dateFinished,
      book.completedAt,
      book.finishedAt,
      book.updatedAt,
      book.createdAt,
      book.dateAdded,
    ];
    for (const value of candidates) {
      const time = new Date(value || 0).getTime();
      if (Number.isFinite(time) && time > 0) return new Date(time).toISOString();
    }
    return null;
  }

  function toggleFavorite(id) {
    const book = getBookById(id);
    if (!book) return null;
    return updateBook(id, { isFavorite: !book.isFavorite });
  }

  function getActivityLog() {
    const data = _read(_key('ACTIVITY'));
    if (!Array.isArray(data)) {
      _write(_key('ACTIVITY'), DEFAULTS.activity());
      return [];
    }
    return data.filter(Boolean).slice(-500);
  }

  function saveActivityLog(events) {
    if (!Array.isArray(events)) return false;
    const result = _write(_key('ACTIVITY'), events.slice(-500));
    if (result) _dispatchChange('activity:updated', { count: Math.min(events.length, 500) });
    return result;
  }

  function clearActivityLog() {
    return saveActivityLog([]);
  }

  function buildActivityEvent(type, book, payload = {}, source = null) {
    if (!type) return null;
    const timestamp = new Date().toISOString();
    return {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      bookId: book?.id || null,
      bookTitle: book?.title || null,
      bookAuthor: book?.author || null,
      coverUrl: book?.coverUrl || null,
      status: book?.status || null,
      message: payload?.message || payload?.label || null,
      payload: payload && typeof payload === 'object' ? payload : {},
      source: source || book?.source || 'system',
      sourceDeviceId: getDeviceId(),
    };
  }

  function addActivityEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const current = getActivityLog();
    const normalized = {
      id: event.id || `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: String(event.type || 'unknown'),
      timestamp: event.timestamp || new Date().toISOString(),
      createdAt: event.createdAt || event.timestamp || new Date().toISOString(),
      updatedAt: event.updatedAt || event.timestamp || event.createdAt || new Date().toISOString(),
      bookId: event.bookId || null,
      bookTitle: event.bookTitle || null,
      bookAuthor: event.bookAuthor || null,
      coverUrl: event.coverUrl || null,
      status: event.status || null,
      message: event.message || event.label || null,
      payload: event.payload && typeof event.payload === 'object' ? event.payload : {},
      source: ['api', 'manual', 'import', 'system'].includes(event.source) ? event.source : 'system',
      sourceDeviceId: event.sourceDeviceId || event.deviceId || null,
    };
    if (current.some(existing => existing?.id === normalized.id)) {
      return current.find(existing => existing?.id === normalized.id) || normalized;
    }
    current.push(normalized);
    saveActivityLog(current);
    return normalized;
  }

  function setActivityLog(events) {
    if (!Array.isArray(events)) return false;
    return saveActivityLog(events.slice(-500));
  }

  function replaceActivityLog(events) {
    if (!Array.isArray(events)) return false;
    return saveActivityLog(events.slice(-500));
  }

  function getProfile() {
    const data = _read(_key('PROFILE'));
    if (!data || typeof data !== 'object') {
      const fresh = DEFAULTS.profile();
      _write(_key('PROFILE'), fresh);
      return fresh;
    }
    const displayName = data.displayName || data.name || DEFAULTS.profile().name;
    return { ...DEFAULTS.profile(), ...data, name: displayName, displayName };
  }

  function getBackupMeta() {
    const data = _read(_key('BACKUP'));
    if (!data || typeof data !== 'object') {
      const fresh = DEFAULTS.backup();
      _write(_key('BACKUP'), fresh);
      return fresh;
    }
    return { ...DEFAULTS.backup(), ...data };
  }

  function getCloudBackupMeta() {
    const data = _read(_key('CLOUD_BACKUP'));
    if (!data || typeof data !== 'object') {
      const fresh = DEFAULTS.cloudBackup();
      _write(_key('CLOUD_BACKUP'), fresh);
      return fresh;
    }
    return { ...DEFAULTS.cloudBackup(), ...data };
  }

  function saveCloudBackupMeta(updates) {
    const current = getCloudBackupMeta();
    const updated = { ...current, ...(updates && typeof updates === 'object' ? updates : {}) };
    _write(_key('CLOUD_BACKUP'), updated);
    return updated;
  }

  function saveBackupMeta(updates) {
    const current = getBackupMeta();
    const updated = { ...current, ...(updates && typeof updates === 'object' ? updates : {}) };
    _write(_key('BACKUP'), updated);
    return updated;
  }

  function saveProfile(updates) {
    const current = getProfile();
    const next = updates && typeof updates === 'object' ? updates : {};
    const displayName = next.displayName || next.name || current.displayName || current.name;
    const updated = {
      ...current,
      ...next,
      name: displayName,
      displayName,
      updatedAt: new Date().toISOString(),
      createdAt: current.createdAt || current.joinDate || new Date().toISOString(),
      joinDate: current.joinDate || current.createdAt || new Date().toISOString(),
    };
    _write(_key('PROFILE'), updated);
    _dispatchChange('profile:updated', updated);
    return updated;
  }

  function getGoals() {
    const data = _read(_key('GOALS'));
    if (!data || typeof data.yearly !== 'number') {
      const fresh = DEFAULTS.goals();
      _write(_key('GOALS'), fresh);
      return fresh;
    }
    return data;
  }

  function saveGoals(goals) {
    if (!goals || typeof goals.yearly !== 'number' || goals.yearly < 1) return false;
    const result = _write(_key('GOALS'), goals);
    if (result) _dispatchChange('goals:updated', goals);
    return result;
  }

  function getStreak() {
    const data = _read(_key('STREAK'));
    if (!data || typeof data.current !== 'number') {
      const fresh = DEFAULTS.streak();
      _write(_key('STREAK'), fresh);
      return fresh;
    }
    return data;
  }

  function updateStreak() {
    const streak    = getStreak();
    const today     = new Date().toDateString();
    const lastRead  = streak.lastRead ? new Date(streak.lastRead).toDateString() : null;
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    if (lastRead === today) return streak;

    streak.current  = lastRead === yesterday ? streak.current + 1 : 1;
    streak.longest  = Math.max(streak.longest, streak.current);
    streak.lastRead = new Date().toISOString();
    _write(_key('STREAK'), streak);
    _dispatchChange('streak:updated', streak);
    return streak;
  }

  function getSyncMeta() {
    const data = _read(_key('SYNC_META'));
    if (!data || typeof data !== 'object') {
      const fresh = DEFAULTS.syncMeta();
      _write(_key('SYNC_META'), fresh);
      return fresh;
    }
    return { ...DEFAULTS.syncMeta(), ...data };
  }

  function saveSyncMeta(updates) {
    const current = getSyncMeta();
    const updated = { ...current, ...(updates && typeof updates === 'object' ? updates : {}) };
    if (!Array.isArray(updated.pendingBookIds)) updated.pendingBookIds = [];
    if (!Array.isArray(updated.pendingDeleteIds)) updated.pendingDeleteIds = [];
    _write(_key('SYNC_META'), updated);
    return updated;
  }

  function clearSyncMeta() {
    const cleared = DEFAULTS.syncMeta();
    _write(_key('SYNC_META'), cleared);
    return cleared;
  }

  function getSyncTombstones() {
    const data = _read(_key('SYNC_TOMBSTONES'));
    return data && typeof data === 'object' ? data : {};
  }

  function saveSyncTombstones(tombstones) {
    const next = tombstones && typeof tombstones === 'object' ? tombstones : {};
    _write(_key('SYNC_TOMBSTONES'), next);
    return next;
  }

  function saveStreak(streak) {
    if (!streak || typeof streak !== 'object') return false;
    const normalized = {
      ...DEFAULTS.streak(),
      ...streak,
      current: Number(streak.current) || 0,
      longest: Number(streak.longest) || 0,
      lastRead: streak.lastRead || null,
    };
    const result = _write(_key('STREAK'), normalized);
    if (result) _dispatchChange('streak:updated', normalized);
    return result;
  }

  function resetAll() {
    _ensureScopeInitialized();
    Object.entries(DATA_KEYS).forEach(([name, key]) => {
      localStorage.removeItem(activeUid && SCOPED_DATA_KEYS.has(name) ? _userKey(activeUid, key) : key);
    });
    _writeDefaults();
    getDeviceId();
    _dispatchChange('reset', {});
  }

  function getStats() {
    const books    = getBooks();
    const thisYear = new Date().getFullYear();
    const finishedBooks = books.filter(b => b.status === LIBRIQ.STATUS.FINISHED);
    const finishedBooksWithDates = finishedBooks
      .map(book => ({ book, finishedDate: _getEffectiveFinishedDate(book) }))
      .filter(entry => entry.finishedDate);

    const total     = books.length;
    const reading   = books.filter(b => b.status === LIBRIQ.STATUS.READING).length;
    const finished  = finishedBooks.length;
    const wishlist  = books.filter(b => b.status === LIBRIQ.STATUS.WISHLIST).length;
    const favorites = books.filter(b => b.isFavorite).length;

    const finishedThisYear = finishedBooksWithDates.filter(({ finishedDate }) =>
      new Date(finishedDate).getFullYear() === thisYear
    ).length;

    const totalPages = finishedBooks
      .reduce((sum, b) => sum + (b.pageCount || 0), 0);

    const pagesByMonth = Array(12).fill(0);
    finishedBooksWithDates.forEach(({ book, finishedDate }) => {
      const d = new Date(finishedDate);
      if (d.getFullYear() === thisYear) pagesByMonth[d.getMonth()] += (book.pageCount || 0);
    });

    const rated     = books.filter(b => typeof b.rating === 'number' && b.rating > 0);
    const avgRating = rated.length
      ? (rated.reduce((sum, b) => sum + b.rating, 0) / rated.length).toFixed(1)
      : null;

    const genreMap = {};
    books.forEach(b => {
      (b.genres || []).forEach(g => { genreMap[g] = (genreMap[g] || 0) + 1; });
    });
    const topGenres = Object.entries(genreMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const monthlyData = Array(12).fill(0);
    finishedBooksWithDates.forEach(({ finishedDate }) => {
      const d = new Date(finishedDate);
      if (d.getFullYear() === thisYear) monthlyData[d.getMonth()]++;
    });

    return {
      total, reading, finished, wishlist, favorites,
      finishedThisYear, totalPages, avgRating, ratedCount: rated.length,
      topGenres, monthlyData, pagesByMonth,
    };
  }

  function _dispatchChange(event, detail) {
    window.dispatchEvent(new CustomEvent(`libriq:${event}`, { detail }));
  }

  return {
    bootstrap,
    resetAll,
    getActiveAccountUid, setActiveAccountUid, clearActiveAccountScope, clearAccountScopedData,
    getBooks, saveBooks, addBook, updateBook, removeBook,
    getBookById, getBooksByStatus, toggleFavorite,
    getProfile, saveProfile,
    getBackupMeta, saveBackupMeta,
    getCloudBackupMeta, saveCloudBackupMeta,
    getSyncMeta, saveSyncMeta, clearSyncMeta,
    getSyncTombstones, saveSyncTombstones,
    getDeviceId,
    getSyncReadiness,
    getGoals, saveGoals,
    getStreak, updateStreak, saveStreak,
    getActivityLog, addActivityEvent, clearActivityLog, buildActivityEvent, setActivityLog, replaceActivityLog,
    getStats,
  };
})();
