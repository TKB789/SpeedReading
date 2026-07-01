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
 *   books-src/<slug>.txt   ← you add these (deleted by CI after a successful build)
 *   books/<id>.json        ← generated + kept: { title, author, wordCount, chapters }
 *   books/manifest.json    ← generated: [ { id, title, author, wordCount, ... } ]
 *
 * The CI workflow removes each .txt after building, so the source text isn't
 * stored in the repo alongside its JSON. This script therefore does NOT prune a
 * book's JSON when its .txt is absent — a missing .txt is the normal state of an
 * already-built book. The manifest is rebuilt from every JSON present in books/,
 * so books built in earlier runs are preserved. To remove a book, delete its
 * books/<id>.json.
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
    // No new source text — but already-built books/<id>.json may exist (their
    // .txt was deleted after a prior build). Fall through so the manifest is
    // rebuilt from those, rather than wiping it.
    console.log('books-src/ has no .txt files — rebuilding manifest from existing books/.');
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
    // Persist presentation flags INTO the book JSON. The sidecar is deleted by
    // CI after building, and the manifest is later rebuilt from the JSON, so
    // storing these here is what makes them survive future rebuilds.
    if (sidecar.cover) book.cover = sidecar.cover;
    if (sidecar.sample) book.sample = true;

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
    if (book.cover) entry.cover = book.cover;
    if (book.sample) entry.sample = true;
    manifest.push(entry);
  });

  // NOTE: we intentionally do NOT prune books/<id>.json when its source .txt is
  // absent. The workflow deletes each .txt from the repo after a successful
  // build (to save storage), so a missing .txt is the NORMAL state for an
  // already-built book — its JSON is the thing we keep. To remove a book,
  // delete its books/<id>.json directly (and its manifest entry is rebuilt
  // from whatever JSONs remain; see below).

  // Rebuild the manifest from ALL book JSONs present in books/, so books built
  // in earlier runs — including any created by the singular build-book.js —
  // stay listed. We also MERGE the pre-existing manifest.json: build-book.js
  // stores `cover`/`source` only on the manifest entry (not inside <id>.json),
  // so reading them back from the old manifest is the only way to keep them.
  var builtById = {};
  manifest.forEach(function (m) { builtById[m.id] = m; });

  // Load whatever manifest already exists (may have been written by
  // build-book.js) and index it, to preserve fields we don't otherwise know.
  var priorById = {};
  if (fs.existsSync(MANIFEST)) {
    try {
      (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) || []).forEach(function (m) {
        if (m && m.id) priorById[m.id] = m;
      });
    } catch (e) {
      console.warn('  ! existing manifest.json is unreadable, rebuilding from JSONs: ' + e.message);
    }
  }

  var full = [];
  fs.readdirSync(OUT_DIR).forEach(function (f) {
    if (!/\.json$/i.test(f) || f === 'manifest.json') return;
    var id = f.replace(/\.json$/i, '');

    var entry;
    if (builtById[id]) {
      entry = builtById[id];            // built this run (freshest)
    } else {
      // Pre-existing book: read core metadata from its own JSON.
      try {
        var b = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
        entry = { id: id, title: b.title, author: b.author, wordCount: b.wordCount };
        if (b.cover) entry.cover = b.cover;
        if (b.sample) entry.sample = true;
      } catch (e) {
        console.warn('  ! skipping unreadable books/' + f + ': ' + e.message);
        return;
      }
    }

    // Layer on any manifest-only fields from the prior manifest that we didn't
    // set ourselves (e.g. `source`, or a `cover` that build-book.js stored only
    // in the manifest). Never overwrite a value we already have.
    var prior = priorById[id];
    if (prior) {
      Object.keys(prior).forEach(function (k) {
        if (entry[k] === undefined && prior[k] !== undefined && prior[k] !== null) {
          entry[k] = prior[k];
        }
      });
    }

    full.push(entry);
  });
  manifest = full;

  manifest.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log('\nWrote books/manifest.json with ' + manifest.length + ' book(s).');
}

main();
