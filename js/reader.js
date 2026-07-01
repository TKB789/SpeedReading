/* reader.js — wires the RSVP engine to the rail, controls, and persistence. */
(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search);
  var bookId = params.get('book');
  var src = params.get('src') || 'repo';

  // Clear #page's token content but preserve the [data-keep] egg footer, then
  // re-append it so it stays at the bottom. Used wherever we'd otherwise wipe the
  // page via innerHTML. Idempotent and safe if no egg exists.
  function clearPageKeepingEgg(pageEl, html) {
    if (!pageEl) return;
    var egg = pageEl.querySelector('[data-keep]');
    pageEl.innerHTML = html || '';
    if (egg) pageEl.appendChild(egg);
  }

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

  function openMenu() { els.settingsMenu.hidden = false; }
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

  Store.requestPersistence();

  var engine = null, tokens = null, book = null, saveTimer = null;
  var chapterStart = {};      // chapter → first index in `tokens` (rebuilt as it grows)
  var fullyLoaded = false;    // every chapter tokenized → global % is exact
  var resumeMode = 'read';
  // Loading-state machinery: an AbortController so we can cancel a slow fetch,
  // plus timers that escalate the message ("taking longer…") and eventually
  // give up. loadDone() clears all of this once the book is ready or has failed.
  var loadController = null;
  var slowTimer = null, giveUpTimer = null, loadFinished = false;
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
    clearPageKeepingEgg(pageEl);
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
    clearTimeout(slowTimer); clearTimeout(giveUpTimer);
  }

  // Called once the book is parsed/tokenized and the reader is live. Removes the
  // escape box and stops the slow/timeout timers.
  function loadDone() {
    loadFinished = true;
    clearTimeout(slowTimer); clearTimeout(giveUpTimer);
    var box = document.getElementById('loadEscape');
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  function loadBook() {
    showLoadingEscape();
    setLoadingMsg('Loading this book…');

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
    if (pageEl) clearPageKeepingEgg(pageEl, '<p class="pg-para" style="text-indent:0;color:var(--fg-dim);font-style:italic">' +
      msg + '</p><p class="pg-para" style="text-indent:0;color:var(--fg-dim)">' +
      'Open a book from the <a href="' + LIBRARY_URL + '" style="color:var(--rubric)">Library</a>.</p>');
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

    settings = Store.getSettings();
    var startWpm = settings.wpm || 400;
    // Pauses are fixed at "longest" (2) — the slider was removed. Always use the
    // max so sentence/paragraph breaks get the fullest pause.
    var startPause = 2;
    els.wpm.value = startWpm; els.wpmVal.textContent = startWpm + ' wpm';

    var FIRST_CHUNK = 2;          // chapters before first paint (cold open)
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
    var loadedFromCache = false;

    // Fast path: if this book's full tokenization is cached (from a prior open),
    // load it directly and skip ALL re-tokenization — this removes the reopen lag.
    // The cache is async (IndexedDB); we kick off a check, and if it misses (or
    // isn't available) we fall back to the normal incremental tokenization.
    function beginLoad() {
      if (typeof TokenCache !== 'undefined' && TokenCache.available()) {
        TokenCache.get(bookId).then(function (cached) {
          if (cached && cached.length) { loadFromCache(cached); }
          else { beginIncremental(); }
        }).catch(function () { beginIncremental(); });
      } else {
        beginIncremental();
      }
    }

    // Load a fully-tokenized book from cache in one shot, then go live.
    function loadFromCache(cached) {
      loadedFromCache = true;
      for (var i = 0; i < cached.length; i++) tokens.push(cached[i]);
      indexChapters();
      if (isDeepResume) {
        var startIdx = Coords.resolve(tokens, resumeCoord, chapterStart);
        engine.index = startIdx < 0 ? 0 : startIdx;
      } else {
        engine.index = 0;
      }
      fullyLoaded = true;            // the whole book is present immediately
      goLive();
      updateScrubMax();
      if (engine) onState(engine.snapshot());
      // Totals can compute right away since every chapter is present.
      if (paged && book && book.chapters) {
        paged.computeTotals(book.chapters.length, function () { refreshPagedStatus(); });
      }
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
      switchView(resumeMode === 'rsvp' ? 'rsvp' : 'read', { keepIndex: true });
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
        // Persist the fully-tokenized book so the NEXT open skips re-tokenizing
        // (the main reopen lag). Tokens are in chapter order here. Fire-and-forget
        // — caching is a pure optimization; failure just means we re-tokenize.
        if (!loadedFromCache && typeof TokenCache !== 'undefined' && TokenCache.available()) {
          try { TokenCache.put(bookId, tokens.slice()); } catch (e) {}
        }
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
    paged.buildWhenReady(tokens, function () {
      paged.goToIndex(engine ? engine.index : 0);
    });

    document.getElementById('pagePrev').addEventListener('click', function () { paged.prev(); });
    document.getElementById('pageNext').addEventListener('click', function () { paged.next(); });
    document.getElementById('mRead').addEventListener('click', function () { switchView('read'); closeMenu(); });
    document.getElementById('mRsvp').addEventListener('click', function () { switchView('rsvp'); closeMenu(); });

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
        if (dx < 0) paged.next(); else paged.prev();
      }
    }, { passive: true });
  }
  var suppressNextPageTap = false;

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
  // opts.keepIndex: don't re-anchor the engine (used by startAt, which seeks to a
  // tapped word right after switching).
  function switchView(view, opts) {
    opts = opts || {};
    var cameFromRsvp = (currentView === 'rsvp');
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
      // Speed-read: small page strip follows above the rail.
      rsvpView.hidden = false; readView.hidden = false;
      paged.buildWhenReady(tokens, function () {
        // Entering speed-read from PAGED mode without picking a word: start at the
        // first word visible on the current page — NOT the stale saved position
        // the engine last left off at. (When a word was tapped, startAt passes
        // keepIndex and seeks to that word itself, so we don't override it.)
        if (!cameFromRsvp && !opts.keepIndex && engine && paged) {
          var pageStart = paged.firstIndex;
          if (pageStart != null && pageStart >= 0) engine.seek(pageStart);
        }
        paged.follow(engine ? engine.index : 0);
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
    switchView('rsvp', { keepIndex: true });
    engine.seek(idx);
    paged.follow(idx);
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
    // Debounced progress save — stored as a CONTENT COORDINATE so it resolves on
    // reopen without needing the whole book tokenized first.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var pct = fullyLoaded && snap.total ? Math.round(snap.index / snap.total * 100) : null;
      Store.saveProgress(bookId, currentCoord(), snap.chapter, currentView, pct);
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
      Store.saveProgress(bookId, currentCoord(), snap.chapter, currentView, pct);
    }
    window.addEventListener('beforeunload', saveNow);
    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveNow();
    });
  }

  if (!bookId) fail('No book specified.');
  else loadBook();
})();
