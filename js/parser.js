/*
 * parser.js — turn a Project Gutenberg plain-text string into structured book
 * data: { title, author, wordCount, chapters: [{ title, paras: [...] }] }.
 */
(function (root) {
  'use strict';

  // A genuine chapter/section heading. Gutenberg hard-wraps prose, so lines
  // frequently begin with "I", "I.", or a number — we must NOT treat those as
  // headings. Require an explicit keyword (CHAPTER/LETTER/PART/BOOK/etc.), OR a
  // standalone multi-character roman numeral line, OR "Chapter N"-style.
  //
  // The keyword form allows an optional title AFTER the number on the same line,
  // e.g. "CHAPTER 1. Loomings." or "CHAPTER I. The Carpet-Bag." — many books
  // (Moby Dick, etc.) put the chapter title inline, and the heading must still
  // be recognised. We require either end-of-line after the numeral, OR a
  // separator (period / colon / dash / space) followed by a short title.
  var HEADING_KEYWORD = /^\s*(chapter|letter|part|book|volume|canto|section|stave|act|scene)\b\s*([ivxlcdm\d]+)?\.?(\s*[—:.\-]?\s+\S.*)?$/i;
  var ROMAN_ONLY = /^\s*[IVXLCDM]{1,7}\.?\s*$/; // uppercase only, on its own line
  function isHeading(line) {
    var t = line.trim();
    if (!t) return false;
    if (HEADING_KEYWORD.test(t)) {
      // Guard against prose that merely begins with a keyword ("Part of the
      // crew…", "Book lovers everywhere…"). A real heading: is short; does not
      // read as a sentence (no internal sentence-ending punctuation followed by
      // more words); and isn't a run of many lowercase words. We allow a single
      // trailing period (common in "CHAPTER 1. Loomings.").
      if (t.length > 80) return false;
      var inlineTitle = t.replace(/^\s*(chapter|letter|part|book|volume|canto|section|stave|act|scene)\b\s*[ivxlcdm\d]*\.?\s*[—:.\-]?\s*/i, '');
      // Internal sentence break (". " or "; ") mid-line ⇒ prose, not a heading.
      if (/[.;]\s+\S/.test(inlineTitle)) return false;
      // A long run of words is prose; real inline titles are short.
      if (inlineTitle.split(/\s+/).filter(Boolean).length > 9) return false;
      return true;
    }
    if (ROMAN_ONLY.test(t)) {
      var core = t.replace(/\./g, '');
      if (core.length >= 2) return true;          // "II", "IV", "XII" → heading
      if (/\.$/.test(t) && core === 'I') return false; // "I." alone is too risky
      return false;
    }
    return false;
  }

  function stripGutenberg(raw) {
    var t = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var startRe = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
    var endRe = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
    var s = t.search(startRe);
    if (s !== -1) t = t.slice(s).replace(startRe, '');
    var e = t.search(endRe);
    if (e !== -1) t = t.slice(0, e);
    t = t.replace(/^(?:\s*(?:Title|Author|Release date|Language|Credits|Other information and formats|Most recently updated|Produced by|Illustrator|Translator)\s*:[^\n]*\n?\s*\n?)+/i, '');
    return t.trim();
  }

  function extractMeta(raw) {
    var meta = { title: null, author: null };
    var titleM = /^\s*Title:\s*(.+)$/im.exec(raw);
    var authorM = /^\s*Author:\s*(.+)$/im.exec(raw);
    if (titleM) meta.title = titleM[1].trim();
    if (authorM) meta.author = authorM[1].trim();
    return meta;
  }

  function countWords(s) {
    var m = s.match(/\S+/g);
    return m ? m.length : 0;
  }

  function splitChapters(text) {
    var lines = text.split('\n');
    var chapters = [];
    var current = null;
    var paraBuf = [];

    function flushPara() {
      if (!current) return;
      var para = paraBuf.join(' ').replace(/\s+/g, ' ').trim();
      if (para) current.paras.push(para);
      paraBuf = [];
    }
    function flushChapter() {
      flushPara();
      if (current && current.paras.length) chapters.push(current);
      current = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isHeading(line)) {
        flushChapter();
        var title = line.trim().replace(/\s+/g, ' ');
        // If the heading is a BARE numeral (no inline title), the next short line
        // MAY be the chapter's title on its own line. Only fold it in when it
        // looks like a title (short, capitalised, not flowing prose).
        var hasInlineTitle = /[a-z]/i.test(title.replace(/^\s*(chapter|letter|part|book|volume|canto|section|stave|act|scene)\b\s*[ivxlcdm\d]*\.?/i, ''));
        if (!hasInlineTitle) {
          var j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length) {
            var cand = lines[j].trim();
            var looksLikeTitle = cand && cand.length < 50 && !isHeading(lines[j]) &&
              !/[,;]$/.test(cand) &&
              !/["'\u201c]/.test(cand.charAt(0)) &&
              /^[A-Z]/.test(cand);
            if (looksLikeTitle && cand.split(' ').length <= 7) {
              title += ' — ' + cand;
              i = j;
            }
          }
        }
        current = { title: title, paras: [] };
        continue;
      }
      if (line.trim() === '') {
        flushPara();
      } else {
        if (!current) current = { title: 'Beginning', paras: [] };
        paraBuf.push(line.trim());
      }
    }
    flushChapter();

    if (chapters.length === 0) {
      var paras = text.split(/\n\s*\n/)
        .map(function (p) { return p.replace(/\s+/g, ' ').trim(); })
        .filter(Boolean);
      chapters.push({ title: 'Full text', paras: paras });
    }
    return chapters;
  }

  function parse(raw, fallback) {
    fallback = fallback || {};
    var meta = extractMeta(raw);
    var body = stripGutenberg(raw);
    var chapters = splitChapters(body);
    var wordCount = chapters.reduce(function (n, c) {
      return n + c.paras.reduce(function (m, p) { return m + countWords(p); }, 0);
    }, 0);
    return {
      title: meta.title || fallback.title || 'Untitled',
      author: meta.author || fallback.author || 'Unknown',
      wordCount: wordCount,
      chapters: chapters
    };
  }

  var api = { parse: parse, stripGutenberg: stripGutenberg, splitChapters: splitChapters };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GutenbergParser = api;
})(typeof self !== 'undefined' ? self : this);
