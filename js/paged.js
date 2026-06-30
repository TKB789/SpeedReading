/* paged.js — windowed-lazy paged reader sharing the RSVP token stream.
 *
 * Unlike the old version, this NEVER paginates the whole book. It lays out only
 * the screen the reader is currently on, measured against the real page box, and
 * paginates the adjacent screen on demand when turning pages or when the RSVP
 * word crosses off the visible screen. Load time is therefore constant — a
 * 1,000-word book and a 1,000,000-word book open equally fast.
 *
 * Position is expressed purely as a TOKEN INDEX (and a derived %). There is no
 * page-count, no pages[] array, and no pagination cache.
 *
 * Exposes window.Paged with: build(tokens), goToIndex(i), follow(i), highlight(i),
 * next(), prev(), enableTaps(), onWordTap(cb), pageInfo(), locationPct().
 */
(function (root) {
  'use strict';

  function Paged(pageEl, opts) {
    opts = opts || {};
    this.pageEl = pageEl;
    this.tokens = [];
    this.startPos = 0;          // first token position laid out on the screen
    this.endPos = 0;            // one past the last token position on the screen
    this.firstIndex = 0;        // first engine index visible on the screen
    this.lastIndex = 0;         // last engine index visible on the screen
    this._startStack = [];      // remembered screen-start positions, for exact prev
    this._chapterTitles = null; // chapter index → title (for in-page headings)
    this.onTap = opts.onWordTap || function () {};
    this.onPageChange = opts.onPageChange || function () {};
    this._builtH = 0; this._builtW = 0;
  }

  // Provide chapter titles so the paged view shows a heading at the top of each
  // chapter. `titles` is indexed by chapter number (matching tokens' .chapter).
  Paged.prototype.setChapterTitles = function (titles) {
    this._chapterTitles = titles || null;
  };

  // ---- display words are produced LAZILY, one per token position, on demand.
  // A "display word" merges any soft-hyphen continuation chunks (rare; only for
  // words longer than the tokenizer's maxWordLength) back into one tappable word
  // that still maps to the FIRST chunk's engine index. We never materialize the
  // whole book — _wordAt(pos) builds just the word starting at token `pos` and
  // returns { word, nextPos } so callers can walk a screen's worth and stop.
  //
  // pos === token index in the common case (no splitting). When a merge spans
  // several tokens, the merged word occupies one display slot but advances
  // nextPos past all its chunks.
  Paged.prototype._wordAt = function (pos) {
    var toks = this.tokens;
    var t = toks[pos];
    if (!t) return null;
    var text = t.text;
    var i = pos;
    while (/\u00AD$/.test(toks[i] && toks[i].text)) {
      i++;
      if (i < toks.length) text = text.replace(/\u00AD$/, '') + toks[i].text;
      else break;
    }
    return {
      word: { text: text.replace(/\u00AD/g, ''), index: pos, para: t.para, chapter: t.chapter },
      nextPos: i + 1
    };
  };

  // Map an engine token index → the token position that begins its display word.
  // Because a display word maps to its FIRST chunk's index and chunks are
  // contiguous, the position that begins the word containing `idx` is `idx`
  // itself unless `idx` lands on a continuation chunk — in which case we walk
  // back over the soft-hyphen run (at most a handful of chars; effectively never
  // hit with default settings). O(1) amortized, no full-book scan.
  Paged.prototype._wordPosOfIndex = function (idx) {
    var toks = this.tokens;
    idx = Math.max(0, Math.min(toks.length - 1, idx | 0));
    var p = idx;
    while (p > 0 && toks[p - 1] && /\u00AD$/.test(toks[p - 1].text)) p--;
    return p;
  };

  // ---- core: lay out one screen FORWARD starting at token position `fromPos`.
  // Walks tokens via _wordAt (lazy, no precomputed array), filling the page box
  // until the next word would overflow its height, then stops. Records the token
  // positions [startPos, endPos) and the first/last engine indices on screen.
  // Returns true unless the box has no height yet.
  Paged.prototype._layoutForward = function (fromPos) {
    var el = this.pageEl;
    var maxH = el.clientHeight;
    if (!maxH || maxH < 40) return false;
    var toks = this.tokens;
    fromPos = Math.max(0, Math.min(toks.length, fromPos | 0));

    el.innerHTML = '';
    var lastPara = -1, curPara = null;
    var pos = fromPos;
    var firstIdx = -1, lastIdx = -1;
    var lastChapter = -1;
    while (pos < toks.length) {
      var dw = this._wordAt(pos);
      if (!dw) break;
      var w = dw.word;
      // Show a chapter heading when this word is the genuine FIRST token of its
      // chapter (the previous token belongs to a different chapter, or this is
      // the book's first token). This is unambiguous and only ever fires once
      // per chapter, at its real beginning — never mid-chapter.
      if (w.chapter !== lastChapter) {
        var isChapterFirstToken = (pos === 0) ||
          (toks[pos - 1] && toks[pos - 1].chapter !== w.chapter);
        if (isChapterFirstToken && this._chapterTitles &&
            this._chapterTitles[w.chapter] != null) {
          var hd = document.createElement('div');
          hd.className = 'pg-chapter-title';
          hd.textContent = this._chapterTitles[w.chapter];
          el.appendChild(hd);
          if (el.scrollHeight > maxH && (firstIdx >= 0)) {
            // No room for the heading on a screen that already has content —
            // end the screen here so the heading leads the next screen instead.
            el.removeChild(hd);
            break;
          }
          if (el.scrollHeight > maxH) {
            // Heading alone overflows an empty screen (huge title); keep it
            // anyway so we make progress, but don't add words.
          }
        }
        lastChapter = w.chapter;
        lastPara = -1; // a new chapter always starts a fresh paragraph
      }
      if (w.para !== lastPara) {
        curPara = document.createElement('p');
        curPara.className = 'pg-para';
        el.appendChild(curPara);
        lastPara = w.para;
      }
      var span = document.createElement('span');
      span.className = 'pg-word';
      span.textContent = w.text + ' ';
      span.dataset.index = w.index;
      curPara.appendChild(span);
      if (el.scrollHeight > maxH) {
        curPara.removeChild(span);
        if (!curPara.childNodes.length) el.removeChild(curPara);
        break;
      }
      if (firstIdx < 0) firstIdx = w.index;
      lastIdx = w.index;
      pos = dw.nextPos;
    }
    // Guarantee progress: show at least one word even if it alone overflows.
    if (pos === fromPos && fromPos < toks.length) {
      var one = this._wordAt(fromPos);
      pos = one ? one.nextPos : fromPos + 1;
      firstIdx = one ? one.word.index : fromPos;
      lastIdx = firstIdx;
    }
    this.startPos = fromPos;
    this.endPos = pos;
    this.firstIndex = firstIdx < 0 ? 0 : firstIdx;
    this.lastIndex = lastIdx < 0 ? this.firstIndex : lastIdx;
    this._builtH = maxH; this._builtW = el.clientWidth;
    this.onPageChange(this.pageInfo());
    return true;
  };

  // --- Deterministic backward layout. When there's no remembered start to pop
  // back to (e.g. the reader opened mid-book then pressed prev), we must compute
  // the previous screen's start. The key to consistency: the previous screen is
  // the one whose FORWARD layout ends exactly at `beforePos`. We find its start
  // by scanning candidate starts and laying each forward until one ends at
  // beforePos. To keep it cheap we start a screenful back and walk the start
  // DOWN until the forward layout from it reaches beforePos, then accept the
  // largest such start (the tightest fit). This is the exact inverse of forward
  // pagination, so prev→next→prev always lands on the same boundaries.
  Paged.prototype._layoutBackward = function (beforePos) {
    if (beforePos <= 0) { this._layoutForward(0); return; }
    var screenful = Math.max(8, this.endPos - this.startPos);
    // Start a bit more than one screen back, then refine.
    var start = Math.max(0, beforePos - Math.ceil(screenful * 1.4));
    // Lay forward from `start`; this defines a screen [start, end).
    this._layoutForward(start);
    // If that screen ends before beforePos, there's a gap — nudge start up until
    // the forward layout ends AT beforePos (no gap, no overlap).
    var guard = 0;
    while (this.endPos < beforePos && guard++ < screenful + 4) {
      start = this.startPos + 1;
      if (start >= beforePos) { start = Math.max(0, beforePos - 1); this._layoutForward(start); break; }
      this._layoutForward(start);
    }
    // If it ends past beforePos, step start down until it ends at/just below it,
    // so we never overlap the screen we turned back from.
    guard = 0;
    while (this.endPos > beforePos && this.startPos > 0 && guard++ < screenful + 4) {
      start = this.startPos - 1;
      this._layoutForward(start);
    }
    // Final layout is the previous screen; record its exact start so future
    // forward/back from here is stable.
    this.startPos = this.startPos;   // (already set by _layoutForward)
  };

  // Public: (re)build at the current size. tokens optional. Renders the screen
  // starting at the last-known start position (default 0). Resets nav history,
  // since a rebuild (resize / open) re-anchors the reading position.
  Paged.prototype.build = function (tokens) {
    if (tokens) this.tokens = tokens;
    this._startStack = [];
    return this._layoutForward(this.startPos || 0);
  };

  // Build with retry until the box has real height (fonts/layout settling).
  Paged.prototype.buildWhenReady = function (tokens, cb) {
    var self = this;
    if (tokens) this.tokens = tokens;
    this._startStack = [];
    var tries = 0;
    (function attempt() {
      if (self._layoutForward(self.startPos || 0)) { if (cb) cb(); return; }
      if (tries++ < 40) setTimeout(attempt, 50);
    })();
  };

  // Show the screen containing a given engine token index. A jump (chapter
  // select, tap, resume) is a fresh anchor, so clear the back-history — the
  // boundaries before a jump no longer connect to where we are now.
  Paged.prototype.goToIndex = function (idx) {
    this._startStack = [];
    this._layoutForward(this._wordPosOfIndex(idx));
  };

  // Mark a word active and show its screen (used for explicit jumps/highlights).
  Paged.prototype.highlight = function (idx) {
    this.activeIndex = idx;
    this.goToIndex(idx);
  };

  // Follow the RSVP word: only re-window when it crosses off the current screen.
  // O(one screen) — never scans the book.
  Paged.prototype.follow = function (idx) {
    this.activeIndex = idx;
    if (idx < this.firstIndex || idx > this.lastIndex) {
      this.goToIndex(idx);
    }
  };

  // Shift all recorded positions by `delta` (used when tokens are inserted before
  // the current screen during background streaming). Shifts the nav history too,
  // so prev still returns to the right boundaries after the array grows.
  Paged.prototype.shiftPositions = function (delta) {
    if (!delta) return;
    this.startPos += delta; this.endPos += delta;
    this.firstIndex += delta; this.lastIndex += delta;
    if (this._startStack) {
      for (var i = 0; i < this._startStack.length; i++) this._startStack[i] += delta;
    }
  };

  // Forward: remember the screen we're leaving so prev returns to it EXACTLY.
  Paged.prototype.next = function () {
    if (this.endPos < this.tokens.length) {
      if (!this._startStack) this._startStack = [];
      this._startStack.push(this.startPos);
      this._layoutForward(this.endPos);
    }
  };
  // Back: pop to the exact previous start if we have one (perfectly reversible);
  // otherwise fall back to the deterministic backward layout.
  Paged.prototype.prev = function () {
    if (this.startPos <= 0) return;
    if (this._startStack && this._startStack.length) {
      var prevStart = this._startStack.pop();
      this._layoutForward(prevStart);
    } else {
      this._layoutBackward(this.startPos);
    }
  };

  // Position as a percentage of the book, by the first engine index on-screen.
  Paged.prototype.locationPct = function () {
    var total = this.tokens.length || 1;
    return Math.round((this.firstIndex || 0) / total * 100);
  };

  // Reported to onPageChange. No page totals — location is a %, plus the first
  // on-screen chapter so the reader can update the header.
  Paged.prototype.pageInfo = function () {
    var t = this.tokens[this.startPos];
    return {
      pct: this.locationPct(),
      startIndex: this.firstIndex || 0,
      chapter: t ? t.chapter : 0,
      atStart: (this.startPos || 0) <= 0,
      atEnd: this.endPos >= this.tokens.length
    };
  };

  // Wire taps once: a word tap reports its engine index, a gap tap reports null.
  Paged.prototype.enableTaps = function () {
    var self = this;
    this.pageEl.addEventListener('click', function (e) {
      var t = e.target;
      var idx = (t && t.classList && t.classList.contains('pg-word'))
        ? parseInt(t.dataset.index, 10) : null;
      self.onTap(idx);
    });
  };

  root.Paged = Paged;
})(typeof self !== 'undefined' ? self : this);
