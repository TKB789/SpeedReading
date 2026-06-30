/*
 * parser.js — turn a Project Gutenberg plain-text string into structured book
 * data: { title, author, wordCount, chapters: [{ title, paras: [...] }] }.
 *
 * Approach (deliberately simple):
 *   1. If the book has a table of contents, the TOC IS the list of chapters.
 *      A body line is a chapter heading only if it matches a TOC entry. This is
 *      authoritative — it keeps real headings (with their titles), and rejects
 *      prose that merely starts with a keyword, stray "heading-like" lines, etc.
 *   2. If there's no TOC, fall back to a simple rule: a heading is a short line
 *      starting with a section keyword (Chapter/Letter/Part/…), not followed by
 *      lowercase prose, and with no comma/semicolon (which headings never have).
 *   3. Everything before the first heading is one section called "Beginning".
 *
 * Pure function, no DOM/Node APIs, so it runs in the browser (upload) and in
 * build-book.js (repo books). Exposed as global `GutenbergParser` and via
 * module.exports.
 */
(function (root) {
  'use strict';

  // Section keywords that can introduce a chapter/part/etc.
  var KEYWORD = /^\s*(chapter|letter|part|book|volume|canto|section|stave|act|scene|sonnet|prologue|epilogue|introduction|preface|argument)\b/i;

  // Normalize a heading line for TOC↔body matching: lowercase, drop brackets and
  // trailing punctuation, collapse whitespace. "Chapter I.]" and "CHAPTER I." →
  // "chapter i", so the same chapter matches regardless of stray punctuation/case.
  function normHeading(s) {
    return String(s).trim().toLowerCase()
      .replace(/[\[\].\):]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // The no-TOC fallback test: does this line look like a standalone heading?
  // Without a TOC to confirm titles, we require a NUMERAL after the keyword
  // (e.g. "Chapter 5", "LETTER IV", "CHAPTER THE LAST"). A keyword followed by
  // prose words ("Part. She wrote…", "letter said:") has no numeral and is
  // rejected. This is stricter than the TOC path on purpose: titles-without-
  // numbers can't be told from prose without the TOC as an answer key.
  function looksLikeHeadingLine(t) {
    if (!t || t.length > 70 || !KEYWORD.test(t)) return false;
    if (/[,;]/.test(t)) return false;
    var after = t.replace(KEYWORD, '').replace(/^[\s.\]\):\u2014-]+/, '');
    // Accept: a numeral (arabic or roman) optionally followed by a short title,
    // or the literal "the last" (CHAPTER THE LAST). Reject anything starting with
    // a lowercase or non-numeral word.
    if (!after) {
      // Bare keyword, no numeral. Only treat as a heading if it's ALL-CAPS
      // (e.g. "PREFACE."), which is how books mark unnumbered sections. A
      // lowercase bare keyword ("part.") is a wrapped prose line — reject.
      return /^[A-Z][A-Z\s.]*$/.test(t);
    }
    if (/^(\d+|[ivxlcdm]+)\b/i.test(after)) return true;       // "Chapter 5", "LETTER IV …"
    if (/^the\s+last\b/i.test(after)) return true;             // "CHAPTER THE LAST"
    return false;                                              // "Part. She wrote…" → prose
  }

  function stripGutenberg(raw) {
    var t = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var startRe = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
    var endRe = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
    var s = t.search(startRe);
    if (s !== -1) t = t.slice(s).replace(startRe, '');
    var e = t.search(endRe);
    if (e !== -1) t = t.slice(0, e);
    // Drop a leading metadata block some PG texts place after the START marker.
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

  // Locate the table of contents, if present. Returns { entries:Set, endLine:int }
  // where `entries` are normalized TOC headings and `endLine` is the last line of
  // the TOC block (so the caller can skip the whole block). null if no real TOC.
  //
  // A TOC is a CONTENTS marker followed by a dense run of heading lines. The body
  // begins at the first heading that is followed by substantial prose (≥10 lines);
  // the TOC's last entry is the heading just before that.
  function findToc(lines) {
    var c = -1;
    for (var i = 0; i < Math.min(lines.length, 500); i++) {
      if (/^\s*(table of )?contents\.?\s*$/i.test(lines[i])) { c = i; break; }
    }
    if (c === -1) return null;

    var heads = [];
    for (var j = c + 1; j < lines.length; j++) {
      var t = lines[j].trim();
      if (t && t.length <= 70 && KEYWORD.test(t)) heads.push(j);
    }
    if (heads.length < 3) return null;

    var entries = new Set();
    var tocEnd = -1;
    for (var k = 0; k < heads.length; k++) {
      var ln = heads[k];
      var nx = (k + 1 < heads.length) ? heads[k + 1] : lines.length;
      var prose = 0;
      for (var p = ln + 1; p < nx; p++) if (lines[p].trim()) prose++;
      if (prose >= 10) { tocEnd = (k > 0) ? heads[k - 1] : c; break; } // body began
      entries.add(normHeading(lines[ln].trim()));
    }
    if (entries.size < 3) return null;
    if (tocEnd === -1) tocEnd = heads[heads.length - 1]; // TOC ran to the last head
    return { entries: entries, endLine: tocEnd };
  }

  function splitChapters(text) {
    var lines = text.split('\n');
    var toc = findToc(lines);
    var startAt = toc ? toc.endLine + 1 : 0;  // skip the entire TOC block

    function isHeading(line) {
      var t = line.trim();
      if (!t) return false;
      if (toc) return KEYWORD.test(t) && t.length <= 70 && toc.entries.has(normHeading(t));
      return looksLikeHeadingLine(t);
    }

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

    for (var i = startAt; i < lines.length; i++) {
      var line = lines[i];
      if (isHeading(line)) {
        flushChapter();
        var title = line.trim().replace(/\s+/g, ' ');
        // Bare-numeral heading ("CHAPTER IV" with the title on the next line):
        // fold a following short Title-Case line into the heading.
        var afterKw = title.replace(KEYWORD, '').replace(/^[\s.\]\):\u2014-]+/, '');
        var bareNumeral = !afterKw || /^[ivxlcdm\d]+\.?$/i.test(afterKw);
        if (bareNumeral) {
          var n = i + 1;
          while (n < lines.length && lines[n].trim() === '') n++;
          if (n < lines.length) {
            var cand = lines[n].trim();
            if (cand && cand.length < 50 && !isHeading(lines[n]) &&
                /^[A-Z"\u201c]/.test(cand) && !/[,;]$/.test(cand) &&
                cand.split(/\s+/).length <= 7) {
              title += ' \u2014 ' + cand.replace(/\s+/g, ' ');
              i = n;
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

    // Safety net: drop any near-empty section (e.g. a stray TOC straggler). The
    // "Beginning" front matter is always kept.
    chapters = chapters.filter(function (c) {
      if (c.title === 'Beginning' || c.title === 'Full text') return true;
      var words = c.paras.reduce(function (n, p) { return n + countWords(p); }, 0);
      return words >= 20;
    });
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
