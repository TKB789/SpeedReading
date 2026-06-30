/* library.js — library view: load manifest + user books, search, add, data. */
(function () {
  'use strict';

  // If the user has a last-read book and didn't explicitly ask for the library
  // (?home), jump straight back into it. The reader's "Library" link uses ?home.
  var wantsHome = new URLSearchParams(window.location.search).has('home');
  if (!wantsHome) {
    var last = Store.getLastBook();
    if (last && last.id) {
      window.location.replace('reader.html?book=' + encodeURIComponent(last.id) +
        '&src=' + (last.src || 'repo'));
      return; // stop running the library; we're navigating away
    }
  }

  var grid = document.getElementById('grid');
  var emptyEl = document.getElementById('empty');
  var searchEl = document.getElementById('search');
  var books = [];

  // Theme
  var themeBtn = document.getElementById('themeBtn');
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }
  var settings = Store.getSettings();
  applyTheme(settings.theme);
  themeBtn.addEventListener('click', function () {
    settings = Store.getSettings();
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    Store.saveSettings(settings);
    applyTheme(settings.theme);
  });

  Store.requestPersistence();

  function bookHref(id, kind) { return 'reader.html?book=' + encodeURIComponent(id) + '&src=' + kind; }

  // Sorting helpers ---------------------------------------------------------
  function titleKey(b) {
    var t = (b.title || '').toLowerCase().trim();
    t = t.replace(/^(the|a|an)\s+/, '');
    t = t.replace(/^[^a-z0-9]+/, '');
    return t;
  }
  function authorKey(b) {
    var a = (b.author || '').toLowerCase().trim();
    if (!a) return '~';
    var parts = a.split(/\s+/);
    var surname = parts[parts.length - 1];
    return surname + ' ' + parts.slice(0, -1).join(' ');
  }
  function recentKey(b) {
    var p = Store.getProgress(b.id);
    return p && p.updated ? p.updated : 0;
  }

  function sortBooks(list, mode) {
    var arr = list.slice();
    if (mode === 'author') {
      arr.sort(function (a, b) { return authorKey(a).localeCompare(authorKey(b)) || titleKey(a).localeCompare(titleKey(b)); });
    } else if (mode === 'recent') {
      arr.sort(function (a, b) { return recentKey(b) - recentKey(a) || titleKey(a).localeCompare(titleKey(b)); });
    } else {
      arr.sort(function (a, b) { return titleKey(a).localeCompare(titleKey(b)); });
    }
    return arr;
  }

  function render(list) {
    grid.innerHTML = '';
    if (!list.length) { emptyEl.hidden = false; return; }
    emptyEl.hidden = true;
    list.forEach(function (b) {
      var card = document.createElement('div');
      card.className = 'card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.dataset.bookId = b.id;
      var coverStyle = b.cover ? ' style="background-image:url(' + b.cover + ')"' : '';
      var progress = Store.getProgress(b.id);
      // Progress is stored as a content coordinate plus a cached `pct` (computed
      // by the reader once the book is fully loaded). Use that cached pct; if it
      // isn't known yet, show no percentage rather than a wrong one.
      var pct = progress && progress.pct != null ? progress.pct : null;
      var isLoading = !!b.loading;
      if (isLoading) card.classList.add('loading-book');
      card.innerHTML =
        (b._user ? '<button class="del" title="Remove" aria-label="Remove book">✕</button>' : '') +
        '<div class="cover"' + coverStyle + '></div>' +
        '<h3></h3><div class="author"></div>' +
        '<div class="meta">' +
          '<span>' + (isLoading ? '' : (b.wordCount ? b.wordCount.toLocaleString() + ' words' : '')) + '</span>' +
          (isLoading ? '<span class="tag loading-tag">loading…</span>' :
            (b.sample ? '<span class="tag sample">sample</span>' : '')) +
          (!isLoading && pct != null ? '<span class="tag">' + pct + '% read</span>' :
            (!isLoading && progress ? '<span class="tag">in progress</span>' : '')) +
        '</div>';
      card.querySelector('h3').textContent = b.title;
      card.querySelector('.author').textContent = b.author || '';
      function open() {
        if (isLoading) return; // not ready yet — chapters still parsing
        location.href = bookHref(b.id, b._user ? 'user' : 'repo');
      }
      card.addEventListener('click', function (e) {
        if (e.target.classList.contains('del')) return;
        open();
      });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      var del = card.querySelector('.del');
      if (del) del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (confirm('Remove "' + b.title + '" from this browser?')) {
          Store.deleteUserBook(b.id); load();
        }
      });
      grid.appendChild(card);
    });
  }

  var countEl = document.getElementById('libCount');
  var sortEl = document.getElementById('sortBy');
  try {
    var s0 = Store.getSettings();
    if (s0.librarySort) sortEl.value = s0.librarySort;
  } catch (e) {}

  function applySearch() {
    var q = (searchEl.value || '').toLowerCase().trim();
    var filtered = !q ? books : books.filter(function (b) {
      return (b.title + ' ' + (b.author || '')).toLowerCase().indexOf(q) !== -1;
    });
    var sorted = sortBooks(filtered, sortEl.value);
    render(sorted);
    if (countEl) {
      countEl.textContent = sorted.length +
        (sorted.length === 1 ? ' book' : ' books') +
        (q ? ' matching “' + searchEl.value.trim() + '”' : '');
    }
    // If an upload asked us to reveal a specific book, scroll its card into view
    // and flash it. Cleared after one use so normal renders don't keep jumping.
    if (pendingScrollId) {
      var id = pendingScrollId; pendingScrollId = null;
      requestAnimationFrame(function () { scrollToBook(id); });
    }
  }

  var pendingScrollId = null;
  function scrollToBook(id) {
    var card = grid.querySelector('.card[data-book-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!card) return;
    try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (e) { card.scrollIntoView(); }
    card.classList.add('just-added');
    setTimeout(function () { card.classList.remove('just-added'); }, 1800);
  }
  searchEl.addEventListener('input', applySearch);
  sortEl.addEventListener('change', function () {
    try { var s = Store.getSettings(); s.librarySort = sortEl.value; Store.saveSettings(s); } catch (e) {}
    applySearch();
  });

  function load() {
    var userBooks = Store.getUserLibrary().map(function (b) { b._user = true; return b; });
    fetch('books/manifest.json').then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (repo) {
        books = userBooks.concat(repo);
        applySearch();
      });
  }

  /* ---------- Drawers ---------- */
  function openDrawer(el) { el.classList.add('open'); }
  function closeDrawer(el) { el.classList.remove('open'); }
  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { closeDrawer(btn.closest('.drawer-backdrop')); });
  });
  document.querySelectorAll('.drawer-backdrop').forEach(function (bd) {
    bd.addEventListener('click', function (e) { if (e.target === bd) closeDrawer(bd); });
  });

  /* Add book */
  var addDrawer = document.getElementById('addDrawer');
  document.getElementById('addBtn').addEventListener('click', function () { openDrawer(addDrawer); });
  document.getElementById('addConfirm').addEventListener('click', function () {
    var fileInput = document.getElementById('file');
    var errEl = document.getElementById('addError');
    errEl.hidden = true;
    var f = fileInput.files && fileInput.files[0];
    if (!f) { errEl.textContent = 'Choose a .txt or .epub file first.'; errEl.hidden = false; return; }

    var fb = { title: document.getElementById('tTitle').value.trim() || null,
               author: document.getElementById('tAuthor').value.trim() || null };

    function finish(book) {
      try {
        if (!book.chapters.length || !book.wordCount) throw new Error('No readable text found in that file.');
        book.id = 'u-' + Date.now().toString(36);
        book._user = true;
        var ok = Store.saveUserBook(book);
        if (!ok) throw new Error('Could not save — browser storage may be full or blocked.');
        closeDrawer(addDrawer);
        fileInput.value = ''; document.getElementById('tTitle').value = ''; document.getElementById('tAuthor').value = '';
        pendingScrollId = book.id;
        load();
      } catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
    }
    function fail(msg) { errEl.textContent = msg; errEl.hidden = false; }

    var isEpub = /\.epub$/i.test(f.name) || f.type === 'application/epub+zip';
    if (isEpub) {
      if (typeof EpubParser === 'undefined') { fail('EPUB support failed to load. Reload the page and try again.'); return; }
      // EPUB parsing runs in a Web Worker so the page stays responsive. As soon
      // as the title/author are known (onMeta), we add the book to the library
      // with a "loading" placeholder and close the dialog — the chapters keep
      // parsing in the background and the card fills in when ready.
      errEl.textContent = 'Reading EPUB…'; errEl.hidden = false;
      var placeholderId = null;
      EpubParser.parse(f, fb, {
        onMeta: function (info) {
          placeholderId = 'u-' + Date.now().toString(36);
          var stub = {
            id: placeholderId, _user: true, loading: true,
            title: info.title, author: info.author,
            wordCount: 0, chapters: []
          };
          // Save a lightweight stub so the card appears immediately.
          try { Store.saveUserBook(stub); } catch (e) {}
          pendingScrollId = placeholderId; // reveal it after the grid re-renders
          // Reset the form and show the library right away.
          closeDrawer(addDrawer);
          fileInput.value = '';
          document.getElementById('tTitle').value = '';
          document.getElementById('tAuthor').value = '';
          load();
        },
        onProgress: function (doneN, total) {
          // (Drawer is already closed; progress could drive a card spinner later.)
        }
      }).then(function (book) {
        try {
          if (!book.chapters.length || !book.wordCount) throw new Error('No readable text found in that file.');
          // Reuse the placeholder id so the loading card upgrades in place.
          book.id = placeholderId || ('u-' + Date.now().toString(36));
          book._user = true;
          book.loading = false;
          var ok = Store.saveUserBook(book);
          if (!ok) throw new Error('Could not save — browser storage may be full or blocked.');
          // If onMeta never ran (e.g. sync fallback), the drawer is still open and
          // nothing has scrolled yet — close it and target this book now.
          if (!placeholderId) {
            closeDrawer(addDrawer);
            fileInput.value = '';
            document.getElementById('tTitle').value = '';
            document.getElementById('tAuthor').value = '';
          }
          pendingScrollId = book.id;
          load();
        } catch (e) {
          // Parsing failed after the stub was shown: remove the stub and report.
          if (placeholderId) { try { Store.deleteUserBook(placeholderId); } catch (e2) {} load(); }
          // The drawer is closed, so surface the error via a transient alert.
          alert(e.message);
        }
      }).catch(function (e) {
        if (placeholderId) { try { Store.deleteUserBook(placeholderId); } catch (e2) {} load(); }
        var msg = e && e.message ? e.message : 'Could not read that EPUB.';
        if (errEl) { fail(msg); }
        else { alert(msg); }
      });
    } else {
      var reader = new FileReader();
      reader.onload = function () {
        try { finish(TextParser.parse(String(reader.result), fb)); }
        catch (e) { fail(e.message); }
      };
      reader.onerror = function () { fail('Could not read that file.'); };
      reader.readAsText(f);
    }
  });

  /* Data drawer: persist state + export/import */
  var dataDrawer = document.getElementById('dataDrawer');
  document.getElementById('dataBtn').addEventListener('click', function () {
    openDrawer(dataDrawer);
    var ps = document.getElementById('persistState');
    Store.isPersisted().then(function (p) {
      ps.textContent = p
        ? 'Storage is marked persistent — the browser will try to keep your data.'
        : 'Storage is best-effort — the browser may clear it under pressure. Export to be safe.';
    });
  });
  document.getElementById('exportBtn').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(Store.exportAll())], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rsvp-reader-backup.json';
    a.click(); URL.revokeObjectURL(a.href);
  });
  document.getElementById('importBtn').addEventListener('click', function () {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    var msg = document.getElementById('dataMsg');
    msg.hidden = true;
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var n = Store.importAll(JSON.parse(String(r.result)), false);
        msg.style.color = ''; msg.textContent = 'Imported ' + n + ' items. Reloading…';
        msg.hidden = false; setTimeout(function () { location.reload(); }, 700);
      } catch (err) { msg.textContent = err.message; msg.hidden = false; }
    };
    r.readAsText(f);
  });

  // On a fresh page load, remove any "loading" stubs left over from an EPUB
  // whose parse never finished (e.g. the tab was closed mid-parse). They can't
  // resume — the uploaded File is gone — so a stuck "loading…" card would be
  // dead. Done once at startup, not on in-session load() refreshes.
  (function cleanOrphanLoadingStubs() {
    try {
      var lib = Store.getUserLibrary();
      lib.forEach(function (b) {
        if (b && b.loading) { try { Store.deleteUserBook(b.id); } catch (e) {} }
      });
    } catch (e) {}
  })();

  load();
})();
