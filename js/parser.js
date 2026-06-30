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
      // Distinguish a real heading ("CHAPTER 1. Loomings", "LETTER IV") from prose
      // that merely starts with a keyword ("letter said:", "Part of the crew…").
      var m = HEADING_KEYWORD.exec(t);
      var numeral = m[2];                 // "1", "IV", … or undefined
      var rest = (m[3] || '').replace(/^[\s—:.\-]+/, '').trim(); // inline title
      // If there's no numeral, the keyword must stand alone or be followed by a
      // title that looks like a title (starts uppercase). A following lowercase
      // word ("said", "of") means it's a sentence, not a heading.
      if (!numeral) {
        if (rest && /^[a-z]/.test(rest)) return false;   // "letter said:" → prose
      }
      // A keyword line must be reasonably short and not read as a sentence.
      if (t.length > 80) return false;
      if (/[.;]\s+\S/.test(rest)) return false;          // internal sentence break
      if (rest.split(/\s+/).filter(Boolean).length > 9) return false;
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
    t = stripTableOfContents(t);
    return t.trim();
  }

  // Remove a leading "CONTENTS" / "TABLE OF CONTENTS" block. Many Gutenberg texts
  // list every chapter heading up front; without removing it the parser treats
  // each TOC entry as a (near-empty) chapter, duplicating the whole chapter list.
  //
  // Strategy: find a CONTENTS heading; from there, skip forward past the run of
  // heading-like lines and their short description lines until we reach the point
  // where real body prose begins. We detect that as the SECOND occurrence of the
  // first chapter heading (the TOC lists it once, the body repeats it), or, if
  // there's no repeat, the first heading followed by multiple lines of flowing
  // prose. Conservative: if unsure, we leave the text untouched.
  function stripTableOfContents(text) {
    var lines = text.split('\n');
    // Locate a CONTENTS heading in the first part of the document.
    var tocStart = -1;
    var scanLimit = Math.min(lines.length, 400);
    for (var i = 0; i < scanLimit; i++) {
      if (/^\s*(table of contents|contents)\.?\s*$/i.test(lines[i])) { tocStart = i; break; }
    }
    if (tocStart === -1) return text;

    // Collect the chapter-heading labels that appear in the TOC region.
    var firstHeading = null;
    for (var j = tocStart + 1; j < lines.length; j++) {
      var lt = lines[j].trim();
      if (!lt) continue;
      if (HEADING_KEYWORD.test(lt) || ROMAN_ONLY.test(lt)) { firstHeading = lt.replace(/\s+/g, ' '); break; }
      // A non-heading, non-blank line right after CONTENTS that isn't a heading
      // means this probably isn't a real TOC — bail out to be safe.
      if (j > tocStart + 3) break;
    }
    if (!firstHeading) return text;

    // Find where the BODY begins: the second time the first chapter heading
    // appears (TOC lists it, body repeats it). Search after the TOC start.
    var bodyStart = -1;
    var seenFirst = false;
    for (var k = tocStart + 1; k < lines.length; k++) {
      var t2 = lines[k].trim().replace(/\s+/g, ' ');
      if (t2.toLowerCase() === firstHeading.toLowerCase()) {
        if (seenFirst) { bodyStart = k; break; }  // second occurrence = body
        seenFirst = true;                          // first occurrence = TOC entry
      }
    }
    // If the heading only appears once, there was no duplicate TOC — leave as is.
    if (bodyStart === -1) return text;

    // Drop everything from the CONTENTS heading up to (not including) the body.
    return lines.slice(0, tocStart).concat(lines.slice(bodyStart)).join('\n');
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
