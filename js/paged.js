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
    if (titles) this._numChapters = titles.length;
  };

  // Tell the pager how many chapters the book has (for total-page math).
  Paged.prototype.setChapterCount = function (n) { this._numChapters = n; };

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
  // else scans for the chapter. When `hintPos` is a position known to be inside
  // the chapter, we expand outward from it (fast). Otherwise we scan from the
  // start of the token array to find the chapter's first token.
  Paged.prototype._chapterBounds = function (chapter, hintPos) {
    if (this._chapterRanges && this._chapterRanges[chapter]) {
      var r = this._chapterRanges[chapter];
      return { start: r.start, end: r.end };
    }
    var toks = this.tokens;
    var start;
    if (hintPos != null && toks[hintPos] && toks[hintPos].chapter === chapter) {
      // Expand outward from a position known to be in this chapter.
      start = hintPos;
      while (start > 0 && toks[start - 1] && toks[start - 1].chapter === chapter) start--;
    } else {
      // No usable hint: find the chapter's first token by scanning from 0.
      start = -1;
      for (var i = 0; i < toks.length; i++) {
        if (toks[i] && toks[i].chapter === chapter) { start = i; break; }
      }
      if (start === -1) return { start: 0, end: 0 }; // chapter not present
    }
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
    // Keep the totals cache consistent: the chapter we just laid out has a known
    // page count now. If the box size matches the cached signature, store it.
    var sig = maxH + 'x' + el.clientWidth;
    if (this._countsSig === sig) {
      if (!this._pageCounts) this._pageCounts = {};
      this._pageCounts[chapter] = pages.length;
    }
    return true;
  };


  // Fill one page starting at fromPos, up to (excl.) limit. Renders into the
  // page box and returns the token position one past the last word that fit.
  // Renders a chapter heading at the chapter's first token. (measureOnly is
  // kept for API compatibility; the render is identical either way, as before.)
  //
  // PERFORMANCE: the previous version read el.scrollHeight after appending
  // EVERY word — a forced synchronous reflow per word, i.e. ~300 layout passes
  // per page and thousands per chapter pagination. That was the main source of
  // page-turn / pagination lag. This version appends words in growing batches
  // (one reflow per batch) and then binary-searches the exact cutoff (one
  // reflow per probe): ~10–15 reflows per page. The fit test is unchanged
  // (scrollHeight vs clientHeight), so page boundaries are identical to before.
  Paged.prototype._fillPage = function (fromPos, limit, measureOnly) {
    var el = this.pageEl;
    var maxH = el.clientHeight;
    var toks = this.tokens;
    el.innerHTML = '';
    if (fromPos >= limit) return fromPos;

    // ---- Phase 1: append in growing batches until overflow (or limit) ----
    var entries = [];               // {span, nextPos} per display word, in order
    var paraEls = [];               // {el, firstEntry} per paragraph created
    var lastPara = -1, lastChapter = -1, curPara = null;
    var pos = fromPos;
    var batch = Math.max(32, this._lastPageWords || 200); // seed from last page
    var overflow = false;

    while (pos < limit) {
      var target = entries.length + batch;
      while (pos < limit && entries.length < target) {
        var dw = this._wordAt(pos);
        if (!dw) { pos = limit; break; }
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
          }
          lastChapter = w.chapter;
          lastPara = -1;
        }
        if (w.para !== lastPara) {
          curPara = document.createElement('p');
          curPara.className = 'pg-para';
          el.appendChild(curPara);
          paraEls.push({ el: curPara, firstEntry: entries.length });
          lastPara = w.para;
        }
        var span = document.createElement('span');
        span.className = 'pg-word';
        span.textContent = w.text + ' ';
        span.dataset.index = w.index;
        curPara.appendChild(span);
        entries.push({ span: span, nextPos: dw.nextPos });
        pos = dw.nextPos;
      }
      if (el.scrollHeight > maxH) { overflow = true; break; } // 1 reflow / batch
      batch *= 2;
    }

    if (!entries.length) return Math.min(limit, fromPos + 1); // guarantee progress

    var fit = entries.length;
    if (overflow) {
      // ---- Phase 2: binary-search the largest word count that fits --------
      // showFirst(k) displays exactly the first k words (and hides paragraphs
      // that would be empty, matching the old "remove empty <p>" behaviour so
      // stray paragraph margins can't skew the measurement).
      var showFirst = function (k) {
        for (var i = 0; i < entries.length; i++) {
          entries[i].span.style.display = (i < k) ? '' : 'none';
        }
        for (var p = 0; p < paraEls.length; p++) {
          paraEls[p].el.style.display = (paraEls[p].firstEntry < k) ? '' : 'none';
        }
      };
      var best = 1, lo = 1, hi = entries.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        showFirst(mid);
        if (el.scrollHeight <= maxH) { best = mid; lo = mid + 1; } // 1 reflow / probe
        else { hi = mid - 1; }
      }
      fit = best;
      // ---- Finalize: really remove what didn't fit (clean DOM for taps) ----
      for (var r = entries.length - 1; r >= fit; r--) {
        var sp = entries[r].span;
        if (sp.parentNode) sp.parentNode.removeChild(sp);
      }
      for (var q = paraEls.length - 1; q >= 0; q--) {
        var pe = paraEls[q];
        pe.el.style.display = '';
        if (!pe.el.childNodes.length && pe.el.parentNode) pe.el.parentNode.removeChild(pe.el);
      }
      for (var v = 0; v < fit; v++) entries[v].span.style.display = '';
    }

    this._lastPageWords = fit;      // seed the next page's first batch size
    return entries[fit - 1].nextPos;
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
    if (this._dirty || this._curChapter !== chapter || sizeChanged || !this._pages.length) {
      this._dirty = false;
      return this._paginateChapter(chapter, hintPos);
    }
    return true;
  };

  // Force a re-pagination on the next render, even if the box dimensions are
  // unchanged. A FONT change re-flows the text without changing the box size, so
  // size-based detection misses it — callers use this to force the reflow and to
  // drop the now-stale per-chapter page-count cache.
  Paged.prototype.invalidate = function () {
    this._dirty = true;
    this._pages = [];
    this._curChapter = -1;
    this._pageCounts = {};
    this._countsSig = null;
  };

  // ---- TOTAL pages across the whole book -----------------------------------
  // Computing a book-wide "page N of TOTAL" needs every chapter's page count at
  // the CURRENT box size. We compute that in the background, one chapter per
  // time-slice, so the reader isn't blocked. Results cache in _pageCounts keyed
  // by chapter; _countsSig records the box size they were computed at, so a font
  // change invalidates and recomputes. The live page is restored after each
  // chapter we measure, so the view never visibly flickers between frames.
  Paged.prototype.computeTotals = function (numChapters, onProgress) {
    var self = this;
    var sig = this.pageEl.clientHeight + 'x' + this.pageEl.clientWidth;
    if (this._countsSig !== sig) { this._pageCounts = {}; this._countsSig = sig; }
    this._totalsCanceled = false;
    // Build a chapter → first-token-position index once, so each chapter's bounds
    // are found in O(1) instead of re-scanning the array per chapter.
    var firstPos = {};
    for (var i = 0; i < this.tokens.length; i++) {
      var c = this.tokens[i].chapter;
      if (firstPos[c] == null) firstPos[c] = i;
    }
    var ch = 0;
    function step() {
      if (self._totalsCanceled) return;
      var sliceEnd = Math.min(numChapters, ch + 3); // a few chapters per slice
      var measured = false;
      for (; ch < sliceEnd; ch++) {
        if (self._pageCounts[ch] == null) {
          self._pageCounts[ch] = self._countChapterPages(ch, firstPos[ch], /*skipRestore=*/true);
          measured = true;
        }
      }
      // The count pass renders into the live box to measure; restore the page
      // the reader is on ONCE per slice (not once per chapter — that tripled
      // the background layout work and contributed to page-turn jank).
      if (measured && self._pages.length && self._pages[self._pageIdx]) {
        self._fillPage(self._pages[self._pageIdx].startPos,
                       self._pages[self._pageIdx].endPos, false);
      }
      if (onProgress) onProgress(self._totalsReady(numChapters), self.totalPages(numChapters));
      if (ch < numChapters) {
        (root.requestAnimationFrame || function (f) { setTimeout(f, 0); })(step);
      } else {
        // Re-render the live page so its onPageChange fires with final totals.
        self._renderPage(self._pageIdx);
      }
    }
    step();
  };
  Paged.prototype.cancelTotals = function () { this._totalsCanceled = true; };

  // Paginate one chapter only to COUNT its pages, then restore the visible page
  // so the view is untouched. `hintPos` is the chapter's first token position (if
  // known) for fast bounds. Uses the same _fillPage measurement as display.
  Paged.prototype._countChapterPages = function (chapter, hintPos, skipRestore) {
    var maxH = this.pageEl.clientHeight;
    if (!maxH || maxH < 40) return 1;
    var b = this._chapterBounds(chapter, hintPos);
    if (b.start == null || b.end <= b.start) return 1;
    var count = 0, pos = b.start, safety = 0;
    while (pos < b.end && safety++ < 100000) {
      var pageStart = pos;
      pos = this._fillPage(pos, b.end, true);
      if (pos <= pageStart) pos = pageStart + 1;
      count++;
    }
    // Restore the page the reader is actually on (we just clobbered the box) —
    // unless the caller batches counts and restores once per slice itself.
    if (!skipRestore && this._pages.length && this._pages[this._pageIdx]) {
      this._fillPage(this._pages[this._pageIdx].startPos,
                     this._pages[this._pageIdx].endPos, false);
    }
    return count || 1;
  };

  Paged.prototype._totalsReady = function (numChapters) {
    if (!this._pageCounts) return false;
    for (var c = 0; c < numChapters; c++) if (this._pageCounts[c] == null) return false;
    return true;
  };
  // Total pages across the book (sum of cached chapter counts). Returns 0 until
  // at least partly computed; pair with _totalsReady to know if it's final.
  Paged.prototype.totalPages = function (numChapters) {
    if (!this._pageCounts) return 0;
    var t = 0;
    for (var c = 0; c < numChapters; c++) t += (this._pageCounts[c] || 0);
    return t;
  };
  // The reader's absolute page number = pages in all prior chapters + page in
  // this chapter. Needs the current chapter's count to be known (it always is —
  // it's the one being read). Returns 0 if totals aren't ready for prior chapters.
  Paged.prototype.absolutePage = function () {
    if (!this._pageCounts) return 0;
    var before = 0;
    for (var c = 0; c < this._curChapter; c++) {
      if (this._pageCounts[c] == null) return 0;       // prior chapter not counted yet
      before += this._pageCounts[c];
    }
    return before + (this._pageIdx + 1);
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

  // Restore an EXACT page within a chapter (1-based pageInChapter), used on
  // reopen. Pagination is deterministic for a given box size, so rendering the
  // same page number returns to the same place — more reliable than resolving a
  // token to a page when lazy pagination or a not-yet-settled box height could
  // shift boundaries. Falls back to clamping if the chapter now has fewer pages
  // (e.g. a different font size), and returns false if the chapter isn't present.
  Paged.prototype.goToChapterPage = function (chapter, pageInChapter, hintPos) {
    if (!this._ensureChapterPaginated(chapter, hintPos)) return false;
    var n = this._pages.length || 1;
    var idx = Math.max(0, Math.min(n - 1, (pageInChapter || 1) - 1));
    this._renderPage(idx);
    return true;
  };

  // Render a page that BEGINS exactly at engine index `idx`, so the tapped/target
  // word is the first word shown (top-aligned) rather than sitting mid-page. This
  // is an ad-hoc page laid out from `idx` downward; it does NOT rewrite the
  // chapter's fixed page grid (that would shift page numbers and break resume).
  // We keep _pageIdx pointed at the grid page that contains `idx`, so turning the
  // page with next()/prev() continues correctly from the real grid.
  Paged.prototype.showFrom = function (idx) {
    var pos = this._wordPosOfIndex(idx);
    var ch = (this.tokens[pos] && this.tokens[pos].chapter) || 0;
    if (!this._ensureChapterPaginated(ch, pos)) return false;
    // Clamp pos to this chapter's bounds so we don't spill past its end.
    var b = this._chapterBounds(ch, pos);
    if (pos < b.start) pos = b.start;
    if (pos >= b.end) pos = Math.max(b.start, b.end - 1);
    // Lay out one page from pos downward (display), and set live state to it.
    var endPos = this._fillPage(pos, b.end, false);
    if (endPos <= pos) endPos = Math.min(b.end, pos + 1);
    this.startPos = pos;
    this.endPos = endPos;
    this._pageIdx = this._pageContaining(pos);  // grid page for subsequent turns
    var fw = this._wordAt(pos);
    this.firstIndex = fw ? fw.word.index : pos;
    var li = endPos - 1;
    while (li > pos && this.tokens[li] && /\u00AD$/.test(this.tokens[li].text)) li--;
    this.lastIndex = li;
    this._applyHighlight();
    this.onPageChange(this.pageInfo());
    return true;
  };

  // Jump to an index AND highlight that word (used when switching speed→page).
  Paged.prototype.highlight = function (idx) {
    this.activeIndex = idx;
    this.goToIndex(idx);
  };

  // Follow the RSVP word: keep the right page visible as speed-reading advances,
  // but do NOT highlight the word — a moving highlight in the context pane is
  // distracting. Re-page only when the word leaves the current page.
  Paged.prototype.follow = function (idx) {
    this.activeIndex = -1;            // no highlight while following
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

  // The word to keep steady across a re-flow (font change): the one nearest the
  // CENTER of the current page. After re-pagination we land on whatever page now
  // contains it, so the reader's focal point stays put while words above/below
  // shift. Falls back to the page's first word, then 0.
  Paged.prototype.currentAnchor = function () {
    if (this.lastIndex >= this.firstIndex && this.firstIndex >= 0) {
      return Math.floor((this.firstIndex + this.lastIndex) / 2);
    }
    return this.firstIndex || 0;
  };

  // Page X of Y within the chapter, plus overall % and (when totals are ready)
  // absolute page number, total pages, and pages left in the current chapter.
  Paged.prototype.pageInfo = function (numChapters) {
    if (numChapters == null) numChapters = this._numChapters;
    var t = this.tokens[this.startPos];
    var pagesInCh = this._pages.length || 1;
    var info = {
      pct: this.locationPct(),
      pageInChapter: this._pageIdx + 1,
      pagesInChapter: pagesInCh,
      pagesLeftInChapter: Math.max(0, pagesInCh - (this._pageIdx + 1)),
      startIndex: this.firstIndex || 0,
      wordsOnPage: Math.max(0, (this.lastIndex || 0) - (this.firstIndex || 0) + 1),
      chapter: t ? t.chapter : 0,
      atStart: (this.startPos || 0) <= 0,
      atEnd: this.endPos >= this.tokens.length,
      totalPages: 0,
      absolutePage: 0,
      totalsReady: false
    };
    if (numChapters != null) {
      info.totalsReady = this._totalsReady(numChapters);
      info.totalPages = this.totalPages(numChapters);
      info.absolutePage = this.absolutePage();
    }
    return info;
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
