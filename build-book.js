#!/usr/bin/env node
/*
 * build-book.js — add a public-domain book to the repo library.
 *
 * Three modes:
 *   Search the Gutenberg catalogue by title/author (Gutendex API):
 *     node build-book.js --search "frankenstein shelley"
 *     node build-book.js --search "frankenstein shelley" --build   (build top hit)
 *   From a Project Gutenberg ID (downloads the official plain text):
 *     node build-book.js --gutenberg <numericId> [id] ["Title"] ["Author"]
 *   From a local file:
 *     node build-book.js <input.txt> <id> "<Title>" "<Author>"
 *
 * Examples:
 *   node build-book.js --search "pride and prejudice"
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
const P = require('./js/parser.js');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Use Node's built-in fetch (Node 18+). Retries with backoff because Gutenberg
// frequently rate-limits / resets connections from CI runners, and surfaces the
// real underlying cause (fetch hides it behind a generic "fetch failed").
async function fetchText(url, attempt) {
  attempt = attempt || 1;
  var MAX = 4;
  if (typeof fetch !== 'function') {
    throw new Error('global fetch unavailable — needs Node 18+ (runner uses Node 22)');
  }
  try {
    var res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/plain,text/html,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (res.status === 429 || res.status === 503) {
      // Rate-limited / temporarily unavailable — back off and retry.
      if (attempt < MAX) { await sleep(attempt * 2000); return fetchText(url, attempt + 1); }
      throw new Error('HTTP ' + res.status + ' (rate-limited) for ' + url);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.text();
  } catch (e) {
    var detail = (e && e.cause && e.cause.message) ? (' [' + e.cause.message + ']') : '';
    // Connection-level failures are often transient on CI — retry a few times.
    var transient = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket/i
      .test((e && e.message ? e.message : '') + (e && e.cause ? e.cause.code || e.cause.message : ''));
    if (transient && attempt < MAX) { await sleep(attempt * 2000); return fetchText(url, attempt + 1); }
    throw new Error((e && e.message ? e.message : 'fetch failed') + detail + ' for ' + url);
  }
}

// Query Gutendex (free Gutenberg metadata API) for public-domain matches.
// Returns an array of { id, title, author, downloads }.
function searchGutendex(query) {
  var url = 'https://gutendex.com/books?copyright=false&search=' +
    encodeURIComponent(query);
  return fetchText(url).then(function (body) {
    var data = JSON.parse(body);
    return (data.results || []).map(function (b) {
      var fmts = b.formats || {}, textUrl = null;
      Object.keys(fmts).forEach(function (mime) {
        if (!textUrl && /text\/plain/.test(mime) && !/\.zip$/.test(fmts[mime])) textUrl = fmts[mime];
      });
      return {
        id: b.id,
        title: b.title,
        author: (b.authors && b.authors[0] && b.authors[0].name) || 'Unknown',
        downloads: b.download_count || 0,
        textUrl: textUrl
      };
    });
  });
}

// Look up a single book's metadata AND its known-good text download URL via
// Gutendex (which tracks the actual working file location).
async function getMetaById(gid) {
  try {
    var body = await fetchText('https://gutendex.com/books/' + encodeURIComponent(gid));
    var b = JSON.parse(body);
    if (b && b.title) {
      var textUrl = null;
      var fmts = b.formats || {};
      // Prefer a plain-text format; avoid the .zip variants.
      Object.keys(fmts).forEach(function (mime) {
        if (!textUrl && /text\/plain/.test(mime) && !/\.zip$/.test(fmts[mime])) {
          textUrl = fmts[mime];
        }
      });
      return {
        title: b.title,
        author: (b.authors && b.authors[0] && b.authors[0].name) || 'Unknown',
        textUrl: textUrl
      };
    }
  } catch (e) { /* fall through to defaults */ }
  return null;
}

