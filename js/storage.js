/*
 * storage.js — all persistence. Honest limits, surfaced in the UI:
 *   - Everything is in localStorage: per-browser, per-device, no server, no sync.
 *   - navigator.storage.persist() only REDUCES automatic eviction under storage
 *     pressure. It does NOT survive a manual "clear site data".
 *   - Export/Import is the only durable backup and the only cross-device move.
 */
(function (root) {
  'use strict';
  var PREFIX = 'rsvp:';
  var KEY_SETTINGS = PREFIX + 'settings';
  var KEY_PROGRESS = PREFIX + 'progress:';   // + bookId
  var KEY_LIBRARY  = PREFIX + 'library';     // user-uploaded books index
  var KEY_BOOK     = PREFIX + 'book:';       // + bookId (full parsed book)

  function lsGet(k, fallback) {
    try { var v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { return false; } // quota or private-mode failure
  }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // Ask the browser to keep our data through storage pressure. Best-effort.
  function requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      return navigator.storage.persist().catch(function () { return false; });
    }
    return Promise.resolve(false);
  }
  function isPersisted() {
    if (navigator.storage && navigator.storage.persisted) {
      return navigator.storage.persisted().catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  var DEFAULT_SETTINGS = { wpm: 400, theme: 'light' };
  function getSettings() {
    var s = lsGet(KEY_SETTINGS, {});
    return Object.assign({}, DEFAULT_SETTINGS, s);
  }
  function saveSettings(s) { return lsSet(KEY_SETTINGS, s); }

  // Progress per book: { index, chapter, updated }
  function getProgress(bookId) { return lsGet(KEY_PROGRESS + bookId, null); }
  function saveProgress(bookId, index, chapter) {
    return lsSet(KEY_PROGRESS + bookId, { index: index, chapter: chapter, updated: Date.now() });
  }
  function clearProgress(bookId) { lsDel(KEY_PROGRESS + bookId); }

  // User-uploaded library: array of { id, title, author, wordCount }
  function getUserLibrary() { return lsGet(KEY_LIBRARY, []); }
  function getUserBook(bookId) { return lsGet(KEY_BOOK + bookId, null); }
  function saveUserBook(book) {
    var lib = getUserLibrary().filter(function (b) { return b.id !== book.id; });
    lib.push({ id: book.id, title: book.title, author: book.author, wordCount: book.wordCount });
    lib.sort(function (a, b) { return a.title.localeCompare(b.title); });
    var okBook = lsSet(KEY_BOOK + book.id, book);
    var okLib = lsSet(KEY_LIBRARY, lib);
    return okBook && okLib;
  }
  function deleteUserBook(bookId) {
    lsDel(KEY_BOOK + bookId);
    lsDel(KEY_PROGRESS + bookId);
    var lib = getUserLibrary().filter(function (b) { return b.id !== bookId; });
    lsSet(KEY_LIBRARY, lib);
  }

  // Export everything under our prefix to one JSON object.
  function exportAll() {
    var data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0) data[k] = localStorage.getItem(k);
    }
    return { app: 'rsvp-reader', version: 1, exported: Date.now(), data: data };
  }
  // Import: merge or replace. Returns counts.
  function importAll(obj, replace) {
    if (!obj || obj.app !== 'rsvp-reader' || !obj.data) throw new Error('Not a valid backup file.');
    if (replace) {
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) toRemove.push(k);
      }
      toRemove.forEach(lsDel);
    }
    var n = 0;
    Object.keys(obj.data).forEach(function (k) {
      if (k.indexOf(PREFIX) === 0) { localStorage.setItem(k, obj.data[k]); n++; }
    });
    return n;
  }

  var api = {
    requestPersistence: requestPersistence, isPersisted: isPersisted,
    getSettings: getSettings, saveSettings: saveSettings,
    getProgress: getProgress, saveProgress: saveProgress, clearProgress: clearProgress,
    getUserLibrary: getUserLibrary, getUserBook: getUserBook,
    saveUserBook: saveUserBook, deleteUserBook: deleteUserBook,
    exportAll: exportAll, importAll: importAll
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Store = api;
})(typeof self !== 'undefined' ? self : this);
