/* coords.js — content-anchored positions, the way EPUB CFI / Kindle locations
 * work. A position is {chapter, para, word}: the Nth display-token within a
 * given paragraph of a given chapter. Unlike a global token index, this address
 * is valid the instant that ONE chapter is tokenized — it does not depend on how
 * many tokens precede it — so resuming or jumping deep into a book never needs
 * the prefix loaded and never has to be "rebased" as more of the book streams in.
 *
 * This module is pure (no DOM); reader.js owns the token array and calls in.
 *
 * It also maintains an optional chapterStart map (chapter → first token index in
 * the current array) so resolve() is O(1) instead of scanning. reader.js updates
 * it as chapters are appended; if absent, resolve falls back to a linear scan.
 */
(function (root) {
  'use strict';

  // Derive the {chapter,para,word} coordinate for token position `i` in `toks`.
  function coordOf(toks, i) {
    var t = toks[i];
    if (!t) return { chapter: 0, para: 0, word: 0 };
    var w = 0;
    for (var k = i - 1; k >= 0; k--) {
      if (toks[k].chapter === t.chapter && toks[k].para === t.para) w++;
      else break;
    }
    return { chapter: t.chapter, para: t.para, word: w };
  }

  // Resolve a coordinate to a token index within `toks`. `chapterStart` (optional)
  // maps chapter→first index for O(1) entry. Returns -1 if the coordinate's
  // chapter is not present in `toks` yet.
  function resolve(toks, coord, chapterStart) {
    var start = -1;
    if (chapterStart && chapterStart[coord.chapter] != null) {
      start = chapterStart[coord.chapter];
    } else {
      for (var s = 0; s < toks.length; s++) {
        if (toks[s].chapter === coord.chapter) { start = s; break; }
      }
    }
    if (start === -1) return -1;
    var i = start;
    // advance to the target paragraph
    while (i < toks.length && toks[i].chapter === coord.chapter && toks[i].para < coord.para) i++;
    // advance `word` tokens within the paragraph
    var w = 0;
    while (i < toks.length && toks[i].chapter === coord.chapter &&
           toks[i].para === coord.para && w < coord.word) { i++; w++; }
    if (i >= toks.length) return toks.length - 1;
    return i;
  }

  // Is the coordinate's chapter loaded in `toks`?
  function isLoaded(toks, coord, chapterStart) {
    if (chapterStart && chapterStart[coord.chapter] != null) return true;
    for (var i = 0; i < toks.length; i++) if (toks[i].chapter === coord.chapter) return true;
    return false;
  }

  var api = { coordOf: coordOf, resolve: resolve, isLoaded: isLoaded };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Coords = api;
})(typeof self !== 'undefined' ? self : this);
