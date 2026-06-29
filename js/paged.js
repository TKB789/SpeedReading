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
    this.onTap = opts.onWordTap || function () {};
    this.onPageChange = opts.onPageChange || function () {};
    this._builtH = 0; this._builtW = 0;
  }

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
    while (pos < toks.length) {
      var dw = this._wordAt(pos);
      if (!dw) break;
      var w = dw.word;
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

  // Lay out one screen BACKWARD ending just before token position `beforePos`.
  // We estimate a start a screenful-and-a-bit back, lay forward, and adjust so
  // the screen ends as close to (but not past) `beforePos` as possible.
  Paged.prototype._layoutBackward = function (beforePos) {
    if (beforePos <= 0) { this._layoutForward(0); return; }
    var span = Math.max(8, (this.endPos - this.startPos) * 2);
    var guess = Math.max(0, beforePos - span);
    for (var attempt = 0; attempt < 6; attempt++) {
      this._layoutForward(guess);
      if (this.endPos >= beforePos) break;       // reached the turn-back point
      guess = Math.min(beforePos - 1, this.endPos); // came up short — move start up
    }
    // If the fitted screen overshoots the boundary, clamp so we don't repeat
    // content from the page we turned back from.
    if (this.endPos > beforePos) this.endPos = beforePos;
  };

  // Public: (re)build at the current size. tokens optional. Renders the screen
  // starting at the last-known start position (default 0).
  Paged.prototype.build = function (tokens) {
    if (tokens) this.tokens = tokens;
    return this._layoutForward(this.startPos || 0);
  };

  // Build with retry until the box has real height (fonts/layout settling).
  Paged.prototype.buildWhenReady = function (tokens, cb) {
    var self = this;
    if (tokens) this.tokens = tokens;
    var tries = 0;
    (function attempt() {
      if (self._layoutForward(self.startPos || 0)) { if (cb) cb(); return; }
      if (tries++ < 40) setTimeout(attempt, 50);
    })();
  };

  // Show the screen containing a given engine token index.
  Paged.prototype.goToIndex = function (idx) {
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

  Paged.prototype.next = function () {
    if (this.endPos < this.tokens.length) this._layoutForward(this.endPos);
  };
  Paged.prototype.prev = function () {
    if (this.startPos > 0) this._layoutBackward(this.startPos);
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
