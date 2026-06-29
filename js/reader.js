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

    // Chapter dropdown
    b.chapters.forEach(function (c, i) {
      var opt = document.createElement('option');
      opt.value = i; opt.textContent = (i + 1) + '. ' + c.title.replace(/^CHAPTER\s+[IVXLCDM\d]+\.?\s*—?\s*/i, '');
      els.chapterSel.appendChild(opt);
    });

    tokens = RSVP.tokenize(b.chapters);
    settings = Store.getSettings();
    var startWpm = settings.wpm || 400;
    var startPause = settings.pauseScale != null ? settings.pauseScale : 1;
    els.wpm.value = startWpm; els.wpmVal.textContent = startWpm + ' wpm';
    els.pauseScale.value = startPause; els.pauseVal.textContent = pauseLabel(startPause);

    engine = new RSVP.Engine(tokens, {
      wpm: startWpm,
      pauseScale: startPause,
      onRender: renderWord,
      onState: onState,
      onEnd: function () { els.play.textContent = 'Replay'; }
    });

    els.scrub.max = String(Math.max(0, tokens.length - 1));

    // Build the paged reader from the same token stream.
    setupPaged();

    // Resume position and mode
    var prog = Store.getProgress(bookId);
    var resumeMode = 'read';
    if (prog && prog.index > 0 && prog.index < tokens.length) {
      engine.index = prog.index;
      resumeMode = prog.mode || 'read';
      renderWord(engine.current(), engine.snapshot());
      onState(engine.snapshot());
    } else {
      updateProgressLabel(engine.snapshot());
    }
    if (paged) paged.goToIndex(engine.index);
    wireControls();
    // Apply saved mode (defaults to read). switchView positions the page too.
    switchView(resumeMode === 'rsvp' ? 'rsvp' : 'read');
    // Reader is live — tear down the loading/escape UI and stop its timers.
    loadDone();
  }

  var paged = null, currentView = 'read';
  // Tap interaction state: 'idle' (normal) or 'armed' (box outlined, prompt up).
  var tapState = 'idle';
  var selectedIndex = null;   // word chosen while armed (null = none yet)

  function setupPaged() {
    var pageEl = document.getElementById('page');
    paged = new Paged(pageEl, {
      onWordTap: handlePageTap,
      cacheId: (src === 'user' ? 'u:' : '') + bookId,
      cacheLoad: function (key) { return Store.getPageCache(key); },
      cacheSave: function (key, pages) { Store.savePageCache(key, pages); },
      onPageChange: function (info) {
        document.getElementById('pageNum').textContent =
          'page ' + info.page + ' of ' + info.total;
        if (paged && paged.words && paged.pages[paged.current]) {
          var fw = paged.words[paged.pages[paged.current].startWord];
          if (fw) setTopChapter(fw.chapter);
        }
      }
    });
    paged.enableTaps();
    paged.buildWhenReady(tokens, function () {
      paged.goToIndex(engine ? engine.index : 0);
    });

    document.getElementById('pagePrev').addEventListener('click', function () { paged.prev(); });
    document.getElementById('pageNext').addEventListener('click', function () { paged.next(); });
    document.getElementById('mRead').addEventListener('click', function () { switchView('read'); closeMenu(); });
    document.getElementById('mRsvp').addEventListener('click', function () { switchView('rsvp'); closeMenu(); });

    setupTapPrompt();
    setupPaneToggle();

    var rzTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(function () {
        var anchor = engine ? engine.index : 0;
        paged.build(tokens, true); // force: viewport actually changed
        paged.goToIndex(anchor);
        if (currentView === 'rsvp') paged.follow(anchor);
      }, 200);
    });
  }

  // Switch between paged ('read') and speed-read ('rsvp'). Never autoplays.
  function switchView(view) {
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
      paged.buildWhenReady(tokens, function () { paged.goToIndex(engine ? engine.index : 0); });
    } else {
      // Speed-read: small page strip follows above the rail.
      rsvpView.hidden = false; readView.hidden = false;
      paged.buildWhenReady(tokens, function () { paged.follow(engine ? engine.index : 0); });
    }
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
    engine.seek(idx);
    switchView('rsvp');
    paged.follow(idx);
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
    // Pin pivot centre to the rail's centre guide. .word's left edge is at
    // 50% (the guide); shift left by pre-width + half the pivot width, and up
    // by half the word height for vertical centring.
    var pre = els.word.querySelector('.pre');
    var piv = els.word.querySelector('.piv');
    var shiftX = pre.getBoundingClientRect().width + piv.getBoundingClientRect().width / 2;
    var shiftY = els.word.getBoundingClientRect().height / 2;
    els.word.style.transform = 'translate(' + (-shiftX) + 'px, ' + (-shiftY) + 'px)';
    if (snap) updateProgressLabel(snap);
    // Keep the paged panel in lockstep with the speed-read word.
    if (currentView === 'rsvp' && paged && paged.pages && paged.pages.length) {
      paged.follow(snap ? snap.index : engine.index);
    }
  }

  function chapterName(i) {
    if (!book) return '';
    var raw = book.chapters[i] ? book.chapters[i].title : '';
    return raw.replace(/^CHAPTER\s+[IVXLCDM\d]+\.?\s*—?\s*/i, '') || ('Chapter ' + (i + 1));
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
    els.progress.innerHTML = 'word ' + (snap.index + 1).toLocaleString() +
      ' of ' + snap.total.toLocaleString() +
      ' · <span class="chapter-now">' + chapterName(snap.chapter) + '</span>';
    els.scrub.value = String(snap.index);
    if (els.chapterSel.value !== String(snap.chapter)) els.chapterSel.value = String(snap.chapter);
    setTopChapter(snap.chapter);
    var pct = snap.total ? Math.round(snap.index / snap.total * 100) : 0;
    els.pct.textContent = pct + '%';
    if (engine) els.timeleft.textContent = 'time left ' + fmtTime(engine.timeLeftMs());
  }

  function onState(snap) {
    els.play.textContent = snap.playing ? 'Pause' : (snap.index >= snap.total - 1 ? 'Replay' : 'Play');
    updateProgressLabel(snap);
    // Debounced progress save
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      Store.saveProgress(bookId, snap.index, snap.chapter, currentView);
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
      engine.seekChapter(parseInt(els.chapterSel.value, 10));
      if (paged && currentView === 'read') paged.goToIndex(engine.index);
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

    els.pauseScale.addEventListener('input', function () {
      var v = parseFloat(els.pauseScale.value);
      els.pauseVal.textContent = pauseLabel(v);
      engine.setPauseScale(v);
      settings = Store.getSettings(); settings.pauseScale = v; Store.saveSettings(settings);
    });

    // Keyboard: space=play/pause, arrows=step, shift+arrows=±30s
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); engine.toggle(); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); e.shiftKey ? engine.skipTime(30000) : engine.step(1); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? engine.skipTime(-30000) : engine.step(-1); }
    });

    function saveNow() {
      if (engine) Store.saveProgress(bookId, engine.index, engine.snapshot().chapter, currentView);
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
