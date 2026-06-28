/* reader.js — wires the RSVP engine to the rail, controls, and persistence. */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var bookId = params.get('book');
  var src = params.get('src') || 'repo';

  var els = {
    title: document.getElementById('bookTitle'),
    author: document.getElementById('bookAuthor'),
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
    themeBtn: document.getElementById('themeBtn')
  };

  // Theme
  var settings = Store.getSettings();
  document.documentElement.setAttribute('data-theme', settings.theme);
  els.themeBtn.addEventListener('click', function () {
    settings = Store.getSettings();
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    Store.saveSettings(settings);
    document.documentElement.setAttribute('data-theme', settings.theme);
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
    els.idle.textContent = msg;
  }

  function setup(b) {
    book = b;
    els.title.textContent = b.title;
    els.author.textContent = b.author || '';
    document.title = b.title + ' — RSVP Reader';

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

    // Resume
    var prog = Store.getProgress(bookId);
    if (prog && prog.index > 0 && prog.index < tokens.length) {
      engine.index = prog.index;
      renderWord(engine.current(), engine.snapshot());
      onState(engine.snapshot());
    } else {
      updateProgressLabel(engine.snapshot());
    }
    wireControls();
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

  function updateProgressLabel(snap) {
    els.progress.innerHTML = 'word ' + (snap.index + 1).toLocaleString() +
      ' of ' + snap.total.toLocaleString() +
      ' · <span class="chapter-now">' + chapterName(snap.chapter) + '</span>';
    els.scrub.value = String(snap.index);
    if (els.chapterSel.value !== String(snap.chapter)) els.chapterSel.value = String(snap.chapter);
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
      Store.saveProgress(bookId, snap.index, snap.chapter);
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

    window.addEventListener('beforeunload', function () {
      if (engine) Store.saveProgress(bookId, engine.index, engine.snapshot().chapter);
    });
  }

  if (!bookId) fail('No book specified.');
  else loadBook();
})();
