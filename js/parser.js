/*
 * parser.js — turn a Project Gutenberg plain-text string into structured book
 * data: { title, author, wordCount, chapters: [{ title, paras: [...] }] }.
 *
 * Pure function, no DOM and no Node APIs, so the same code runs in the browser
 * (file upload) and in build-book.js (repo books). Exposed as a global
 * `GutenbergParser` for the browser and via module.exports for Node.
 */
(function (root) {
  'use strict';

  // Lines like "CHAPTER I.", "CHAPTER 12", "Chapter IV", a bare roman numeral,
  // or a bare number on their own line.
  var CHAPTER_RE = /^\s*(chapter\s+[ivxlcdm\d]+\.?.*|[ivxlcdm]+\.|\d+\.?)\s*$/i;

  function stripGutenberg(raw) {
    var t = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var startRe = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
    var endRe = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
    var s = t.search(startRe);
    if (s !== -1) t = t.slice(s).replace(startRe, '');
    var e = t.search(endRe);
    if (e !== -1) t = t.slice(0, e);
    // Drop a leading metadata block (Title:/Author:/Release date:/Language:/
    // Credits:) that some PG texts place after the START marker.
    t = t.replace(/^(?:\s*(?:Title|Author|Release date|Language|Credits|Other information and formats|Most recently updated|Produced by|Illustrator|Translator)\s*:[^\n]*\n?\s*\n?)+/i, '');
    return t.trim();
  }

  // Pull "Title:" and "Author:" out of the PG header if present.
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
      if (CHAPTER_RE.test(line)) {
        flushChapter();
        var title = line.trim().replace(/\s+/g, ' ');
        // A short non-heading line right after is treated as the chapter title.
        var j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && lines[j].trim() && !CHAPTER_RE.test(lines[j]) &&
            lines[j].trim().length < 70) {
          title += ' — ' + lines[j].trim();
          i = j;
        }
        current = { title: title, paras: [] };
        continue;
      }
      if (line.trim() === '') {
        flushPara();
      } else {
        // Start an implicit first chapter if text begins before any heading.
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

  // Main entry. `fallback` supplies title/author when the header lacks them.
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
