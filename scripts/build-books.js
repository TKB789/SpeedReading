#!/usr/bin/env node
/*
 * build-books.js — parse every .txt in books-src/ into a repo book JSON and
 * regenerate books/manifest.json.
 *
 * This is the batch equivalent of build-book.js, meant to run in CI (GitHub
 * Actions) so you can add a book by committing a .txt file — no local Node run
 * needed. It reuses the SAME parser the browser uses (js/parser.js), so repo
 * books and uploaded books are chaptered identically.
 *
 * Layout it expects / produces:
 *   books-src/<slug>.txt   ← you add these (plain text; Gutenberg headers OK)
 *   books/<id>.json        ← generated: { title, author, wordCount, chapters }
 *   books/manifest.json    ← generated: [ { id, title, author, wordCount, ... } ]
 *
 * The book id is derived from the .txt filename (its slug), so a file's book
 * JSON is stable across rebuilds and progress/bookmarks keyed on id survive.
 *
 * Front-matter override: you can set title/author without editing the text by
 * adding a sidecar <slug>.json next to the .txt, e.g.
 *   books-src/frankenstein.json  → { "title": "Frankenstein", "author": "Mary Shelley", "sample": true }
 * Any of title/author/cover/sample there wins over what's parsed from the text.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SRC_DIR = path.join(ROOT, 'books-src');
var OUT_DIR = path.join(ROOT, 'books');
var MANIFEST = path.join(OUT_DIR, 'manifest.json');

var Parser = require(path.join(ROOT, 'js', 'parser.js'));

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/\.[^.]+$/, '')          // drop extension
    .replace(/[^a-z0-9]+/g, '-')      // non-alnum → dash
    .replace(/^-+|-+$/g, '')          // trim dashes
    .replace(/-{2,}/g, '-') || 'book';
}

function readSidecar(txtPath) {
  var jsonPath = txtPath.replace(/\.txt$/i, '.json');
  if (!fs.existsSync(jsonPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8')) || {};
  } catch (e) {
    console.warn('  ! ignoring malformed sidecar ' + path.basename(jsonPath) + ': ' + e.message);
    return {};
  }
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.log('No books-src/ directory found — nothing to build.');
    // Still ensure books/ + an (empty) manifest exist so the site loads.
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    if (!fs.existsSync(MANIFEST)) fs.writeFileSync(MANIFEST, '[]\n');
    return;
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  var txtFiles = fs.readdirSync(SRC_DIR)
    .filter(function (f) { return /\.txt$/i.test(f); })
    .sort();

  if (!txtFiles.length) {
    console.log('books-src/ has no .txt files — writing empty manifest.');
    fs.writeFileSync(MANIFEST, '[]\n');
    return;
  }

  var manifest = [];
  var seenIds = {};

  txtFiles.forEach(function (file) {
    var txtPath = path.join(SRC_DIR, file);
    var raw = fs.readFileSync(txtPath, 'utf8');
    var sidecar = readSidecar(txtPath);

    var id = sidecar.id || slugify(file);
    if (seenIds[id]) {
      console.warn('  ! duplicate id "' + id + '" from ' + file + ' — skipping.');
      return;
    }
    seenIds[id] = true;

    // Parse using the shared browser parser. `fallback` supplies title/author
    // when the text has no Gutenberg-style "Title:"/"Author:" header.
    var book = Parser.parse(raw, {
      title: sidecar.title || null,
      author: sidecar.author || null
    });

    // Sidecar overrides win outright (lets you fix a bad auto-detected title).
    if (sidecar.title) book.title = sidecar.title;
    if (sidecar.author) book.author = sidecar.author;

    if (!book.chapters.length || !book.wordCount) {
      console.warn('  ! no readable text in ' + file + ' — skipping.');
      return;
    }

    var outPath = path.join(OUT_DIR, id + '.json');
    fs.writeFileSync(outPath, JSON.stringify(book));
    console.log('  ✓ ' + file + ' → books/' + id + '.json  (' +
      book.chapters.length + ' chapters, ' + book.wordCount.toLocaleString() + ' words)');

    var entry = {
      id: id,
      title: book.title,
      author: book.author,
      wordCount: book.wordCount
    };
    if (sidecar.cover) entry.cover = sidecar.cover;
    if (sidecar.sample) entry.sample = true;
    manifest.push(entry);
  });

  // Prune stale generated book JSONs whose source .txt was removed. We only
  // delete files that correspond to a manifest slug pattern we manage, never
  // arbitrary files — a book is "managed" if a books-src file could produce it.
  var keep = {};
  manifest.forEach(function (m) { keep[m.id + '.json'] = true; });
  keep['manifest.json'] = true;
  fs.readdirSync(OUT_DIR).forEach(function (f) {
    if (!/\.json$/i.test(f)) return;
    if (keep[f]) return;
    // Only prune if a same-named .txt or sidecar is absent from books-src, i.e.
    // this JSON is genuinely orphaned by a managed source that no longer exists.
    var base = f.replace(/\.json$/i, '');
    var hadSource = txtFiles.some(function (t) { return slugify(t) === base; });
    if (!hadSource) {
      fs.unlinkSync(path.join(OUT_DIR, f));
      console.log('  - pruned orphaned books/' + f);
    }
  });

  manifest.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log('\nWrote books/manifest.json with ' + manifest.length + ' book(s).');
}

main();
