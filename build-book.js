#!/usr/bin/env node
/*
 * build-book.js — add a public-domain book to the repo library.
 *
 * Two modes:
 *   From a local file:
 *     node build-book.js <input.txt> <id> "<Title>" "<Author>"
 *   From a Project Gutenberg ID (downloads the official plain text):
 *     node build-book.js --gutenberg <numericId> [id] ["Title"] ["Author"]
 *
 * Examples:
 *   node build-book.js --gutenberg 11
 *   node build-book.js --gutenberg 1342 pride "Pride and Prejudice" "Jane Austen"
 *   node build-book.js mybook.txt mybook "My Book" "Some Author"
 *
 * It strips PG boilerplate, splits chapters, writes books/<id>.json, and updates
 * books/manifest.json. It does NOT verify copyright — only run it on texts you
 * have confirmed are public domain / freely redistributable. Everything in the
 * Gutenberg catalog with copyright=false is cleared for the U.S.; check your
 * local law if you are elsewhere.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const P = require('./js/parser.js');

function fetchText(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location));
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { data += d; });
      res.on('end', function () { resolve(data); });
    }).on('error', reject);
  });
}

async function getGutenbergText(gid) {
  // Try the common plain-text URL patterns in order.
  var urls = [
    'https://www.gutenberg.org/cache/epub/' + gid + '/pg' + gid + '.txt',
    'https://www.gutenberg.org/files/' + gid + '/' + gid + '-0.txt',
    'https://www.gutenberg.org/files/' + gid + '/' + gid + '.txt'
  ];
  for (var i = 0; i < urls.length; i++) {
    try { return await fetchText(urls[i]); }
    catch (e) { if (i === urls.length - 1) throw e; }
  }
}

function writeBook(book, coverFile) {
  var booksDir = path.join(__dirname, 'books');
  fs.mkdirSync(booksDir, { recursive: true });
  fs.writeFileSync(path.join(booksDir, book.id + '.json'), JSON.stringify(book));

  var manifestPath = path.join(booksDir, 'manifest.json');
  var manifest = [];
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {}
  }
  manifest = manifest.filter(function (b) { return b.id !== book.id; });
  manifest.push({
    id: book.id, title: book.title, author: book.author,
    wordCount: book.wordCount, cover: coverFile || null,
    source: book.source || null
  });
  manifest.sort(function (a, b) { return a.title.localeCompare(b.title); });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('Built "' + book.title + '": ' + book.chapters.length +
    ' chapters, ' + book.wordCount.toLocaleString() + ' words → books/' + book.id + '.json');
}

async function main() {
  var argv = process.argv.slice(2);
  if (argv[0] === '--gutenberg') {
    var gid = argv[1];
    if (!gid) { console.error('Usage: node build-book.js --gutenberg <id> [id] ["Title"] ["Author"]'); process.exit(1); }
    var id = argv[2] || ('pg' + gid);
    console.log('Downloading Project Gutenberg #' + gid + ' …');
    var raw = await getGutenbergText(gid);
    var book = P.parse(raw, { title: argv[3], author: argv[4] });
    book.id = id;
    if (argv[3]) book.title = argv[3];
    if (argv[4]) book.author = argv[4];
    book.source = 'Project Gutenberg #' + gid + ' — public domain';
    writeBook(book);
  } else {
    var input = argv[0], id2 = argv[1], title = argv[2], author = argv[3];
    if (!input || !id2) {
      console.error('Usage:\n  node build-book.js <input.txt> <id> "<Title>" "<Author>"\n  node build-book.js --gutenberg <id> [id] ["Title"] ["Author"]');
      process.exit(1);
    }
    var raw2 = fs.readFileSync(input, 'utf8');
    var book2 = P.parse(raw2, { title: title, author: author });
    book2.id = id2;
    if (title) book2.title = title;
    if (author) book2.author = author;
    writeBook(book2);
  }
}

main().catch(function (e) { console.error('Error:', e.message); process.exit(1); });
