/*
 * rsvp.js — the speed-reading engine. No DOM; reader.js wires callbacks.
 * Tokenizes chapters into a flat stream with ORP pivot + punctuation timing.
 */
(function (root) {
  'use strict';

  function pivotIndex(word) {
    var n = word.length;
    if (n <= 1) return 0;
    if (n <= 5) return 1;
    if (n <= 9) return 2;
    if (n <= 13) return 3;
    return 4;
  }

  function chunkLongWord(word, max) {
    if (word.length <= max) return [word];
    var out = [];
    for (var i = 0; i < word.length; i += max) {
      var piece = word.slice(i, i + max);
      if (i + max < word.length) piece += '\u00AD';
      out.push(piece);
    }
    return out;
  }

  function tokenize(chapters, opts) {
    opts = opts || {};
    var maxLen = opts.maxWordLength || 13;
    var tokens = [];
    for (var c = 0; c < chapters.length; c++) {
      var paras = chapters[c].paras;
      for (var p = 0; p < paras.length; p++) {
        var words = paras[p].split(/\s+/).filter(Boolean);
        for (var w = 0; w < words.length; w++) {
          var pieces = chunkLongWord(words[w], maxLen);
          for (var k = 0; k < pieces.length; k++) {
            var piece = pieces[k];
            var hold = 1;
            var isWordEnd = (k === pieces.length - 1);
            if (isWordEnd) {
              if (/[,;:]$/.test(piece)) hold = 1.5;
              if (/[.?!]["')\u201d\u2019]?$/.test(piece)) hold = 2.2;
              if (piece.replace(/\u00AD/g, '').length >= 8) hold = Math.max(hold, 1.3);
            }
            tokens.push({
              text: piece, chapter: c, para: p,
              pivot: pivotIndex(piece.replace(/\u00AD/g, '')),
              hold: hold, paraEnd: false, chapterEnd: false
            });
          }
        }
        if (tokens.length) tokens[tokens.length - 1].paraEnd = true;
      }
      if (tokens.length) tokens[tokens.length - 1].chapterEnd = true;
    }
    return tokens;
  }

  function Engine(tokens, opts) {
    opts = opts || {};
    this.tokens = tokens;
    this.index = 0;
    this.wpm = opts.wpm || 400;
    this.playing = false;
    this._timer = null;
    this.onRender = opts.onRender || function () {};
    this.onState = opts.onState || function () {};
    this.onEnd = opts.onEnd || function () {};
    this.paraPause = opts.paraPause || 2.5;
    this.chapterPause = opts.chapterPause || 3.5;
    this.pauseScale = opts.pauseScale != null ? opts.pauseScale : 1; // 0..2 dial
  }
  Engine.prototype.baseDelay = function () { return 60000 / this.wpm; };
  Engine.prototype.delayFor = function (tok) {
    // pauseScale dials the EXTRA hold above 1x; at scale 0 every word is even.
    var holdExtra = (tok.hold - 1) * this.pauseScale;
    var d = this.baseDelay() * (1 + holdExtra);
    var struct = tok.chapterEnd ? this.chapterPause : (tok.paraEnd ? this.paraPause : 1);
    if (struct > 1) d += this.baseDelay() * (struct - 1) * this.pauseScale;
    return d;
  };
  Engine.prototype.setPauseScale = function (s) {
    this.pauseScale = Math.max(0, Math.min(2, s));
    this.onState(this.snapshot());
  };
  // Estimate ms of reading remaining from current index to end (ignores future
  // WPM changes; good enough for a live readout).
  Engine.prototype.timeLeftMs = function () {
    var ms = 0;
    for (var i = this.index; i < this.tokens.length; i++) ms += this.delayFor(this.tokens[i]);
    return ms;
  };
  // Skip by a duration in ms: walk forward/back accumulating per-word delays.
  Engine.prototype.skipTime = function (ms) {
    var dir = ms < 0 ? -1 : 1;
    var budget = Math.abs(ms);
    var i = this.index;
    while (budget > 0 && i + dir >= 0 && i + dir < this.tokens.length) {
      i += dir;
      budget -= this.delayFor(this.tokens[i]);
    }
    this.seek(i);
  };
  Engine.prototype.current = function () { return this.tokens[this.index] || null; };
  Engine.prototype.total = function () { return this.tokens.length; };
  Engine.prototype.setWpm = function (wpm) {
    this.wpm = Math.max(50, Math.min(1200, wpm));
    this.onState(this.snapshot());
  };
  Engine.prototype.snapshot = function () {
    var tok = this.current();
    return { index: this.index, total: this.tokens.length, playing: this.playing,
             wpm: this.wpm, chapter: tok ? tok.chapter : 0, pauseScale: this.pauseScale };
  };
  Engine.prototype._tick = function () {
    var tok = this.current();
    if (!tok) { this.pause(); this.onEnd(); return; }
    this.onRender(tok, this.snapshot());
    var delay = this.delayFor(tok);
    var self = this;
    this._timer = setTimeout(function () {
      if (!self.playing) return;
      self.index++;
      if (self.index >= self.tokens.length) {
        self.playing = false; self.onState(self.snapshot()); self.onEnd(); return;
      }
      self._tick();
    }, delay);
  };
  Engine.prototype.play = function () {
    if (this.playing || !this.tokens.length) return;
    if (this.index >= this.tokens.length) this.index = 0;
    this.playing = true; this.onState(this.snapshot()); this._tick();
  };
  Engine.prototype.pause = function () {
    this.playing = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.onState(this.snapshot());
  };
  Engine.prototype.toggle = function () { this.playing ? this.pause() : this.play(); };
  Engine.prototype.step = function (delta) {
    this.pause();
    this.index = Math.max(0, Math.min(this.tokens.length - 1, this.index + delta));
    var tok = this.current();
    if (tok) this.onRender(tok, this.snapshot());
    this.onState(this.snapshot());
  };
  Engine.prototype.seek = function (index) {
    var wasPlaying = this.playing;
    this.pause();
    this.index = Math.max(0, Math.min(this.tokens.length - 1, index | 0));
    var tok = this.current();
    if (tok) this.onRender(tok, this.snapshot());
    if (wasPlaying) this.play(); else this.onState(this.snapshot());
  };
  Engine.prototype.seekChapter = function (chapterIndex) {
    for (var i = 0; i < this.tokens.length; i++) {
      if (this.tokens[i].chapter === chapterIndex) { this.seek(i); return; }
    }
  };

  var api = { tokenize: tokenize, Engine: Engine, pivotIndex: pivotIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RSVP = api;
})(typeof self !== 'undefined' ? self : this);
