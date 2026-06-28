/* paged.js — a normal paged reader that shares the RSVP token stream.
 *
 * Key idea: it renders the SAME tokens the engine plays, each tagged with its
 * global token index, so tapping a word maps exactly to an engine index. Pages
 * are built by filling the page element with words until it overflows, then
 * starting a new page — giving clean, device-fitted pages with real tap targets.
 *
 * Exposes window.Paged with: build(tokens), goToIndex(i), onWordTap(cb),
 * next(), prev(), pageInfo().
 */
(function (root) {
  'use strict';

  function Paged(pageEl, opts) {
    opts = opts || {};
    this.pageEl = pageEl;
    this.tokens = [];
    this.pages = [];          // each page = { start, end } token-index range
    this.current = 0;
    this.onTap = opts.onWordTap || function () {};
    this.onPageChange = opts.onPageChange || function () {};
  }

  // Reconstruct display words from tokens, re-joining hyphen-split long words so
  // the reader shows natural text while still mapping taps to token indices.
  Paged.prototype._displayWords = function () {
    var words = [];
    var toks = this.tokens;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      var text = t.text;
      var startIndex = i;
      // Merge soft-hyphen continuation chunks back into one display word.
      while (/\u00AD$/.test(toks[i] && toks[i].text)) {
        i++;
        if (i < toks.length) text = text.replace(/\u00AD$/, '') + toks[i].text;
        else break;
      }
      words.push({
        text: text.replace(/\u00AD/g, ''),
        index: startIndex,      // engine index to seek to on tap
        para: t.para,
        chapter: t.chapter,
        paraEnd: toks[i] ? toks[i].paraEnd : t.paraEnd
      });
    }
    return words;
  };

  // Paginate: lay words into the page element until it overflows height, record
  // page boundaries, repeat. Measures against the real element size.
  // Returns true if it paginated, false if the element had no height yet.
  Paged.prototype.build = function (tokens) {
    if (tokens) this.tokens = tokens;
    this.words = this._displayWords();
    this.pages = [];
    var el = this.pageEl;
    var maxH = el.clientHeight;
    if (!maxH || maxH < 40) {
      // Not laid out yet (hidden or zero-height). Caller should retry.
      return false;
    }
    // Build paragraph blocks, then fill pages by appending blocks/words.
    el.innerHTML = '';
    var pageStartWord = 0;
    var wi = 0;
    var self = this;

    function newParagraph() {
      var p = document.createElement('p');
      p.className = 'pg-para';
      el.appendChild(p);
      return p;
    }

    var curPara = null;
    var lastPara = -1;
    function commitPage(endWord) {
      self.pages.push({
        startWord: pageStartWord,
        endWord: endWord,
        start: self.words[pageStartWord] ? self.words[pageStartWord].index : 0
      });
    }

    while (wi < this.words.length) {
      var w = this.words[wi];
      if (w.para !== lastPara) { curPara = newParagraph(); lastPara = w.para; }
      var span = document.createElement('span');
      span.className = 'pg-word';
      span.textContent = w.text + ' ';
      span.dataset.index = w.index;
      curPara.appendChild(span);

      if (el.scrollHeight > maxH) {
        // This word overflowed — remove it, close the page here.
        curPara.removeChild(span);
        if (!curPara.childNodes.length) el.removeChild(curPara);
        commitPage(wi);
        // Reset for next page.
        el.innerHTML = '';
        pageStartWord = wi;
        lastPara = -1;
        curPara = null;
        continue; // re-place this same word on the fresh page
      }
      wi++;
    }
    commitPage(this.words.length);
    el.innerHTML = '';
    if (this.current >= this.pages.length) this.current = this.pages.length - 1;
    this.renderPage(this.current);
    return true;
  };

  // Build with retry: poll until the element has real height (handles fonts
  // still loading or the view being momentarily hidden). cb runs once built.
  Paged.prototype.buildWhenReady = function (tokens, cb) {
    var self = this;
    var tries = 0;
    (function attempt() {
      if (self.build(tokens)) { if (cb) cb(); return; }
      if (tries++ < 40) setTimeout(attempt, 50); // up to ~2s
    })();
  };

  Paged.prototype.renderPage = function (n) {
    n = Math.max(0, Math.min(this.pages.length - 1, n));
    this.current = n;
    var page = this.pages[n];
    var el = this.pageEl;
    el.innerHTML = '';
    var lastPara = -1, curPara = null;
    for (var i = page.startWord; i < page.endWord; i++) {
      var w = this.words[i];
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
      if (this.activeIndex != null && w.index === this.activeIndex) span.className += ' active';
      curPara.appendChild(span);
    }
    this.onPageChange(this.pageInfo());
  };

  // Mark a word active (the current reading position) and show its page.
  Paged.prototype.highlight = function (idx) {
    this.activeIndex = idx;
    this.goToIndex(idx);
  };

  Paged.prototype.next = function () { if (this.current < this.pages.length - 1) this.renderPage(this.current + 1); };
  Paged.prototype.prev = function () { if (this.current > 0) this.renderPage(this.current - 1); };

  // Show the page that contains a given engine token index.
  Paged.prototype.goToIndex = function (idx) {
    for (var i = 0; i < this.pages.length; i++) {
      var p = this.pages[i];
      var startIdx = this.words[p.startWord] ? this.words[p.startWord].index : 0;
      var endIdx = this.words[p.endWord - 1] ? this.words[p.endWord - 1].index : Infinity;
      if (idx >= startIdx && idx <= endIdx) { this.renderPage(i); return; }
    }
    this.renderPage(0);
  };

  Paged.prototype.pageInfo = function () {
    return { page: this.current + 1, total: this.pages.length || 1 };
  };

  // Wire taps once; delegate to find the tapped word's index.
  Paged.prototype.enableTaps = function () {
    var self = this;
    this.pageEl.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains('pg-word')) {
        self.onTap(parseInt(t.dataset.index, 10));
      }
    });
  };

  root.Paged = Paged;
})(typeof self !== 'undefined' ? self : this);
