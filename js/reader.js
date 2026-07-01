/* reader.js — wires the RSVP engine to the rail, controls, and persistence. */
(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search);
  var bookId = params.get('book');
  var src = params.get('src') || 'repo';

  var els = {
    title: document.getElementById('bookTitle'),
    author: document.getElementById('bookAuthor'),
    chapterName: document.getElementById('chapterName'),
    chapterSel: document.getElementById('chapterSel'),
    rail: document.getElementById('rail'),
    idle: document.getElementById('railIdle'),
    word: document.getElementById('word'),
    scrub: document.getElementById('scrub'),
    progress: document.getElementById('progress'),
    play: document.getElementById('play'),
    wpm: document.getElementById('wpm'),
    wpmVal: document.getElementById('wpmVal'),
    wpmInput: document.getElementById('wpmInput'),
    pauseScale: document.getElementById('pauseScale'),
    pauseVal: document.getElementById('pauseVal'),

    pct: document.getElementById('pct'),
    timeleft: document.getElementById('timeleft'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsMenu: document.getElementById('settingsMenu')
  };

  function setTheme(t) {
    settings = Store.getSettings();
    settings.theme = t; Store.saveSettings(settings);
    document.documentElement.setAttribute('data-theme', t);
  }

  // Theme + settings menu
  var settings = Store.getSettings();
  document.documentElement.setAttribute('data-theme', settings.theme);

  // ---- Text size (Small / Medium / Large) ----
  // Applied as a body class that sets the --page-font variable. Default "small".
  var FONT_SIZES = ['small', 'medium', 'large'];
  function applyFontSize(size, repaginate) {
    if (FONT_SIZES.indexOf(size) < 0) size = 'small';
    for (var i = 0; i < FONT_SIZES.length; i++) {
      document.body.classList.toggle('font-' + FONT_SIZES[i], FONT_SIZES[i] === size);
    }
    // Reflect the choice in the segmented control.
    ['Small', 'Medium', 'Large'].forEach(function (label) {
      var btn = document.getElementById('mFont' + label);
      if (btn) btn.setAttribute('aria-checked', String(btn.dataset.size === size));
    });
    if (repaginate && paged) {
      // Font size changed → text re-flows but the page BOX size is unchanged, so
      // box-based change-detection would miss it. Force a fresh pagination.
      // Anchor to the word at the CENTER of the current page (not engine.index,
      // which is the chapter start in paged mode) so the reflow keeps the
      // reader's focal point steady — words above/below shift, the middle holds.
      var anchor = (currentView === 'rsvp')
        ? (engine ? engine.index : 0)
        : paged.currentAnchor();
      paged.invalidate();
      (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () {
        paged.goToIndex(anchor);
        if (currentView === 'rsvp') paged.follow(anchor);
        if (fullyLoaded && book && book.chapters) {
          paged.cancelTotals();
          paged.computeTotals(book.chapters.length, function () { refreshPagedStatus(); });
        }
      });
    }
  }
  function setFontSize(size) {
    var s = Store.getSettings();
    s.fontSize = size;
    Store.saveSettings(s);
    applyFontSize(size, true);
  }
  // Apply the saved size immediately (before the book builds) so first pagination
  // happens at the right size.
  applyFontSize(settings.fontSize || 'small', false);
  ['Small', 'Medium', 'Large'].forEach(function (label) {
    var btn = document.getElementById('mFont' + label);
    if (btn) btn.addEventListener('click', function () { setFontSize(btn.dataset.size); });
  });

  function openMenu() {
    els.settingsMenu.hidden = false;
    installWpmHistoryPanel();      // idempotent; builds the panel on first open
    if (typeof Wpm !== 'undefined' && Wpm.renderHistory) Wpm.renderHistory();
  }
  function closeMenu() { els.settingsMenu.hidden = true; }
  els.settingsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    els.settingsMenu.hidden ? openMenu() : closeMenu();
  });
  els.settingsMenu.addEventListener('click', function (e) {
    if (e.target === els.settingsMenu) closeMenu(); // tap backdrop
  });
  document.getElementById('mTheme').addEventListener('click', function () {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // Build the WPM history section and append it inside the settings menu, using
  // the menu's own native classes (.menu-label / .menu-sep) so it inherits the
  // existing styling. Appended once, on first open.
  function installWpmHistoryPanel() {
    var menu = els.settingsMenu;
    if (!menu || document.getElementById('wpmHistoryPanel')) return;
    var host = menu.querySelector('.menu') || menu;
    var panel = document.createElement('div');
    panel.id = 'wpmHistoryPanel';
    panel.innerHTML =
      '<div class="menu-sep"></div>' +
      '<div class="menu-label" style="display:flex;justify-content:space-between;align-items:center">' +
        '<span>Reading pace history</span>' +
        '<button id="wpmHistClear" type="button" class="ghost" ' +
          'style="font:inherit;cursor:pointer;padding:0;background:none;border:none;' +
          'color:var(--rubric)">Clear</button>' +
      '</div>' +
      '<div id="wpmHistoryList" class="wpm-hist-list" ' +
        'style="max-height:200px;overflow-y:auto;-webkit-overflow-scrolling:touch"></div>';
    host.appendChild(panel);
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    var clearBtn = document.getElementById('wpmHistClear');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      if (confirm('Clear the reading-pace history?')) Wpm.clearHistory();
    });
  }

  Store.requestPersistence();

  var engine = null, tokens = null, book = null, saveTimer = null;
  var chapterStart = {};      // chapter → first index in `tokens` (rebuilt as it grows)
  var fullyLoaded = false;    // every chapter tokenized → global % is exact
  var resumeMode = 'read';
  var resumePageInChapter = null;   // saved exact page within the resume chapter
  var resumeChapterNum = 0;         // saved chapter (for exact-page restore)
  var didInitialPaint = false;      // guard: only exact-page-restore on first build
  // Loading-state machinery: an AbortController so we can cancel a slow fetch,
  // plus timers that escalate the message ("taking longer…") and eventually
  // give up. loadDone() clears all of this once the book is ready or has failed.
  var loadController = null;
  var slowTimer = null, giveUpTimer = null, escapeTimer = null, loadFinished = false;
  var LIBRARY_URL = 'index.html?home';

  // Inject a persistent "Back to library" escape hatch into the loading screen
  // so the user is never trapped. It sits in the paged panel (the default view)
  // and is shown immediately on every load attempt.
  function showLoadingEscape() {
    var pageEl = document.getElementById('page');
    if (!pageEl || document.getElementById('loadEscape')) return;
    var box = document.createElement('div');
    box.id = 'loadEscape';
    box.style.cssText = 'text-align:center;padding:24px 12px;color:var(--fg-dim)';
    box.innerHTML =
      '<p id="loadEscapeMsg" class="pg-para" style="text-indent:0;font-style:italic">Loading this book…</p>' +
      '<p class="pg-para" style="text-indent:0;margin-top:14px">' +
        '<a id="loadEscapeLink" href="' + LIBRARY_URL + '" ' +
        'style="display:inline-block;padding:8px 16px;border:1px solid var(--rubric);' +
        'border-radius:8px;color:var(--rubric);text-decoration:none">\u2190 Back to library</a>' +
      '</p>';
    pageEl.innerHTML = '';
    pageEl.appendChild(box);
    // The #page area has its own tap handler (paged.enableTaps) that can swallow
    // this click, so don't rely on the <a>'s default navigation. Stop the event
    // from bubbling to that handler and navigate explicitly.
    var link = document.getElementById('loadEscapeLink');
    if (link) link.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      abortLoad();
      window.location.href = LIBRARY_URL;
    });
  }

  function setLoadingMsg(msg) {
    var el = document.getElementById('loadEscapeMsg');
    if (el) el.textContent = msg;
    if (els.idle) els.idle.textContent = msg;
  }

  function abortLoad() {
    if (loadController) { try { loadController.abort(); } catch (e) {} }
    clearTimeout(slowTimer); clearTimeout(giveUpTimer); clearTimeout(escapeTimer);
  }

  // Called once the book is parsed/tokenized and the reader is live. Removes the
  // escape box and stops the slow/timeout timers.
  function loadDone() {
    loadFinished = true;
    clearTimeout(slowTimer); clearTimeout(giveUpTimer); clearTimeout(escapeTimer);
    var box = document.getElementById('loadEscape');
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  function loadBook() {
    // Only show the loading screen if the book isn't ready reasonably quickly.
    // Cache-path and small-book opens finish well under this window and shouldn't
    // flash a loading screen at all; the grace window is generous enough that a
    // warm reopen (raw-JSON cache + token cache) never trips it, while a genuinely
    // slow cold fetch still surfaces the escape UI.
    escapeTimer = setTimeout(function () {
      if (loadFinished) return;
      showLoadingEscape();
      setLoadingMsg('Loading this book…');
    }, 600);

    // Escalate the message if it's slow, and hard-fail if it truly hangs.
    slowTimer = setTimeout(function () {
      if (!loadFinished) setLoadingMsg('Still loading — large books can take a few seconds. You can go back to the library anytime.');
    }, 4000);
    giveUpTimer = setTimeout(function () {
      if (!loadFinished) { abortLoad(); fail('This book is taking too long to load. Try again, or pick another from the library.'); }
    }, 25000);

    if (src === 'user') {
      var b = Store.getUserBook(bookId);
      if (!b) return fail('That uploaded book is no longer in this browser.');
      // Defer setup one tick so the escape UI paints before tokenize/pagination
      // (which are synchronous and block the thread) kick in.
      return setTimeout(function () { setup(b); }, 0);
    }

    loadController = ('AbortController' in window) ? new AbortController() : null;
    var fetchOpts = loadController ? { signal: loadController.signal } : {};
    fetch('books/' + encodeURIComponent(bookId) + '.json', fetchOpts)
      .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(function (b) { setTimeout(function () { setup(b); }, 0); })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return; // user left on purpose
        fail('Could not load that book.');
      });
  }
  function fail(msg) {
    loadDone();
    els.title.textContent = 'Unavailable';
    if (els.idle) els.idle.textContent = msg;
    // Also show it in the paged panel, which is the visible view by default.
    var pageEl = document.getElementById('page');
    if (pageEl) pageEl.innerHTML = '<p class="pg-para" style="text-indent:0;color:var(--fg-dim);font-style:italic">' +
      msg + '</p><p class="pg-para" style="text-indent:0;color:var(--fg-dim)">' +
      'Open a book from the <a href="' + LIBRARY_URL + '" style="color:var(--rubric)">Library</a>.</p>';
  }

  function setup(b) {
    book = b;
    els.title.textContent = b.title;
    els.author.textContent = b.author || '';
    setTopChapter(0);
    document.title = b.title + ' — RSVP Reader';
    Store.setLastBook(bookId, src);

    // Chapter dropdown. Show each chapter's OWN title verbatim (e.g. "Letter 1",
    // "Chapter 1", "CHAPTER 5. Breakfast.") — we don't renumber by list position
    // or strip the chapter number, because that desynced the dropdown from the
    // book's real chapter labels (a book may open with Letters, a Preface, etc.,
    // so list position ≠ chapter number).
    b.chapters.forEach(function (c, i) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = c.title || ('Section ' + (i + 1));
      els.chapterSel.appendChild(opt);
    });

    // --- Incremental, chapter-first tokenization with CONTENT COORDINATES.
    //
    // Tokenizing a 1,000,000-word book at once is ~1s of synchronous work — the
    // main cause of the old load freeze. We never do that. Instead:
    //
    //  1. Tokenize chapter ranges, shifting each slice's local chapter numbers up
    //     to their true global values (RSVP.tokenize counts chapters from 0).
    //
    //  2. Position is a CONTENT COORDINATE {chapter, para, word} — the same idea
    //     as EPUB CFI or Kindle locations — NOT a global token count. A coordinate
    //     is valid the instant its chapter is tokenized, regardless of how much of
    //     the book precedes it. So a deep resume/jump paints immediately from just
    //     that one chapter, and as the rest of the book streams in around it the
    //     coordinate keeps pointing at the same word with NOTHING to rebase. This
    //     is what removes the navigation-during-load races entirely.
    //
    // `tokens` fills in chapter order starting from the resume chapter, extending
    // forward, and backfilling earlier chapters behind it. `chapterStart[ch]` maps
    // a chapter to its first index in the CURRENT array for O(1) coordinate
    // resolution. `engine.index` is always a live index into the current array;
    // the durable position is its coordinate, recomputed on save.
    function tokenizeRange(startCh, count) {
      var slice = b.chapters.slice(startCh, startCh + count);
      var toks = RSVP.tokenize(slice);
      for (var i = 0; i < toks.length; i++) toks[i].chapter += startCh;
      return toks;
    }

    var prog = Store.getProgress(bookId);
    resumeMode = (prog && prog.mode) ? prog.mode : 'read';
    // Prefer a content coordinate; fall back to a legacy global index by treating
    // it as chapter 0 (only affects progress saved before this version).
    var resumeCoord = (prog && prog.coord) ? prog.coord
      : { chapter: (prog && prog.chapter != null) ? prog.chapter : 0, para: 0, word: 0 };
    var isDeepResume = resumeCoord.chapter > 0 || resumeCoord.para > 0 || resumeCoord.word > 0;
    // Exact page-within-chapter to restore on the first paged render (more robust
    // than resolving a token to a page, which lazy pagination can shift).
    resumePageInChapter = (prog && prog.pageInChapter != null) ? prog.pageInChapter : null;
    resumeChapterNum = resumeCoord.chapter || 0;
    didInitialPaint = false;

    settings = Store.getSettings();
    var startWpm = settings.wpm || 400;
    // Pauses are fixed at "longest" (2) — the slider was removed. Always use the
    // max so sentence/paragraph breaks get the fullest pause.
    var startPause = 2;
    els.wpm.value = startWpm; els.wpmVal.textContent = startWpm + ' wpm';

    var FIRST_CHUNK = 1;          // chapters before first paint (cold open) — paint ASAP, stream the rest
    var REST_CHUNK = 8;           // chapters per background slice

    tokens = [];
    chapterStart = {};            // chapter → first index in `tokens` (module-scope)
    fullyLoaded = false;          // true once every chapter is tokenized

    function indexChapters() {    // (re)build chapterStart after the array changes
      chapterStart = {};
      for (var i = 0; i < tokens.length; i++) {
        var c = tokens[i].chapter;
        if (chapterStart[c] == null) chapterStart[c] = i;
      }
    }

    engine = new RSVP.Engine(tokens, {
      wpm: startWpm, pauseScale: startPause,
      onRender: renderWord, onState: onState,
      onEnd: function () { els.play.textContent = 'Replay'; }
    });

    var nextChAfter, nextChBefore;

    // Load path: tokenize + paint the opening chapter immediately, then stream
    // the rest in the background. No cross-open token cache — the incremental
    // stream is fast on its own, and a cache read + full decode was adding lag to
    // every reopen (the whole book had to be decoded before the first paint).
    // The one thing we DO persist cheaply is reading position (handled elsewhere),
    // so a reopen resumes exactly where you were and paints that chapter first.
    function beginLoad() {
      beginIncremental();
    }

    // Normal path: tokenize the resume/opening chapter now, stream the rest.
    function beginIncremental() {
      if (isDeepResume) {
        var rc = Math.min(resumeCoord.chapter, b.chapters.length - 1);
        var resumeToks = tokenizeRange(rc, 1);
        for (var ri = 0; ri < resumeToks.length; ri++) tokens.push(resumeToks[ri]);
        indexChapters();
        var startIdx = Coords.resolve(tokens, resumeCoord, chapterStart);
        engine.index = startIdx < 0 ? 0 : startIdx;
        nextChAfter = rc + 1;
        nextChBefore = rc - 1;
      } else {
        var first = tokenizeRange(0, Math.min(FIRST_CHUNK, b.chapters.length));
        for (var fi = 0; fi < first.length; fi++) tokens.push(first[fi]);
        indexChapters();
        engine.index = 0;
        nextChAfter = Math.min(FIRST_CHUNK, b.chapters.length);
        nextChBefore = -1;
      }
      goLive();
      afterDone = !(nextChAfter < b.chapters.length);
      beforeDone = !(nextChBefore >= 0);
      setTimeout(streamForward, 0);
      setTimeout(streamBackward, 0);
    }

    // Paint the opening screen and make the reader interactive (shared by both
    // load paths).
    function goLive() {
      updateScrubMax();
      setupPaged();
      renderWord(engine.current(), engine.snapshot());
      onState(engine.snapshot());
      wireControls();
      switchView(resumeMode === 'rsvp' ? 'rsvp' : 'read');
      loadDone();
    }

    // --- Background streaming, forward then backward, time-sliced. Each chunk
    // PRESERVES the reader's position by coordinate: we remember the current
    // coordinate, append/prepend tokens, re-index, and restore the live index
    // from the coordinate. The on-screen word never moves.
    // --- Single insertion path for ALL token additions (forward stream, backward
    // backfill, on-demand chapter jump). Inserts a chunk at its chapter-ordered
    // position so the array is always sorted by (chapter, para, token). Position
    // is preserved by coordinate across every insert; the on-screen word never
    // moves. This one code path is why ordering can't drift no matter the order
    // chunks arrive in.
    function insertChunk(chunk) {
      if (!chunk.length) return;
      // Drop any chapters already present (a chapter jump may have loaded one that
      // a later background range also covers). This keeps inserts idempotent so
      // overlapping ranges can never duplicate a chapter.
      var filtered = [];
      for (var ci = 0; ci < chunk.length; ci++) {
        if (chapterStart[chunk[ci].chapter] == null) filtered.push(chunk[ci]);
      }
      if (!filtered.length) return;
      // A chunk may now contain only some chapters; insert each contiguous
      // chapter-run at its correct ordered position.
      var coord = currentCoord();
      var run = [filtered[0]];
      for (var k = 1; k <= filtered.length; k++) {
        if (k < filtered.length && filtered[k].chapter <= filtered[k - 1].chapter + 1
            && filtered[k].chapter >= filtered[k - 1].chapter) {
          run.push(filtered[k]);
        } else {
          spliceRun(run);
          if (k < filtered.length) run = [filtered[k]];
        }
      }
      indexChapters();
      restoreFromCoord(coord);
    }
    // Splice one already-ordered run of tokens at its chapter position.
    function spliceRun(run) {
      var firstCh = run[0].chapter;
      var at = tokens.length;
      for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].chapter > firstCh) { at = i; break; }
      }
      var args = [at, 0].concat(run);
      Array.prototype.splice.apply(tokens, args);
    }

    function streamForward() {
      while (nextChAfter < b.chapters.length && chapterStart[nextChAfter] != null) nextChAfter++;
      if (nextChAfter >= b.chapters.length) { afterDone = true; maybeFullyLoaded(); return; }
      var t0 = now();
      do {
        var chunk = tokenizeRange(nextChAfter, Math.min(REST_CHUNK, b.chapters.length - nextChAfter));
        insertChunk(chunk);
        nextChAfter += REST_CHUNK;
        while (nextChAfter < b.chapters.length && chapterStart[nextChAfter] != null) nextChAfter++;
      } while (nextChAfter < b.chapters.length && (now() - t0) < 10);
      updateScrubMax();
      if (engine) onState(engine.snapshot());
      setTimeout(streamForward, 0);
    }

    function streamBackward() {
      while (nextChBefore >= 0 && chapterStart[nextChBefore] != null) nextChBefore--;
      if (nextChBefore < 0) { beforeDone = true; maybeFullyLoaded(); return; }
      var t0 = now();
      do {
        var startCh = Math.max(0, nextChBefore - REST_CHUNK + 1);
        var count = nextChBefore - startCh + 1;
        var chunk = tokenizeRange(startCh, count);
        insertChunk(chunk);
        nextChBefore = startCh - 1;
        while (nextChBefore >= 0 && chapterStart[nextChBefore] != null) nextChBefore--;
      } while (nextChBefore >= 0 && (now() - t0) < 10);
      updateScrubMax();
      if (engine) onState(engine.snapshot());
      if (nextChBefore < 0) { beforeDone = true; maybeFullyLoaded(); return; }
      setTimeout(streamBackward, 0);
    }

    // Streaming-completion flags. Set by beginIncremental (and the stream loops);
    // in the cache path they stay true since there's nothing to stream.
    var afterDone = true, beforeDone = true;
    function maybeFullyLoaded() {
      if (afterDone && beforeDone && !fullyLoaded) {
        fullyLoaded = true;        // global token count is now exact → % is exact
        updateScrubMax();
        if (engine) onState(engine.snapshot());
        // Now that every chapter is tokenized, compute total page counts in the
        // background (per-chapter, time-sliced). This populates "page N of TOTAL".
        if (paged && book && book.chapters) {
          paged.computeTotals(book.chapters.length, function () {
            refreshPagedStatus();   // refresh as counts arrive and when final
          });
        }
      }
    }

    // On-demand chapter load for jumps to a chapter the background stream hasn't
    // reached yet. Tokenize it and splice into the array at its chapter-ordered
    // position so chapterStart stays monotonic. Position preserved by coordinate.
    _ensureChapter = function (ch) {
      if (ch < 0 || ch >= b.chapters.length) return;
      if (chapterStart[ch] != null) return;       // already loaded
      insertChunk(tokenizeRange(ch, 1));
      updateScrubMax();
    };

    // Kick off loading: cache fast-path if available, else incremental tokenize.
    beginLoad();
  }

  // ---- position helpers (module scope; used across setup + controls) ----
  function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

  // The reader's current content coordinate, derived from the live engine index.
  function currentCoord() {
    if (!engine || !tokens.length) return { chapter: 0, para: 0, word: 0 };
    return Coords.coordOf(tokens, Math.max(0, Math.min(tokens.length - 1, engine.index)));
  }
  // Restore the live engine index from a coordinate after the array grew/shifted.
  // The paged reader is only re-anchored when its own visible range moved, to
  // avoid re-rendering the page on every background insert.
  function restoreFromCoord(coord) {
    if (!engine) return;
    var idx = Coords.resolve(tokens, coord, chapterStart);
    if (idx < 0) idx = engine.index;
    var delta = idx - engine.index;
    engine.index = idx;
    if (paged && delta !== 0) {
      // Shift the paged window AND its nav history by the same delta so its
      // screen stays on the same words and prev still works after the array grew.
      paged.shiftPositions(delta);
    }
  }
  function updateScrubMax() {
    els.scrub.max = String(Math.max(0, tokens.length - 1));
  }

  // setup() registers a tokenizer so on-demand chapter loads (chapter jumps to a
  // not-yet-streamed chapter) can happen outside setup's closure. Returns the
  // first token index of the chapter in the current array, tokenizing+indexing it
  // if needed. Position is preserved by coordinate across the array change.
  var _ensureChapter = null;
  function jumpToChapter(ch) {
    if (!engine) return;
    if (_ensureChapter) _ensureChapter(ch);
    var idx = chapterStart[ch];
    if (idx == null) idx = Coords.resolve(tokens, { chapter: ch, para: 0, word: 0 }, chapterStart);
    if (idx < 0) idx = 0;
    engine.seek(idx);
    if (paged) {
      if (currentView === 'rsvp') paged.follow(idx); else paged.goToIndex(idx);
    }
  }


  var paged = null, currentView = 'read';
  var curPageInChapter = null;   // latest page-within-chapter for durable resume
  var _wpmLastPageStart = null;  // first-word index of the last page banked by the meter

  // ---- Reading-pace meter (per page) ----------------------------------------
  // Shows the words-per-minute of the LAST fully-read page, for this browser
  // session only (no persistence, resets on reopen). Each completed page REPLACES
  // the reading rather than folding into a running average, so a misclick that
  // flips a page and back doesn't skew the number — the next real page recomputes
  // it from scratch. Time only counts while the tab is visible; too-brief flips
  // (misclicks) and absurd dwell times (walked away) are ignored.
  var Wpm = (function () {
    var lastWpm = null;     // wpm of the last completed page (null until first one)
    var pageWords = 0, timing = false;
    var pageActiveMs = 0;   // active (screen-on) ms accumulated for the current page
    var lastTick = 0;       // wall-clock of the last time we added to pageActiveMs
    var MIN_MS = 800;              // ignore page flips faster than this (skimming past)
    // "Walked away" cutoff is computed PER PAGE from a very slow reading floor, so
    // a genuinely slow or learning reader is never discarded — only true idle time
    // is. FLOOR_WPM = 60 sits below every published "slow reader" figure (slow
    // adults ~150 wpm, early/struggling readers ~90–120 wpm), and a 1.5× buffer
    // adds slack for pauses. So a 275-word page counts up to ~7 min; a short page
    // proportionally less. Anything slower than this is treated as away-from-desk.
    var FLOOR_WPM = 60, BUFFER = 1.5, MIN_CUTOFF_MS = 90 * 1000;
    var blanked = false;   // true right after an idle page → show "--" until next page

    // ---- Persistent per-page history (global, all books) --------------------
    // A capped ring buffer of {t, wpm} entries in localStorage, so the Settings
    // panel can show a scrolling list of recent page paces across sessions. Cheap:
    // ~30 bytes/entry, capped at HISTORY_CAP → a few tens of KB at most.
    var HISTORY_KEY = 'rsvp:wpmHistory';
    var HISTORY_CAP = 1000;         // keep the most recent N pages; oldest drop off
    var history = loadHistory();
    function loadHistory() {
      try {
        var v = localStorage.getItem(HISTORY_KEY);
        var arr = v ? JSON.parse(v) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    }
    function saveHistory() {
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }
      catch (e) { /* quota/private-mode: history is best-effort, ignore */ }
    }
    function recordPage(wpm) {
      history.push({ t: Date.now(), wpm: wpm });
      if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
      saveHistory();
      renderHistory();
    }
    function getHistory() { return history.slice(); }
    function clearHistory() { history = []; saveHistory(); renderHistory(); }

    function maxMsFor(words) {
      return Math.max(MIN_CUTOFF_MS, (words / FLOOR_WPM) * 60000 * BUFFER);
    }
    function now() { return Date.now(); }

    // Fold the time since the last tick into the active total — but ONLY while the
    // page is visible. This makes the meter immune to the screen dimming/locking:
    // if the display sleeps, we simply stop accruing time, and a dim can never
    // inflate a page's duration or trip the walked-away cutoff. Also caps any
    // single gap so a stray long tick (throttled timer) can't over-count.
    function accrue() {
      if (!timing) { lastTick = now(); return; }
      if (document.visibilityState !== 'visible') { lastTick = now(); return; }
      var t = now(), dt = t - lastTick;
      lastTick = t;
      if (dt > 0 && dt < 30000) pageActiveMs += dt;   // ignore gaps >30s (backgrounded)
    }

    // Begin timing a paged page that has `words` words on it.
    function startPage(words) {
      commit();                    // bank whatever was open before
      pageWords = words || 0;
      pageActiveMs = 0;
      lastTick = now();
      timing = pageWords > 0;
    }
    // Compute the just-finished page's pace and make it THE reported number.
    function commit() {
      accrue();
      if (!timing) { return; }
      var dt = pageActiveMs;
      timing = false;
      if (pageWords <= 0) return;
      if (dt < MIN_MS) return;                 // flashed past (misclick) — keep prior number
      if (dt > maxMsFor(pageWords)) {
        // Beyond the slowest-reader threshold → treat as walked-away. Don't count
        // it, and blank the readout to "--" so a stale pace isn't shown; the next
        // real page turn recomputes and the number returns.
        blanked = true; render();
        return;
      }
      lastWpm = Math.round(pageWords / (dt / 60000));
      blanked = false;
      recordPage(lastWpm);   // persist this page's pace for the Settings history
      render();
    }
    // Speed-read no longer feeds the meter per-tick; pace is page-turn-only.
    function value() {
      return lastWpm;
    }
    function render() {
      var el = document.getElementById('sessionWpm');
      if (!el) return;
      var v = value();
      el.textContent = (blanked || v == null) ? '-- wpm' : (v.toLocaleString() + ' wpm');
    }
    // Render the scrolling history list into the Settings panel (if present).
    // Newest first. Kept lightweight: plain rows of "wpm · relative time".
    function renderHistory() {
      var list = document.getElementById('wpmHistoryList');
      if (!list) return;
      if (!history.length) {
        list.innerHTML = '<div class="wpm-hist-empty" style="padding:8px 10px;color:var(--fg-dim);font-style:italic">No pages recorded yet.</div>';
        return;
      }
      var rows = [];
      for (var i = history.length - 1; i >= 0; i--) {
        var h = history[i];
        rows.push('<div class="wpm-hist-row" style="display:flex;justify-content:space-between;' +
          'padding:6px 10px;border-top:1px solid var(--rule,rgba(128,128,128,.18))">' +
          '<span style="font-variant-numeric:tabular-nums">' + h.wpm.toLocaleString() + ' wpm</span>' +
          '<span style="color:var(--fg-dim)">' + relTime(h.t) + '</span></div>');
      }
      list.innerHTML = rows.join('');
    }
    function relTime(t) {
      var s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 60) return s + 's ago';
      var m = Math.round(s / 60);
      if (m < 60) return m + 'm ago';
      var h = Math.round(m / 60);
      if (h < 24) return h + 'h ago';
      var d = Math.round(h / 24);
      return d + 'd ago';
    }
    // Keep the active-time accrual honest across visibility flips. accrue() reads
    // visibilityState itself, so calling it on change banks the visible span and
    // resets the tick; hidden time is simply never added.
    document.addEventListener('visibilitychange', accrue);
    // A periodic tick so long single-page dwell still accrues (and so the cutoff
    // check via commit()/render() reflects reality even without a page turn).
    setInterval(accrue, 5000);
    window.addEventListener('beforeunload', commit);

    return { startPage: startPage, commit: commit, render: render,
             getHistory: getHistory, clearHistory: clearHistory,
             renderHistory: renderHistory };
  })();

  // Tap interaction state: 'idle' (normal) or 'armed' (box outlined, prompt up).
  var tapState = 'idle';
  var selectedIndex = null;   // word chosen while armed (null = none yet)

  function setupPaged() {
    var pageEl = document.getElementById('page');
    paged = new Paged(pageEl, {
      onWordTap: handlePageTap,
      onPageChange: function (info) {
        var meta = document.getElementById('pageNum');
        if (meta) meta.textContent = pagedStatusText(info);
        setTopChapter(info.chapter);
        // Remember the exact page within the chapter for durable resume — but
        // ONLY in the read view. In speed-read the strip advances a page at a time
        // via follow(), so its page number lags the actual word by up to a full
        // page; letting it write curPageInChapter would persist a page-boundary
        // anchor and make reopen jump to the top of the page (hundreds of words
        // off). In speed-read the content coordinate is the sole resume anchor.
        if (currentView === 'read' && info && info.pageInChapter != null) {
          curPageInChapter = info.pageInChapter;
        }
        // Session pace: bank the previous page's time and start timing the newly
        // shown page — for BOTH views, so speed-reading is measured by how long
        // each page of text is on screen, exactly like page reading. Guarded on
        // the page's first word actually changing, so background re-flows (stream
        // inserts calling follow()/shiftPositions) don't fire a spurious turn.
        if (info && info.wordsOnPage != null && info.startIndex != null &&
            info.startIndex !== _wpmLastPageStart) {
          _wpmLastPageStart = info.startIndex;
          Wpm.startPage(info.wordsOnPage);
        }
        // Keep the engine's position in sync with the page the reader is on, so
        // reopening resumes to THIS page. Page turns don't move the RSVP engine
        // on their own, so without this the only saved position was the rail's,
        // and the paged view never remembered where you'd read to. We only sync
        // while the paged view is the active one (not while the rail is driving
        // the page strip in RSVP mode) to avoid fighting the engine.
        if (currentView === 'read' && engine && info && info.startIndex != null) {
          engine.index = info.startIndex;
          onState(engine.snapshot());   // debounced-saves the new coordinate + page
        }
      }
    });
    paged.enableTaps();
    // Give the paged view the chapter titles so it can render a heading at the
    // top of each chapter (e.g. "CHAPTER 1. Loomings."). Indexed by chapter num.
    if (book && book.chapters) {
      paged.setChapterTitles(book.chapters.map(function (c) { return c.title; }));
      paged.setChapterCount(book.chapters.length);
    }
    // Window the opening screen at the resumed position. No full-book build.
    // On the FIRST paint after reopening, prefer restoring the exact saved page
    // within the resume chapter (deterministic given the box size), which avoids
    // the off-by-a-page drift that resolving a token to a page can cause while
    // pagination is lazy or the box height hasn't settled. Fall back to the
    // token's page if we have no saved page or the exact restore can't apply.
    paged.buildWhenReady(tokens, function () {
      var restored = false;
      // Exact page-within-chapter restore is a READ-mode concern. In speed-read,
      // the durable anchor is the content coordinate (already resolved into
      // engine.index), which points at the exact word — restoring a page here
      // would snap to the page's first word and jump the resume ahead/behind.
      if (!didInitialPaint && resumeMode !== 'rsvp' && resumePageInChapter != null) {
        var hint = (engine ? engine.index : 0);
        restored = paged.goToChapterPage(resumeChapterNum, resumePageInChapter, hint);
      }
      if (!restored) paged.goToIndex(engine ? engine.index : 0);
      didInitialPaint = true;
    });

    document.getElementById('pagePrev').addEventListener('click', function () { turnPage(-1); });
    document.getElementById('pageNext').addEventListener('click', function () { turnPage(1); });
    document.getElementById('mRead').addEventListener('click', function () { switchView('read'); closeMenu(); });
    document.getElementById('mRsvp').addEventListener('click', function () { switchView('rsvp', true); closeMenu(); });

    setupSwipe(pageEl);

    setupTapPrompt();
    setupPaneToggle();

    // On resize the page box changes, so re-paginate the current chapter (one
    // chapter of work) and recompute total pages in the background at the new
    // size, since every chapter re-flows.
    var rzTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(function () {
        var anchor = engine ? engine.index : 0;
        paged.goToIndex(anchor);
        if (currentView === 'rsvp') paged.follow(anchor);
        // Totals are size-specific; recompute if the book is fully tokenized.
        if (fullyLoaded && paged && book && book.chapters) {
          paged.cancelTotals();
          paged.computeTotals(book.chapters.length, function () { refreshPagedStatus(); });
        }
      }, 200);
    });
  }

  // Swipe left/right on the page to turn pages. We distinguish a swipe from a tap
  // (which selects a word) and from a vertical scroll: only a mostly-horizontal
  // drag past a distance threshold turns the page. A short movement falls through
  // to the tap handler, so word-selection still works.
  function setupSwipe(pageEl) {
    var x0 = 0, y0 = 0, t0 = 0, tracking = false;
    var H_THRESHOLD = 45;   // px of horizontal travel to count as a page turn
    var V_LIMIT = 35;       // px of vertical travel allowed before it's a scroll
    pageEl.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { tracking = false; return; }
      var t = e.touches[0];
      x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); tracking = true;
    }, { passive: true });
    pageEl.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      var t = (e.changedTouches && e.changedTouches[0]) || null;
      if (!t) return;
      var dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
      // Must be mostly horizontal, far enough, and not a slow long-press drag.
      if (Math.abs(dx) >= H_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.6 &&
          Math.abs(dy) < V_LIMIT * 3 && dt < 800) {
        // Suppress the synthetic click so the swipe doesn't also select a word.
        suppressNextPageTap = true;
        if (dx < 0) turnPage(1); else turnPage(-1);
      }
    }, { passive: true });
  }
  var suppressNextPageTap = false;

  // Turn the page strip one page in `dir` (+1 next, -1 prev). In the paged view
  // this just navigates; onPageChange keeps the engine + saved position in sync.
  // In speed-read (rsvp) view the page strip and the word rail are separate, so a
  // page turn wouldn't otherwise move the rail — here we snap the RSVP word to the
  // FIRST word of the newly shown page so the rail keeps up with where you paged
  // to. Playback pauses on a manual turn so it doesn't immediately run off.
  function turnPage(dir) {
    if (!paged) return;
    if (dir > 0) paged.next(); else paged.prev();
    if (currentView === 'rsvp' && engine && paged.firstIndex != null) {
      if (engine.snapshot().playing) engine.pause();
      engine.seek(paged.firstIndex);
      renderWord(engine.current(), engine.snapshot());
      onState(engine.snapshot());   // saves the new position
    }
  }

  // Format the paged status line from a pageInfo object. Until the background
  // total-page pass is done, show just the percent; once ready, show
  // "N of TOTAL (P%) — K pages left in chapter".
  function pagedStatusText(info) {
    if (info.totalsReady && info.totalPages > 0 && info.absolutePage > 0) {
      var left = info.pagesLeftInChapter;
      var leftStr = (left === 1) ? '1 page left in chapter'
                                 : left + ' pages left in chapter';
      return info.absolutePage + ' of ' + info.totalPages +
        ' (' + info.pct + '%) \u2014 ' + leftStr;
    }
    return info.pct + '% read';
  }
  function refreshPagedStatus() {
    if (currentView === 'rsvp' || !paged) return;
    var meta = document.getElementById('pageNum');
    if (meta) meta.textContent = pagedStatusText(paged.pageInfo());
  }

  // Switch between paged ('read') and speed-read ('rsvp'). Never autoplays.
  // When `snapToPage` is true (menu switch into speed-read with no word chosen),
  // the engine seeks to the FIRST word currently visible on the page, so the
  // rail starts where the reader's eyes were rather than at the resume point.
  function switchView(view, snapToPage) {
    var cameFromRsvp = (currentView === 'rsvp');
    // Switching views ends the current page's timing span. Bank it and clear the
    // page-turn guard so the destination view's first page starts timing fresh.
    Wpm.commit();
    _wpmLastPageStart = null;
    currentView = view;
    var readView = document.getElementById('pagedView');
    var rsvpView = document.getElementById('rsvpView');
    document.body.classList.toggle('mode-rsvp', view === 'rsvp');
    document.body.classList.toggle('mode-read', view === 'read');
    document.getElementById('mRead').setAttribute('aria-checked', String(view === 'read'));
    document.getElementById('mRsvp').setAttribute('aria-checked', String(view === 'rsvp'));
    var mPane = document.getElementById('mPane');
    if (mPane) mPane.hidden = (view !== 'rsvp');
    if (engine) engine.pause();
    if (view === 'read') {
      rsvpView.hidden = true; readView.hidden = false;
      var landIdx = engine ? engine.index : 0;
      paged.buildWhenReady(tokens, function () {
        if (cameFromRsvp) {
          // Land on the page containing the speed-read word, highlight it in
          // place, then let the highlight fade so the eye can find it without
          // the page shifting. (highlight = goToIndex + mark active word.)
          paged.highlight(landIdx);
          fadePagedHighlight();
        } else {
          paged.goToIndex(landIdx);
        }
      });
    } else {
      // Speed-read: the page strip above the rail always STARTS at the RSVP word
      // (top-aligned), so the strip begins where speed-reading begins.
      rsvpView.hidden = false; readView.hidden = false;
      // If entered from the menu with no word selected, start at the first word
      // currently visible on the read page (paged.firstIndex).
      if (snapToPage && paged && paged.firstIndex != null) {
        engine.seek(paged.firstIndex);
      }
      var railIdx = engine ? engine.index : 0;
      paged.buildWhenReady(tokens, function () {
        if (paged.showFrom) paged.showFrom(railIdx); else paged.follow(railIdx);
        // Re-center the starting word in the rail after the view is laid out.
        renderWord(engine.current(), engine.snapshot());
      });
    }
  }

  // Fade out the speed-read landing highlight a moment after it's shown. Adds a
  // CSS class that transitions the highlight away, then removes it.
  function fadePagedHighlight() {
    var pageEl = document.getElementById('page');
    if (!pageEl) return;
    var mark = pageEl.querySelector('.pg-word.pg-active');
    if (!mark) return;
    // Let it sit briefly at full strength, then add the fading class.
    setTimeout(function () {
      if (mark) mark.classList.add('pg-active-fade');
      setTimeout(function () {
        if (mark) mark.classList.remove('pg-active', 'pg-active-fade');
        if (paged) paged.activeIndex = -1;
      }, 1400); // matches the CSS transition duration
    }, 600);
  }

  /* ---------- Reading-pane collapse (speed-read mode only) ---------- */
  var paneCollapsed = false;
  function setupPaneToggle() {
    try {
      var s = Store.getSettings();
      paneCollapsed = !!s.paneCollapsed;
    } catch (e) { paneCollapsed = false; }
    applyPaneState();
    document.getElementById('paneToggle').addEventListener('click', togglePane);
    var mPane = document.getElementById('mPane');
    if (mPane) mPane.addEventListener('click', function () { togglePane(); closeMenu(); });
  }

  function togglePane() {
    paneCollapsed = !paneCollapsed;
    var btn = document.getElementById('paneToggle');
    try {
      var s = Store.getSettings(); s.paneCollapsed = paneCollapsed; Store.saveSettings(s);
    } catch (e) {}
    if (!paneCollapsed && currentView === 'rsvp' && paged) {
      // Reopening re-fits the strip (can take a moment on big books). Show the
      // loading state and let it PAINT (double rAF) before the heavy pagination
      // blocks the thread, so the button visibly reacts to the tap.
      if (btn) { btn.textContent = '\u2026 loading'; btn.disabled = true; btn.classList.add('loading'); }
      document.body.classList.add('pane-collapsed'); // keep strip hidden until built
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          document.body.classList.remove('pane-collapsed');
          paged.buildWhenReady(tokens, function () {
            paged.follow(engine ? engine.index : 0);
            if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
            applyPaneState();
          });
        });
      });
    } else {
      // Hiding is instant.
      document.body.classList.toggle('pane-collapsed', paneCollapsed);
      applyPaneState();
    }
  }

  function applyPaneState() {
    document.body.classList.toggle('pane-collapsed', paneCollapsed);
    var btn = document.getElementById('paneToggle');
    if (btn) btn.textContent = paneCollapsed ? '\u25BC show text' : '\u25B2 hide text';
    var mPane = document.getElementById('mPane');
    if (mPane) mPane.textContent = paneCollapsed ? 'Show reading pane' : 'Hide reading pane';
  }

  /* ---------- Tap interaction (identical for both reading areas) ----------
   * idle → tap area → 'armed' (box outlined + prompt). First tap never picks.
   * While armed: tap a word → highlight it + remember (selectedIndex); tapping
   *   another word moves the highlight. Box stays armed.
   *   Set start word → speed-read from selectedIndex.
   *   Open page read (rsvp only) → switch to paged.
   *   Cancel → drop selection, un-highlight, return to prior state.
   * No re-pagination happens here, so word positions never shift.
   */
  function setupTapPrompt() {
    els.rail.addEventListener('click', onRailTap);
    // Prompt buttons must not bubble to the page/rail tap handlers underneath.
    ['tpSetWord', 'tpExpand', 'tpCancel'].forEach(function (id) {
      document.getElementById(id).addEventListener('click', function (e) {
        e.stopPropagation();
      });
    });
    document.getElementById('tpSetWord').addEventListener('click', commitStartWord);
    document.getElementById('tpExpand').addEventListener('click', openPageRead);
    document.getElementById('tpCancel').addEventListener('click', cancelPrompt);
    // Also stop taps inside the prompt panel from reaching the page.
    var panel = document.querySelector('.tap-prompt-inner');
    if (panel) panel.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function onRailTap() {
    if (tapState === 'idle') arm();
    else cancelPrompt();   // tapping rail background while armed = cancel
  }

  // A tap inside the paged area. idx = word index, or null for a gap tap.
  function handlePageTap(idx) {
    // A swipe just turned the page; swallow the trailing synthetic tap so it
    // doesn't also arm/select a word.
    if (suppressNextPageTap) { suppressNextPageTap = false; return; }
    if (tapState === 'idle') { arm(); return; }   // first tap just arms
    if (tapState === 'picking') {                  // picking: this tap commits
      if (idx == null) return;
      startAt(idx);
      return;
    }
    if (idx == null) return;                       // gap tap while armed: ignore
    selectWord(idx);                               // move highlight, stay armed
  }

  // Arm: pause, outline the active box(es), show the prompt for the current view.
  function arm() {
    if (tapState === 'armed' || tapState === 'picking') return;
    if (engine) engine.pause();
    tapState = 'armed';
    selectedIndex = null;
    paintArmed(true);
    var msg = document.getElementById('tapPromptMsg');
    var exBtn = document.getElementById('tpExpand');
    if (currentView === 'rsvp') {
      msg.textContent = 'Tap a word to start there, or open page reading.';
      exBtn.hidden = false; exBtn.textContent = 'Open page read';
    } else {
      msg.textContent = 'Tap a word to start speed-reading there, or cancel.';
      exBtn.hidden = true;
    }
    document.getElementById('tpSetWord').hidden = false;
    document.getElementById('tapPrompt').hidden = false;
  }

  // Highlight a word and remember it. Stays armed (no view change).
  function selectWord(idx) {
    selectedIndex = idx;
    var prev = document.querySelector('#page .pg-word.picked');
    if (prev) prev.classList.remove('picked');
    var target = document.querySelector('#page .pg-word[data-index="' + idx + '"]');
    if (target) target.classList.add('picked');
    document.getElementById('tapPromptMsg').textContent =
      'Start speed-reading from \u201C' + (target ? target.textContent.trim() : 'here') + '\u201D, or cancel.';
  }

  // "Set start word": if a word is already selected, start there immediately.
  // Otherwise fall back to picking mode (next word tap starts).
  function commitStartWord() {
    var pk = document.querySelector('#page .pg-word.picked');
    var pick = pk ? parseInt(pk.dataset.index, 10) : selectedIndex;
    if (pick != null && !isNaN(pick)) { startAt(pick); return; }
    // No word chosen yet → enter picking mode.
    tapState = 'picking';
    document.getElementById('tpSetWord').hidden = true;
    document.getElementById('tpExpand').hidden = true;
    document.getElementById('tapPromptMsg').textContent =
      'Now tap any word in the text to start speed-reading there.';
  }

  // Start speed-reading at a given word index.
  function startAt(idx) {
    disarm();
    // Switch to the speed-read view FIRST so the rail is laid out, THEN seek —
    // this way the initial word is measured and centred in a visible rail instead
    // of landing off-centre until Play forces a re-render.
    switchView('rsvp');
    engine.seek(idx);
    // Put the chosen word at the TOP of the page strip (first word shown), so the
    // strip starts where speed-reading starts rather than showing it mid-page.
    if (paged.showFrom) paged.showFrom(idx); else paged.follow(idx);
    // One more centre pass after the view transition settles.
    requestAnimationFrame(function () { renderWord(engine.current(), engine.snapshot()); });
  }

  function openPageRead() { disarm(); switchView('read'); }

  // Cancel → drop everything, return to prior view untouched.
  function cancelPrompt() {
    var wasView = currentView;
    disarm();
    // Re-assert the current view so the layout is consistent (no autoplay,
    // no re-pagination of position).
    if (wasView === 'rsvp') { paged.follow(engine ? engine.index : 0); }
    else { paged.goToIndex(engine ? engine.index : 0); }
  }

  // Tear down the armed/prompt state (shared by commit/cancel/open).
  function disarm() {
    tapState = 'idle';
    selectedIndex = null;
    paintArmed(false);
    var prev = document.querySelector('#page .pg-word.picked');
    if (prev) prev.classList.remove('picked');
    document.getElementById('tapPrompt').hidden = true;
  }

  function paintArmed(on) {
    var page = document.getElementById('page');
    if (on) {
      page.classList.add('area-armed');
      if (currentView === 'rsvp') els.rail.classList.add('area-armed');
    } else {
      page.classList.remove('area-armed');
      els.rail.classList.remove('area-armed');
    }
  }


  // Render a token with the pivot pinned to rail centre.
  function renderWord(tok, snap) {
    if (!tok) return;
    els.idle.hidden = true;
    els.word.hidden = false;
    var t = tok.text;
    var p = tok.pivot;
    els.word.innerHTML =
      '<span class="pre"></span><span class="piv"></span><span class="post"></span>';
    els.word.querySelector('.pre').textContent = t.slice(0, p);
    els.word.querySelector('.piv').textContent = t.charAt(p);
    els.word.querySelector('.post').textContent = t.slice(p + 1);
    var centered = centerPivot();
    // If the rail wasn't laid out yet (word just set while the view was becoming
    // visible), the measurement was 0/stale and centerPivot() reported false —
    // re-centre on the next frame once layout settles, so it's centred without
    // needing to press Play. During normal playback the first measure succeeds,
    // so no extra frame work is scheduled.
    if (!centered) requestAnimationFrame(centerPivot);
    if (snap) updateProgressLabel(snap);
    // Keep the paged panel in lockstep with the speed-read word.
    if (currentView === 'rsvp' && paged) {
      paged.follow(snap ? snap.index : engine.index);
    }
  }

  // Pin the pivot letter's centre to the rail's centre. .word's left edge sits at
  // 50%; shift left by pre-width + half the pivot width, and up by half the word
  // height. Skips when widths read as 0 (not laid out yet) so we don't cache a
  // bad transform — the rAF re-call will catch it once measurable.
  function centerPivot() {
    if (!els.word || els.word.hidden) return false;
    var pre = els.word.querySelector('.pre');
    var piv = els.word.querySelector('.piv');
    if (!piv) return false;
    var pivW = piv.getBoundingClientRect().width;
    var wordH = els.word.getBoundingClientRect().height;
    if (pivW === 0 && wordH === 0) return false;   // not laid out yet; wait for rAF
    var shiftX = pre.getBoundingClientRect().width + pivW / 2;
    var shiftY = wordH / 2;
    els.word.style.transform = 'translate(' + (-shiftX) + 'px, ' + (-shiftY) + 'px)';
    return true;
  }

  function chapterName(i) {
    if (!book || !book.chapters[i]) return '';
    // Show the chapter's own title verbatim. Don't strip the number or renumber
    // by position — the book's label ("Chapter 1", "Letter 1") is authoritative.
    return book.chapters[i].title || ('Section ' + (i + 1));
  }

  function pauseLabel(v) {
    v = parseFloat(v);
    if (v <= 0.05) return 'even';
    if (v < 0.75) return 'short';
    if (v < 1.25) return 'normal';
    if (v < 1.75) return 'long';
    return 'longest';
  }
  function fmtTime(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var totalMin = Math.round(ms / 60000);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function setTopChapter(i) {
    if (els.chapterName) els.chapterName.textContent = chapterName(i);
  }

  function updateProgressLabel(snap) {
    // Until the whole book is tokenized, the global token count (snap.total) is
    // only a partial count, so a % would be wrong. Per the chosen behaviour, we
    // show the chapter name during that window and switch to an exact % once
    // fullyLoaded. Position within the book is always anchored by coordinate, so
    // reading/resuming is correct regardless of what the readout displays.
    setTopChapter(snap.chapter);
    if (els.chapterSel.value !== String(snap.chapter)) els.chapterSel.value = String(snap.chapter);

    if (fullyLoaded) {
      els.progress.innerHTML = 'word ' + (snap.index + 1).toLocaleString() +
        ' of ' + snap.total.toLocaleString() +
        ' · <span class="chapter-now">' + chapterName(snap.chapter) + '</span>';
      els.scrub.value = String(snap.index);
      var pct = snap.total ? Math.round(snap.index / snap.total * 100) : 0;
      els.pct.textContent = pct + '%';
      els.timeleft.textContent = engine ? 'time left ' + fmtTime(engine.timeLeftMs()) : '';
    } else {
      els.progress.innerHTML = '<span class="chapter-now">' + chapterName(snap.chapter) + '</span>';
      els.scrub.value = String(snap.index);
      els.pct.textContent = '';            // exact % deferred until load completes
      els.timeleft.textContent = 'loading…';
    }
  }

  function onState(snap) {
    els.play.textContent = snap.playing ? 'Pause' : (snap.index >= snap.total - 1 ? 'Replay' : 'Play');
    updateProgressLabel(snap);
    // Session pace is measured on PAGE TURNS only (see Wpm + onPageChange), so
    // nothing is fed from per-tick engine state here. This keeps the meter from
    // being skewed by re-renders that fire when tokenization/pagination finishes.
    // Debounced progress save — stored as a CONTENT COORDINATE so it resolves on
    // reopen without needing the whole book tokenized first.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var pct = fullyLoaded && snap.total ? Math.round(snap.index / snap.total * 100) : null;
      // Persist the exact page only when the paged view is active; in speed-read
      // the page isn't the meaningful position, so don't overwrite a good page
      // with a stale one (saveProgress keeps the previous page when null).
      var page = (currentView === 'read') ? curPageInChapter : null;
      Store.saveProgress(bookId, currentCoord(), snap.chapter, currentView, pct, page);
    }, 400);
  }

  function wireControls() {
    els.play.addEventListener('click', function () { engine.toggle(); });
    document.getElementById('fwd1').addEventListener('click', function () { engine.step(1); });
    document.getElementById('back1').addEventListener('click', function () { engine.step(-1); });
    document.getElementById('fwd30').addEventListener('click', function () { engine.skipTime(30000); });
    document.getElementById('back30').addEventListener('click', function () { engine.skipTime(-30000); });

    els.scrub.addEventListener('input', function () { engine.seek(parseInt(els.scrub.value, 10)); });
    els.chapterSel.addEventListener('change', function () {
      var ch = parseInt(els.chapterSel.value, 10);
      jumpToChapter(ch);
    });

    function setWpm(v) {
      v = Math.max(150, Math.min(900, v | 0));
      els.wpm.value = v; els.wpmVal.textContent = v + ' wpm';
      engine.setWpm(v);
      settings = Store.getSettings(); settings.wpm = v; Store.saveSettings(settings);
    }
    els.wpm.addEventListener('input', function () { setWpm(parseInt(els.wpm.value, 10)); });

    // Click the WPM number to type an exact value.
    function openWpmEdit() {
      els.wpmInput.value = String(engine.wpm);
      els.wpmVal.hidden = true; els.wpmInput.hidden = false;
      els.wpmInput.focus(); els.wpmInput.select();
    }
    function commitWpmEdit() {
      var v = parseInt(els.wpmInput.value, 10);
      els.wpmInput.hidden = true; els.wpmVal.hidden = false;
      if (!isNaN(v)) setWpm(v);
    }
    els.wpmVal.addEventListener('click', openWpmEdit);
    els.wpmVal.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWpmEdit(); }
    });
    els.wpmInput.addEventListener('blur', commitWpmEdit);
    els.wpmInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitWpmEdit(); }
      else if (e.key === 'Escape') { els.wpmInput.hidden = true; els.wpmVal.hidden = false; }
    });

    // Keyboard: space=play/pause, arrows=step, shift+arrows=±30s
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); engine.toggle(); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); e.shiftKey ? engine.skipTime(30000) : engine.step(1); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? engine.skipTime(-30000) : engine.step(-1); }
    });

    function saveNow() {
      if (!engine) return;
      var snap = engine.snapshot();
      var pct = fullyLoaded && snap.total ? Math.round(snap.index / snap.total * 100) : null;
      var page = (currentView === 'read') ? curPageInChapter : null;
      Store.saveProgress(bookId, currentCoord(), snap.chapter, currentView, pct, page);
    }
    window.addEventListener('beforeunload', saveNow);
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveNow();
    });
  }

  // Keep the screen awake while the reader is open, so the display doesn't dim or
  // lock mid-page. (A screen dim also disrupts the session pace meter's timing.)
  // Uses the Screen Wake Lock API (Safari 16.4+, Chrome/Firefox); the browser
  // auto-releases the lock when the tab is hidden, so we re-acquire it whenever
  // the page becomes visible again. Fails silently where unsupported or when the
  // OS refuses (e.g. low battery) — reading still works, the screen just dims.
  var _wakeLock = null;
  function acquireWakeLock() {
    try {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(function (wl) {
        _wakeLock = wl;
        wl.addEventListener('release', function () { _wakeLock = null; });
      }).catch(function () { /* refused (battery/policy) — ignore */ });
    } catch (e) { /* unsupported — ignore */ }
  }
  document.addEventListener('visibilitychange', function () {
    // Re-acquire after returning from a lock/tab-switch (the lock auto-released).
    if (document.visibilityState === 'visible' && !_wakeLock) acquireWakeLock();
  });
  acquireWakeLock();
  // iOS may reject the first request until a user gesture has occurred, so also
  // try once on the first interaction. { once: true } keeps it a one-time cost.
  ['pointerdown', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, function () { if (!_wakeLock) acquireWakeLock(); }, { once: true });
  });

  // One-time cleanup: earlier builds cached tokenized books in an IndexedDB
  // named 'rsvp-reader'. That cache was removed (it added reopen lag), so delete
  // the leftover database if present. Best-effort and harmless if it's absent.
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB && indexedDB.deleteDatabase) {
      indexedDB.deleteDatabase('rsvp-reader');
    }
  } catch (e) {}

  if (!bookId) fail('No book specified.');
  else loadBook();
})();
