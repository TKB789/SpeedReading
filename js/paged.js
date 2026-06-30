/* paged.js — per-chapter FIXED pagination (Apple Books style).
 *
 * Each chapter is paginated into a stable grid of pages the moment the reader
 * enters it. Page 1 is always the chapter's first words, page 2 the next, etc.
 * The grid depends only on chapter text + font/box size — NOT on how you arrived
 * — so pages don't shift when you jump in from speed-reading, and "page X of Y in
 * chapter" is meaningful and stable. It re-flows (re-paginates) on font/size
 * change, always to the same grid for that size.
 *
 * Performance: we paginate ONE chapter at a time (small — a few thousand words,
 * milliseconds), never the whole book. Entering a new chapter paginates it then.
 *
 * Position within the token stream is a TOKEN POSITION. Each chapter's pages are
 * cached until a resize invalidates them.
 *
 * Exposes window.Paged with: build(tokens), goToIndex(i), follow(i), highlight(i),
 * next(), prev(), enableTaps(), onWordTap(cb), pageInfo(), locationPct(),
 * setChapterTitles(t), setChapterRanges(r), shiftPositions(d).
 */
(function (root) {
  'use strict';

  function Paged(pageEl, opts) {
    opts = opts || {};
    this.pageEl = pageEl;
    this.tokens = [];
    this.startPos = 0;          // first token position on the current page
    this.endPos = 0;            // one past the last token position on the page
    this.firstIndex = 0;        // first engine index visible
    this.lastIndex = 0;         // last engine index visible
    this.activeIndex = -1;      // highlighted word (speed-read landing), or -1
    this._chapterTitles = null; // chapter index → title
    this._chapterRanges = null; // chapter index → {start,end} token positions
    this._curChapter = -1;      // chapter currently paginated
    this._pages = [];           // [{startPos, endPos}] for the current chapter
    this._pageIdx = 0;          // index into _pages for the visible page
    this._builtH = 0; this._builtW = 0;
    this.onTap = opts.onWordTap || function () {};
    this.onPageChange = opts.onPageChange || function () {};
  }

  Paged.prototype.setChapterTitles = function (titles) {
    this._chapterTitles = titles || null;
  };

  // Provide chapter token-position ranges so we know each chapter's bounds without
  // scanning. ranges[c] = {start, end} (end exclusive). If not supplied, we derive
  // bounds by scanning tokens' .chapter field on demand.
  Paged.prototype.setChapterRanges = function (ranges) {
    this._chapterRanges = ranges || null;
  };

  // ---- lazy display words (merges soft-hyphen continuation chunks) ----
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

  Paged.prototype._wordPosOfIndex = function (idx) {
    var toks = this.tokens;
    idx = Math.max(0, Math.min(toks.length - 1, idx | 0));
    var p = idx;
    while (p > 0 && toks[p - 1] && /\u00AD$/.test(toks[p - 1].text)) p--;
    return p;
  };

  // Token-position bounds [start,end) of a chapter. Uses provided ranges if any,
  // else scans outward from a known position in that chapter.
  Paged.prototype._chapterBounds = function (chapter, hintPos) {
    if (this._chapterRanges && this._chapterRanges[chapter]) {
      var r = this._chapterRanges[chapter];
      return { start: r.start, end: r.end };
    }
    var toks = this.tokens;
    var start = Math.max(0, Math.min(toks.length - 1, hintPos | 0));
    while (start > 0 && toks[start - 1] && toks[start - 1].chapter === chapter) start--;
    var end = start;
    while (end < toks.length && toks[end] && toks[end].chapter === chapter) end++;
    return { start: start, end: end };
  };

  // ---- paginate ONE chapter into a fixed page grid -------------------------
  // Lays out the chapter from its first token, breaking into pages at the box
  // height. Produces this._pages = [{startPos,endPos}, …] covering [start,end).
  // Pure function of (chapter text, box size): the same chapter+size always
  // yields the same grid, regardless of entry point. Returns false if the box
  // isn't measurable yet.
  Paged.prototype._paginateChapter = function (chapter, hintPos) {
    var el = this.pageEl;
    var maxH = el.clientHeight;
    if (!maxH || maxH < 40) return false;
    var toks = this.tokens;
    var b = this._chapterBounds(chapter, hintPos);
    var pages = [];
    var pos = b.start;
    var safety = 0;
    while (pos < b.end && safety++ < 100000) {
      var pageStart = pos;
      pos = this._fillPage(pos, b.end, /*measureOnly=*/true);
      if (pos <= pageStart) pos = pageStart + 1; // guarantee progress
      pages.push({ startPos: pageStart, endPos: pos });
    }
    if (!pages.length) pages.push({ startPos: b.start, endPos: b.end });
    this._curChapter = chapter;
    this._pages = pages;
    this._builtH = maxH; this._builtW = el.clientWidth;
    return true;
  };

  // Fill the page box starting at token `fromPos`, not crossing `limit`. If
  // measureOnly, we still render (to measure) but the caller will re-render the
  // chosen page for display via _renderPage. Returns the token position one past
  // the last word that fit. Renders a chapter heading at the chapter's first token.
  Paged.prototype._fillPage = function (fromPos, limit, measureOnly) {
    var el = this.pageEl;
    var maxH = el.clientHeight;
    var toks = this.tokens;
    el.innerHTML = '';
    var lastPara = -1, curPara = null, lastChapter = -1;
    var pos = fromPos;
    var firstIdx = -1, lastIdx = -1;
    while (pos < limit) {
      var dw = this._wordAt(pos);
      if (!dw) break;
      var w = dw.word;
      if (w.chapter !== lastChapter) {
        var isChapterFirstToken = (pos === 0) ||
          (toks[pos - 1] && toks[pos - 1].chapter !== w.chapter);
        if (isChapterFirstToken && this._chapterTitles &&
            this._chapterTitles[w.chapter] != null) {
          var hd = document.createElement('div');
          hd.className = 'pg-chapter-title';
          hd.textContent = this._chapterTitles[w.chapter];
          el.appendChild(hd);
          if (el.scrollHeight > maxH && firstIdx >= 0) { el.removeChild(hd); break; }
        }
        lastChapter = w.chapter;
        lastPara = -1;
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
    if (pos === fromPos && fromPos < limit) {
      var one = this._wordAt(fromPos);
      pos = one ? one.nextPos : fromPos + 1;
    }
    return pos;
  };

  // Render a specific page (by its index in this._pages) for display, marking the
  // active word if present, and report state.
  Paged.prototype._renderPage = function (pageIdx) {
    if (!this._pages.length) return false;
    pageIdx = Math.max(0, Math.min(this._pages.length - 1, pageIdx));
    var pg = this._pages[pageIdx];
    this._fillPage(pg.startPos, pg.endPos, false);
    this._pageIdx = pageIdx;
    this.startPos = pg.startPos;
    this.endPos = pg.endPos;
    // first/last engine index on the page
    var fw = this._wordAt(pg.startPos);
    this.firstIndex = fw ? fw.word.index : pg.startPos;
    var li = pg.endPos - 1;
    while (li > pg.startPos && this.tokens[li] && /\u00AD$/.test(this.tokens[li].text)) li--;
    this.lastIndex = li;
    // apply active-word highlight if it's on this page
    this._applyHighlight();
    this.onPageChange(this.pageInfo());
    return true;
  };

  // Add the .pg-active class to the active word if it's on the current page.
  Paged.prototype._applyHighlight = function () {
    if (this.activeIndex == null || this.activeIndex < 0) return;
    var sel = this.pageEl.querySelectorAll('.pg-word');
    for (var i = 0; i < sel.length; i++) {
      if (parseInt(sel[i].dataset.index, 10) === this.activeIndex) {
        sel[i].classList.add('pg-active');
        break;
      }
    }
  };

  // Ensure the given chapter is the one currently paginated; (re)paginate if not,
  // or if the box size changed since we last paginated.
  Paged.prototype._ensureChapterPaginated = function (chapter, hintPos) {
    var sizeChanged = this.pageEl.clientHeight !== this._builtH ||
                      this.pageEl.clientWidth !== this._builtW;
    if (this._curChapter !== chapter || sizeChanged || !this._pages.length) {
      return this._paginateChapter(chapter, hintPos);
    }
    return true;
  };

  // Find which page in the current chapter contains token position `pos`.
  Paged.prototype._pageContaining = function (pos) {
    var pages = this._pages;
    for (var i = 0; i < pages.length; i++) {
      if (pos >= pages[i].startPos && pos < pages[i].endPos) return i;
    }
    return pos < (pages[0] ? pages[0].startPos : 0) ? 0 : pages.length - 1;
  };

  // ---- public API ----------------------------------------------------------

  Paged.prototype.build = function (tokens) {
    if (tokens) this.tokens = tokens;
    var ch = (this.tokens[this.startPos] && this.tokens[this.startPos].chapter) || 0;
    if (!this._ensureChapterPaginated(ch, this.startPos || 0)) return false;
    return this._renderPage(this._pageContaining(this.startPos || 0));
  };

  Paged.prototype.buildWhenReady = function (tokens, cb) {
    var self = this;
    if (tokens) this.tokens = tokens;
    var tries = 0;
    (function attempt() {
      if (self.build()) { if (cb) cb(); return; }
      if (tries++ < 40) setTimeout(attempt, 50);
    })();
  };

  // Show the page that CONTAINS the given engine index (word stays in place, not
  // moved to the top). Paginates the index's chapter if needed.
  Paged.prototype.goToIndex = function (idx) {
    var pos = this._wordPosOfIndex(idx);
    var ch = (this.tokens[pos] && this.tokens[pos].chapter) || 0;
    if (!this._ensureChapterPaginated(ch, pos)) return;
    this._renderPage(this._pageContaining(pos));
  };

  // Jump to an index AND highlight that word (used when switching speed→page).
  Paged.prototype.highlight = function (idx) {
    this.activeIndex = idx;
    this.goToIndex(idx);
  };

  // Follow the RSVP word: re-page only when it leaves the current page; keeps the
  // chapter grid stable. Crossing into a new chapter re-paginates that chapter.
  Paged.prototype.follow = function (idx) {
    this.activeIndex = idx;
    if (idx < this.firstIndex || idx > this.lastIndex) {
      this.goToIndex(idx);
    }
  };

  // Page turns walk the fixed grid. At a chapter edge, move into the adjacent
  // chapter and paginate it (landing on its first or last page).
  Paged.prototype.next = function () {
    this.activeIndex = -1; // turning the page clears a speed-read highlight
    if (this._pageIdx + 1 < this._pages.length) {
      this._renderPage(this._pageIdx + 1);
    } else {
      // move to the next chapter's first page
      var endPos = this._pages[this._pages.length - 1].endPos;
      if (endPos < this.tokens.length) {
        var ch = this.tokens[endPos] ? this.tokens[endPos].chapter : null;
        if (ch != null && this._ensureChapterPaginated(ch, endPos)) {
          this._renderPage(0);
        }
      }
    }
  };
  Paged.prototype.prev = function () {
    this.activeIndex = -1;
    if (this._pageIdx > 0) {
      this._renderPage(this._pageIdx - 1);
    } else {
      // move to the previous chapter's last page
      var startPos = this._pages[0].startPos;
      if (startPos > 0) {
        var prevPos = startPos - 1;
        var ch = this.tokens[prevPos] ? this.tokens[prevPos].chapter : null;
        if (ch != null && this._ensureChapterPaginated(ch, prevPos)) {
          this._renderPage(this._pages.length - 1);
        }
      }
    }
  };

  // Streaming inserted tokens before us: shift positions and invalidate the
  // cached chapter pagination (its token positions moved). We re-paginate lazily
  // on the next render.
  Paged.prototype.shiftPositions = function (delta) {
    if (!delta) return;
    this.startPos += delta; this.endPos += delta;
    this.firstIndex += delta; this.lastIndex += delta;
    // Shift current page grid so the visible page stays correct until next nav.
    for (var i = 0; i < this._pages.length; i++) {
      this._pages[i].startPos += delta;
      this._pages[i].endPos += delta;
    }
    if (this.activeIndex >= 0) this.activeIndex += delta;
  };

  Paged.prototype.locationPct = function () {
    var total = this.tokens.length || 1;
    return Math.round((this.firstIndex || 0) / total * 100);
  };

  // Page X of Y within the chapter, plus overall %.
  Paged.prototype.pageInfo = function () {
    var t = this.tokens[this.startPos];
    return {
      pct: this.locationPct(),
      pageInChapter: this._pageIdx + 1,
      pagesInChapter: this._pages.length || 1,
      startIndex: this.firstIndex || 0,
      chapter: t ? t.chapter : 0,
      atStart: (this.startPos || 0) <= 0,
      atEnd: this.endPos >= this.tokens.length
    };
  };

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
