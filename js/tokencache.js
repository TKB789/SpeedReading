/* tokencache.js — cache tokenized books in IndexedDB so reopening a book skips
 * re-tokenization (the main source of reopen lag). Tokens are stored in a COMPACT
 * tuple form (~4x smaller than the object form) and rehydrated on load.
 *
 * Why IndexedDB, not localStorage: a tokenized book is large (Huck Finn ≈ 10 MB
 * as objects, ≈ 2 MB compact; Moby Dick ≈ 4 MB compact). localStorage caps at
 * 5–10 MB TOTAL per origin, so it can't hold even one. IndexedDB's quota is a
 * share of free disk (hundreds of MB+), so many books fit.
 *
 * Eviction: least-recently-opened books are removed first when the cache exceeds
 * a soft byte budget, or when a write fails for quota.
 *
 * API (all async, Promise-based; degrade gracefully if IndexedDB is unavailable):
 *   TokenCache.get(bookId)            -> tokens[] | null
 *   TokenCache.put(bookId, tokens)    -> true | false
 *   TokenCache.touch(bookId)          -> updates lastOpened
 *   TokenCache.remove(bookId)         -> void
 *   TokenCache.list()                 -> [{id, bytes, lastOpened}]
 */
(function (root) {
  'use strict';

  var DB_NAME = 'rsvp-reader';
  var STORE = 'tokens';
  var RAW_STORE = 'rawbooks';            // raw book JSON, so reopen skips the network
  var VERSION = 2;
  var SOFT_BUDGET = 120 * 1024 * 1024;   // ~120 MB soft cap before LRU eviction
  var dbPromise = null;

  function available() {
    try { return typeof indexedDB !== 'undefined' && indexedDB != null; }
    catch (e) { return false; }
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!available()) { reject(new Error('no-indexeddb')); return; }
      var req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('lastOpened', 'lastOpened', { unique: false });
        }
        if (!db.objectStoreNames.contains(RAW_STORE)) {
          db.createObjectStore(RAW_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('idb-open-failed')); };
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDB().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }
  function txStore(store, mode) {
    return openDB().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }
  function reqToPromise(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  // ---- compact token encoding ----------------------------------------------
  // A token is {text, chapter, para, pivot, hold, paraEnd, chapterEnd}. Stored as
  // [text, chapter, para, pivot, hold(0 means 1), endFlags(1=paraEnd,2=chapterEnd)].
  function encode(tokens) {
    var out = new Array(tokens.length);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      out[i] = [t.text, t.chapter, t.para, t.pivot,
                t.hold === 1 ? 0 : t.hold,
                (t.paraEnd ? 1 : 0) | (t.chapterEnd ? 2 : 0)];
    }
    return out;
  }
  function decode(rows) {
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out[i] = {
        text: r[0], chapter: r[1], para: r[2], pivot: r[3],
        hold: r[4] === 0 ? 1 : r[4],
        paraEnd: (r[5] & 1) !== 0,
        chapterEnd: (r[5] & 2) !== 0
      };
    }
    return out;
  }

  // ---- public API -----------------------------------------------------------
  function get(bookId) {
    return tx('readonly')
      .then(function (os) { return reqToPromise(os.get(bookId)); })
      .then(function (rec) {
        if (!rec || !rec.rows) return null;
        // bump lastOpened (fire-and-forget) so LRU reflects this open
        touch(bookId);
        return decode(rec.rows);
      })
      .catch(function () { return null; });   // any failure → cache miss
  }

  function put(bookId, tokens) {
    var rows = encode(tokens);
    var rec = { id: bookId, rows: rows, lastOpened: Date.now(),
                bytes: approxBytes(rows) };
    return tx('readwrite')
      .then(function (os) { return reqToPromise(os.put(rec)); })
      .then(function () { return evictIfNeeded(); })
      .then(function () { return true; })
      .catch(function () {
        // Likely quota — evict oldest and retry once.
        return evictOldest().then(function () {
          return tx('readwrite').then(function (os) {
            return reqToPromise(os.put(rec));
          }).then(function () { return true; }).catch(function () { return false; });
        }).catch(function () { return false; });
      });
  }

  function touch(bookId) {
    return tx('readwrite').then(function (os) {
      return reqToPromise(os.get(bookId)).then(function (rec) {
        if (!rec) return;
        rec.lastOpened = Date.now();
        return reqToPromise(os.put(rec));
      });
    }).catch(function () {});
  }

  function remove(bookId) {
    return tx('readwrite')
      .then(function (os) { return reqToPromise(os['delete'](bookId)); })
      .catch(function () {});
  }

  function list() {
    return tx('readonly').then(function (os) {
      return reqToPromise(os.getAll()).then(function (recs) {
        return (recs || []).map(function (r) {
          return { id: r.id, bytes: r.bytes || 0, lastOpened: r.lastOpened || 0 };
        });
      });
    }).catch(function () { return []; });
  }

  function approxBytes(rows) {
    // cheap estimate: ~2 bytes/char of text + ~24 bytes overhead per token
    var n = 0;
    for (var i = 0; i < rows.length; i++) n += (rows[i][0] ? rows[i][0].length * 2 : 0) + 24;
    return n;
  }

  // Evict the single least-recently-opened book.
  function evictOldest() {
    return list().then(function (items) {
      if (!items.length) return;
      items.sort(function (a, b) { return a.lastOpened - b.lastOpened; });
      return remove(items[0].id);
    });
  }

  // Evict oldest books until total bytes are under the soft budget.
  function evictIfNeeded() {
    return list().then(function (items) {
      var total = items.reduce(function (n, it) { return n + it.bytes; }, 0);
      if (total <= SOFT_BUDGET) return;
      items.sort(function (a, b) { return a.lastOpened - b.lastOpened; });
      var chain = Promise.resolve();
      for (var i = 0; i < items.length && total > SOFT_BUDGET; i++) {
        (function (it) { chain = chain.then(function () { return remove(it.id); }); })(items[i]);
        total -= items[i].bytes;
      }
      return chain;
    });
  }

  // ---- raw book JSON cache --------------------------------------------------
  // Store the parsed book object so reopening skips the network fetch entirely.
  // Separate from the token cache: this is the small source JSON; tokens are the
  // large derived form. A raw hit lets us tokenize the first chapter and paint
  // without waiting on the network even before the token cache is populated.
  function getRaw(bookId) {
    return txStore(RAW_STORE, 'readonly')
      .then(function (os) { return reqToPromise(os.get(bookId)); })
      .then(function (rec) { return rec && rec.book ? rec.book : null; })
      .catch(function () { return null; });
  }
  function putRaw(bookId, book) {
    return txStore(RAW_STORE, 'readwrite')
      .then(function (os) { return reqToPromise(os.put({ id: bookId, book: book })); })
      .then(function () { return true; })
      .catch(function () { return false; });   // best-effort; failure just means we refetch
  }

  root.TokenCache = {
    available: available,
    get: get, put: put, touch: touch, remove: remove, list: list,
    getRaw: getRaw, putRaw: putRaw,
    _encode: encode, _decode: decode   // exposed for tests
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TokenCache;
})(typeof self !== 'undefined' ? self : this);
