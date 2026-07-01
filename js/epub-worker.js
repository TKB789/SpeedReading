/* epub-worker.js — does the HEAVY part of EPUB loading off the main thread.
 *
 * Why a worker: unzipping a multi-megabyte EPUB (JSZip inflate) plus pulling
 * every chapter's text out of the archive is CPU-heavy and, done on the main
 * thread, freezes the page for seconds on a phone. A Web Worker runs it on a
 * background thread so the UI stays responsive (this is how fast readers like
 * speed-reader.com stay smooth on large files).
 *
 * Division of labour: the worker unzips and reads the container/opf/toc and the
 * raw XHTML of each spine document, then posts back a plain-data structure. It
 * does NOT build the DOM — DOMParser doesn't exist in workers — so the small,
 * fast XHTML→paragraph step happens on the main thread (chunked, with yields).
 *
 * Protocol:
 *   main → worker: { type:'parse', file: <File/Blob> }
 *   worker → main: { type:'meta',  title, author, count }            (once)
 *                  { type:'doc',   index, path, xhtml }              (per spine doc)
 *                  { type:'done',  navHref, ncxHref, nav, ncx, opfPath }
 *                  { type:'error', message }
 */
/* global importScripts, JSZip */
'use strict';

// JSZip is loaded relative to this worker file. The bootstrapping message tells
// us the base URL so the path works regardless of where the site is hosted.
var JSZIP_READY = false;

function ensureJSZip(base) {
  if (JSZIP_READY) return;
  // Try the CDN first (no manual file needed); fall back to a local copy.
  try {
    importScripts('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  } catch (e) {
    importScripts(base + 'js/vendor/jszip.min.js?v=1782940000');
  }
  JSZIP_READY = true;
}

function resolvePath(baseFile, rel) {
  if (/^[^/]+:\/\//.test(rel) || rel.charAt(0) === '/') return rel.replace(/^\//, '');
  var baseDir = baseFile.indexOf('/') === -1 ? '' : baseFile.replace(/\/[^/]*$/, '/');
  var parts = (baseDir + rel).split('/');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '.' || parts[i] === '') continue;
    if (parts[i] === '..') out.pop();
    else out.push(parts[i]);
  }
  return out.join('/');
}

// Minimal XML reads via regex — enough to pull the opf path, spine order, and
// metadata WITHOUT a DOM. (Robust DOM parsing of the chapter bodies still
// happens on the main thread; here we only need structural attributes.)
function attr(tag, name) {
  var m = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i').exec(tag) ||
          new RegExp(name + "\\s*=\\s*'([^']*)'", 'i').exec(tag);
  return m ? m[1] : null;
}
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); });
}
function tagText(xml, tag) {
  var m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(xml);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : null;
}

function parseEpub(file, base) {
  ensureJSZip(base);
  return JSZip.loadAsync(file).then(function (zip) {
    var containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('Not a valid EPUB (missing container.xml).');
    return containerFile.async('string').then(function (containerXml) {
      var rootMatch = /<rootfile\b[^>]*>/i.exec(containerXml);
      var opfPath = rootMatch && attr(rootMatch[0], 'full-path');
      if (!opfPath) throw new Error('EPUB container does not point to a package file.');
      var opfFile = zip.file(opfPath);
      if (!opfFile) throw new Error('EPUB package file not found: ' + opfPath);
      return opfFile.async('string').then(function (opf) {
        // metadata
        var title = tagText(opf, 'dc:title') || tagText(opf, 'title') || null;
        var author = tagText(opf, 'dc:creator') || tagText(opf, 'creator') || null;

        // manifest: id → {href, mediaType, props}
        var manifest = {};
        var itemRe = /<item\b[^>]*>/gi, im;
        var navHref = null, ncxHref = null;
        while ((im = itemRe.exec(opf))) {
          var id = attr(im[0], 'id'), href = attr(im[0], 'href');
          var mt = attr(im[0], 'media-type') || '';
          var props = attr(im[0], 'properties') || '';
          if (id && href) manifest[id] = { href: href, mediaType: mt };
          if (props.split(/\s+/).indexOf('nav') !== -1) navHref = href;
          if (mt === 'application/x-dtbncx+xml') ncxHref = href;
        }
        // spine order
        var spine = [];
        var refRe = /<itemref\b[^>]*>/gi, rm;
        while ((rm = refRe.exec(opf))) {
          var idref = attr(rm[0], 'idref');
          if (idref && manifest[idref]) spine.push(manifest[idref]);
        }
        if (!spine.length) throw new Error('EPUB has no readable spine.');

        // Read nav/ncx raw (titles parsed on the main thread, which has DOMParser).
        function readMaybe(href) {
          if (!href) return Promise.resolve(null);
          var p = resolvePath(opfPath, href);
          var f = zip.file(p);
          return f ? f.async('string').then(function (s) { return { path: p, xml: s }; })
                   : Promise.resolve(null);
        }

        self.postMessage({ type: 'meta', title: title, author: author, count: spine.length });

        // Stream each spine doc's raw XHTML back as it's decompressed. Posting
        // per-doc lets the main thread parse incrementally instead of waiting
        // for the whole book.
        var seq = Promise.resolve();
        spine.forEach(function (item, idx) {
          seq = seq.then(function () {
            var docPath = resolvePath(opfPath, item.href);
            var f = zip.file(docPath);
            if (!f) { self.postMessage({ type: 'doc', index: idx, path: docPath, xhtml: '' }); return; }
            return f.async('string').then(function (xhtml) {
              self.postMessage({ type: 'doc', index: idx, path: docPath, xhtml: xhtml });
            });
          });
        });

        return seq.then(function () {
          return Promise.all([readMaybe(navHref), readMaybe(ncxHref)]).then(function (res) {
            self.postMessage({
              type: 'done',
              opfPath: opfPath,
              nav: res[0], ncx: res[1]
            });
          });
        });
      });
    });
  });
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type === 'parse') {
    parseEpub(msg.file, msg.base || '').catch(function (err) {
      self.postMessage({ type: 'error', message: (err && err.message) || 'Could not read that EPUB.' });
    });
  }
};