async function getGutenbergText(gid, knownUrl) {
  // Try Gutendex's known-good URL first (most reliable), then common patterns,
  // then a mirror, so a single host being blocked doesn't fail the whole thing.
  var urls = [];
  if (knownUrl) urls.push(knownUrl);
  urls.push(
    'https://www.gutenberg.org/cache/epub/' + gid + '/pg' + gid + '.txt',
    'https://www.gutenberg.org/ebooks/' + gid + '.txt.utf-8',
    'https://www.gutenberg.org/files/' + gid + '/' + gid + '-0.txt',
    'https://www.gutenberg.org/files/' + gid + '/' + gid + '.txt',
    // Mirror fallback (gutenberg.net.au-style mirrors vary; this is a common one).
    'https://gutenberg.pglaf.org/' + gid.split('').join('/') + '/' + gid + '/' + gid + '-0.txt'
  );
  var errors = [];
  for (var i = 0; i < urls.length; i++) {
    try { return await fetchText(urls[i]); }
    catch (e) { errors.push(urls[i] + ' → ' + e.message); }
  }
  throw new Error('All download URLs failed for #' + gid + ':\n  ' + errors.join('\n  '));
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
  if (argv[0] === '--search') {
    // node build-book.js --search "frankenstein shelley" [--build] [slug]
    var buildTop = argv.indexOf('--build') !== -1;
    var terms = argv.slice(1).filter(function (a) { return a !== '--build'; });
    // A trailing single token after --build with no spaces can be a slug; but to
    // keep it simple, treat everything before any --build as the query.
    var query = terms.join(' ').trim();
    if (!query) { console.error('Usage: node build-book.js --search "<title or author>" [--build]'); process.exit(1); }
    console.log('Searching Gutenberg for "' + query + '" …');
    var results = await searchGutendex(query);
    if (!results.length) { console.log('No public-domain matches found.'); return; }
    console.log('\nMatches (most downloaded first):');
    results.slice(0, 10).forEach(function (r, i) {
      console.log('  ' + (i + 1) + '. [ID ' + r.id + '] ' + r.title + ' — ' + r.author +
        '  (' + r.downloads.toLocaleString() + ' downloads)');
    });
    if (buildTop) {
      var top = results[0];
      console.log('\nBuilding top match: [ID ' + top.id + '] ' + top.title + ' …');
      var rawT = await getGutenbergText(top.id, top.textUrl);
      var bookT = P.parse(rawT, { title: top.title, author: top.author });
      bookT.id = 'pg' + top.id;
      bookT.title = top.title; bookT.author = top.author;
      bookT.source = 'Project Gutenberg #' + top.id + ' — public domain';
      writeBook(bookT);
    } else {
      console.log('\nTo add one, run:  node build-book.js --gutenberg <ID>');
      console.log('Or re-run this search with --build to build the top match.');
    }
  } else if (argv[0] === '--gutenberg') {
    var gidArg = argv[1];
    if (!gidArg) { console.error('Usage: node build-book.js --gutenberg <id>[,<id>...] [slug] ["Title"] ["Author"]'); process.exit(1); }
    // Allow a list: "2701, 1342 84" → build each. When a list is given, the
    // slug/title/author overrides are ignored (metadata comes from Gutendex).
    var ids = gidArg.split(/[\s,]+/).filter(Boolean);
    if (ids.length > 1) {
      var ok = 0, failed = [];
      for (var k = 0; k < ids.length; k++) {
        var oneId = ids[k];
        try {
          console.log('\n[' + (k + 1) + '/' + ids.length + '] Project Gutenberg #' + oneId + ' …');
          var meta = await getMetaById(oneId);
          var rawM = await getGutenbergText(oneId, meta && meta.textUrl);
          var bookM = P.parse(rawM, { title: meta && meta.title, author: meta && meta.author });
          bookM.id = 'pg' + oneId;
          if (meta && meta.title) bookM.title = meta.title;
          if (meta && meta.author) bookM.author = meta.author;
          bookM.source = 'Project Gutenberg #' + oneId + ' — public domain';
          writeBook(bookM);
          ok++;
        } catch (e) {
          console.error('  Skipped #' + oneId + ': ' + e.message);
          failed.push(oneId);
        }
      }
      console.log('\nDone: ' + ok + ' added' + (failed.length ? ', ' + failed.length + ' failed (' + failed.join(', ') + ')' : '') + '.');
      // Non-zero exit only if every single one failed.
      if (ok === 0) process.exit(1);
      return;
    }
    // Single ID (original behaviour, with optional overrides).
    var gid = ids[0];
    var id = argv[2] || ('pg' + gid);
    console.log('Downloading Project Gutenberg #' + gid + ' …');
    var metaS = await getMetaById(gid);
    var raw = await getGutenbergText(gid, metaS && metaS.textUrl);
    var book = P.parse(raw, {
      title: argv[3] || (metaS && metaS.title),
      author: argv[4] || (metaS && metaS.author)
    });
    book.id = id;
    if (argv[3]) book.title = argv[3]; else if (metaS && metaS.title) book.title = metaS.title;
    if (argv[4]) book.author = argv[4]; else if (metaS && metaS.author) book.author = metaS.author;
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
