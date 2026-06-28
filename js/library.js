/* library.js — library view: load manifest + user books, search, add, data. */
(function () {
  'use strict';
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

  function render(list) {
    grid.innerHTML = '';
    if (!list.length) { emptyEl.hidden = false; return; }
    emptyEl.hidden = true;
    list.forEach(function (b) {
      var card = document.createElement('div');
      card.className = 'card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      var initial = (b.title || '?').trim().charAt(0).toUpperCase();
      var coverStyle = b.cover ? ' style="background-image:url(' + b.cover + ')"' : '';
      var progress = Store.getProgress(b.id);
      var pct = progress && b.wordCount ? Math.round(progress.index / b.wordCount * 100) : 0;
      card.innerHTML =
        (b._user ? '<button class="del" title="Remove" aria-label="Remove book">✕</button>' : '') +
        '<div class="cover"' + coverStyle + '>' + (b.cover ? '' : initial) + '</div>' +
        '<h3></h3><div class="author"></div>' +
        '<div class="meta">' +
          '<span>' + (b.wordCount ? b.wordCount.toLocaleString() + ' words' : '') + '</span>' +
          (b.sample ? '<span class="tag sample">sample</span>' : '') +
          (progress ? '<span class="tag">' + pct + '% read</span>' : '') +
        '</div>';
      card.querySelector('h3').textContent = b.title;
      card.querySelector('.author').textContent = b.author || '';
      function open() { location.href = bookHref(b.id, b._user ? 'user' : 'repo'); }
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

  function applySearch() {
    var q = (searchEl.value || '').toLowerCase().trim();
    if (!q) return render(books);
    render(books.filter(function (b) {
      return (b.title + ' ' + (b.author || '')).toLowerCase().indexOf(q) !== -1;
    }));
  }
  searchEl.addEventListener('input', applySearch);

  function load() {
    var userBooks = Store.getUserLibrary().map(function (b) { b._user = true; return b; });
    fetch('books/manifest.json').then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (repo) {
        books = userBooks.concat(repo).sort(function (a, b) { return a.title.localeCompare(b.title); });
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
    if (!f) { errEl.textContent = 'Choose a .txt file first.'; errEl.hidden = false; return; }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var raw = String(reader.result);
        var fb = { title: document.getElementById('tTitle').value.trim() || null,
                   author: document.getElementById('tAuthor').value.trim() || null };
        var book = GutenbergParser.parse(raw, fb);
        if (!book.chapters.length || !book.wordCount) throw new Error('No readable text found in that file.');
        book.id = 'u-' + Date.now().toString(36);
        book._user = true;
        var ok = Store.saveUserBook(book);
        if (!ok) throw new Error('Could not save — browser storage may be full or blocked.');
        closeDrawer(addDrawer);
        fileInput.value = ''; document.getElementById('tTitle').value = ''; document.getElementById('tAuthor').value = '';
        load();
      } catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
    };
    reader.onerror = function () { errEl.textContent = 'Could not read that file.'; errEl.hidden = false; };
    reader.readAsText(f);
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

  load();
})();
