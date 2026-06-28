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

  function loadBook() {
    if (src === 'user') {
      var b = Store.getUserBook(bookId);
      if (!b) return fail('That uploaded book is no longer in this browser.');
      return setup(b);
    }
    fetch('books/' + encodeURIComponent(bookId) + '.json')
      .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(setup)
      .catch(function () { fail('Could not load that book.'); });
  }
  function fail(msg) {
    els.title.textContent = 'Unavailable';
    if (els.idle) els.idle.textContent = msg;
    // Also show it in the paged panel, which is the visible view by default.
    var pageEl = document.getElementById('page');
    if (pageEl) pageEl.innerHTML = '<p class="pg-para" style="text-indent:0;color:var(--fg-dim);font-style:italic">' +
      msg + '</p><p class="pg-para" style="text-indent:0;color:var(--fg-dim)">' +
      'Open a book from the <a href="index.html?home" style="color:var(--rubric)">Library</a>.</p>';
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
  }

  var paged = null, currentView = 'read';
  var tapState = 'idle'; // 'idle' | 'prompt' | 'picking'

  function setupPaged() {
    var pageEl = document.getElementById('page');
    paged = new Paged(pageEl, {
      onWordTap: function (idx) {
        handleWordTap(idx);
      },
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
    document.body.classList.add('mode-read');

    var rzTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(function () {
        if (currentView === 'read') {
          var anchor = engine ? engine.index : 0;
          paged.build(tokens, true); // force: viewport changed
          paged.goToIndex(anchor);
        }
      }, 200);
    });
  }

  function switchView(view) {
    currentView = view;
    var readView = document.getElementById('pagedView');
    var rsvpView = document.getElementById('rsvpView');
    var mRead = document.getElementById('mRead');
    var mRsvp = document.getElementById('mRsvp');
    document.body.classList.toggle('mode-rsvp', view === 'rsvp');
    document.body.classList.toggle('mode-read', view === 'read');
    if (view === 'read') {
      if (engine) engine.pause();
      rsvpView.hidden = true; readView.hidden = false;
      mRead.setAttribute('aria-checked', 'true');
      mRsvp.setAttribute('aria-checked', 'false');
      paged.buildWhenReady(tokens, function () {
        paged.highlight(engine ? engine.index : 0);
      });
    } else {
      // Speed-read: rail visible AND the page panel follows along above it.
      rsvpView.hidden = false; readView.hidden = false;
      mRead.setAttribute('aria-checked', 'false');
      mRsvp.setAttribute('aria-checked', 'true');
      paged.buildWhenReady(tokens, function () {
        paged.follow(engine ? engine.index : 0);
      });
    }
  }

  /* ---------- Tap interaction (unified for both reading areas) ----------
   * idle → (tap area) → armed: box highlighted, prompt shown.
   *   While armed, tapping a WORD highlights it and remembers it (selectedIndex);
   *   tapping another word just moves the highlight. The box stays armed.
   *   'Set start word' → speed-read from the selected word (or, if none picked
   *     yet, prompt to tap one). 'Open page read' (rsvp only) switches modes.
   *   'Cancel' drops the selection, un-highlights, and resumes the prior state.
   */
  var selectedIndex = null;

  function setupTapPrompt() {
    els.rail.addEventListener('click', function () { onAreaTap('rsvp'); });
    document.getElementById('tpCancel').addEventListener('click', cancelPrompt);
    document.getElementById('tpSetWord').addEventListener('click', commitStartWord);
    document.getElementById('tpExpand').addEventListener('click', function () {
      clearArmed(); clearSelectedWord();
      document.getElementById('tapPrompt').hidden = true;
      tapState = 'idle';
      switchView('read');
    });
  }

  function onAreaTap(mode) {
    if (tapState === 'idle') { armPrompt(mode); return; }
    // Tapping the rail background while armed = cancel (resume).
    cancelPrompt();
  }

  function armPrompt(mode) {
    var prompt = document.getElementById('tapPrompt');
    var msg = document.getElementById('tapPromptMsg');
    if (engine) engine.pause();
    tapState = 'armed';
    selectedIndex = null;
    clearArmed();
    var setBtn = document.getElementById('tpSetWord');
    var exBtn = document.getElementById('tpExpand');
    if (mode === 'rsvp') {
      els.rail.classList.add('area-armed');
      document.getElementById('page').classList.add('area-armed');
      msg.textContent = 'Tap a word to start there, or open page reading.';
      exBtn.hidden = false; exBtn.textContent = 'Open page read';
    } else {
      document.getElementById('page').classList.add('area-armed');
      msg.textContent = 'Tap a word to start speed-reading there, or cancel.';
      exBtn.hidden = true;
    }
    setBtn.hidden = false;
    document.getElementById('tpCancel').textContent = 'Cancel';
    prompt.hidden = false;
  }

  // "Set start word": act on the selected word now. If nothing selected yet,
  // nudge the user to tap one (stay armed).
  function commitStartWord() {
    if (selectedIndex == null) {
      document.getElementById('tapPromptMsg').textContent =
        'Tap a word in the text first, then press Set start word.';
      return;
    }
    var pick = selectedIndex;
    clearArmed(); clearSelectedWord();
    document.getElementById('tapPrompt').hidden = true;
    tapState = 'idle';
    engine.seek(pick);
    switchView('rsvp');
    paged.follow(pick);
  }

  function clearArmed() {
    els.rail.classList.remove('area-armed');
    document.getElementById('page').classList.remove('area-armed');
  }

  function clearSelectedWord() {
    selectedIndex = null;
    var prev = document.querySelector('.pg-word.picked');
    if (prev) prev.classList.remove('picked');
  }

  // Cancel: drop selection, un-highlight, resume what we were doing.
  function cancelPrompt() {
    document.getElementById('tapPrompt').hidden = true;
    clearArmed(); clearSelectedWord();
    tapState = 'idle';
    if (currentView === 'rsvp') switchView('rsvp');
  }

  // Tap on a word in the paged area. idx = word index, or null for a gap tap.
  function handleWordTap(idx) {
    if (tapState === 'idle') { armPrompt(currentView); return; }
    if (tapState !== 'armed') return;
    if (idx == null) return; // gap tap while armed: ignore (keep selection)
    // Select / move the highlight to this word; stay armed.
    selectedIndex = idx;
    var prev = document.querySelector('.pg-word.picked');
    if (prev) prev.classList.remove('picked');
    // Find the span carrying this index (or nearest at-or-before it).
    var spans = document.querySelectorAll('#page .pg-word');
    var target = null;
    for (var i = 0; i < spans.length; i++) {
      if (parseInt(spans[i].dataset.index, 10) <= idx) target = spans[i];
      else break;
    }
    if (target) target.classList.add('picked');
    document.getElementById('tapPromptMsg').textContent =
      'Start speed-reading from “' + (target ? target.textContent.trim() : 'selected') +
      '”, or cancel.';
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
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
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
