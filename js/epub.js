/* epub.js — parse an EPUB file into the SAME structured shape the .txt parser
 * produces: { title, author, wordCount, chapters: [{ title, paras: [...] }] }.
 * Because the output matches GutenbergParser.parse(), everything downstream — the
 * RSVP tokenizer, windowed pagination, coordinates, storage — works unchanged.
 *
 * EPUB is a ZIP of XHTML files plus manifests. We:
 *   1. unzip (JSZip — must be loaded before this script),
 *   2. read META-INF/container.xml → locate the .opf package file,
 *   3. parse the .opf → title/author + the spine (reading order of documents),
 *   4. read each spine document, strip XHTML → paragraphs,
 *   5. title each chapter from the nav/toc when available, else its first heading.
 *
 * Async: parse(file) returns a Promise<book>. XML/XHTML parsing uses the browser's
 * built-in DOMParser; no dependency beyond JSZip.
 */
(function (root) {
  'use strict';

  function err(msg) { throw new Error(msg); }

  function getJSZip() {
    if (typeof root.JSZip !== 'undefined') return root.JSZip;
    if (typeof JSZip !== 'undefined') return JSZip;
    err('EPUB support needs JSZip — js/vendor/jszip.min.js failed to load.');
  }

  // Resolve a path relative to a base file (both inside the zip).
  function resolvePath(base, rel) {
    if (/^[^/]+:\/\//.test(rel) || rel.charAt(0) === '/') return rel.replace(/^\//, '');
    var baseDir = base.indexOf('/') === -1 ? '' : base.replace(/\/[^/]*$/, '/');
    var parts = (baseDir + rel).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '.' || parts[i] === '') continue;
      if (parts[i] === '..') out.pop();
      else out.push(parts[i]);
    }
    return out.join('/');
  }

  function parseXML(text, kind) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      // Some XHTML parses better as HTML; caller decides. Signal failure softly.
      return null;
    }
    return doc;
  }

  // Turn one XHTML document's body into clean paragraphs. We parse as HTML
  // (lenient) and collect text from leaf block elements — a block that contains
  // other blocks is a container, not a paragraph, so we skip it and let its
  // children be collected instead. This avoids double-counting nested structures
  // (e.g. <div><p>…</p></div>) that are very common in EPUBs. Footnotes, nav,
  // script and style are dropped first.
  function xhtmlToParas(xhtml) {
    var doc = new DOMParser().parseFromString(xhtml, 'text/html');
    var body = doc.body || doc.documentElement;
    if (!body) return { heading: null, paras: [] };

    var drop = body.querySelectorAll('script,style,nav,header,footer,[hidden],[role="doc-pagebreak"]');
    for (var i = 0; i < drop.length; i++) drop[i].parentNode && drop[i].parentNode.removeChild(drop[i]);

    var heading = null;
    var hEl = body.querySelector('h1,h2,h3,h4');
    if (hEl) heading = (hEl.textContent || '').replace(/\s+/g, ' ').trim();

    var paras = [];
    var BLOCK = { P: 1, BLOCKQUOTE: 1, LI: 1, DIV: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, PRE: 1, SECTION: 1, ARTICLE: 1 };
    function hasBlockChild(el) {
      var kids = el.children || [];
      for (var k = 0; k < kids.length; k++) {
        var tn = (kids[k].tagName || '').toUpperCase();
        if (BLOCK[tn]) return true;
      }
      return false;
    }
    // Walk the body; collect text from leaf blocks only.
    (function walk(el) {
      var kids = el.children || [];
      for (var k = 0; k < kids.length; k++) {
        var c = kids[k];
        var tn = (c.tagName || '').toUpperCase();
        if (BLOCK[tn]) {
          if (hasBlockChild(c)) { walk(c); }            // container → descend
          else {
            var t = (c.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) paras.push(t);                        // leaf block → a paragraph
          }
        }
      }
    })(body);

    // Fallback: no block structure at all → split body text on blank lines.
    if (!paras.length) {
      var whole = (body.textContent || '').replace(/\r\n/g, '\n');
      paras = whole.split(/\n\s*\n/).map(function (p) { return p.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    }
    return { heading: heading, paras: paras };
  }

  function countWords(s) { var m = s.match(/\S+/g); return m ? m.length : 0; }

  // Build a map of spine-doc href → human title from the EPUB nav/toc, if present.
  function readTocTitles(zip, opfPath, opfDoc) {
    var titles = {};
    try {
      // EPUB3 nav document: item with properties="nav".
      var items = opfDoc.getElementsByTagName('item');
      var navHref = null, ncxHref = null;
      for (var i = 0; i < items.length; i++) {
        var props = items[i].getAttribute('properties') || '';
        var mt = items[i].getAttribute('media-type') || '';
        if (props.split(/\s+/).indexOf('nav') !== -1) navHref = items[i].getAttribute('href');
        if (mt === 'application/x-dtbncx+xml') ncxHref = items[i].getAttribute('href');
      }
      // We resolve+read these lazily in parse(); here we just return the hrefs.
      return { navHref: navHref, ncxHref: ncxHref };
    } catch (e) { return { navHref: null, ncxHref: null }; }
  }

  function parseNavTitles(navXhtml) {
    // EPUB3 nav: <nav epub:type="toc"><ol><li><a href="ch1.xhtml#x">Title</a>…
    var map = {};
    try {
      var doc = new DOMParser().parseFromString(navXhtml, 'text/html');
      var anchors = doc.querySelectorAll('nav a[href], a[href]');
      for (var i = 0; i < anchors.length; i++) {
        var href = anchors[i].getAttribute('href') || '';
        var base = href.split('#')[0];
        var label = (anchors[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (base && label && !map[base]) map[base] = label;
      }
    } catch (e) {}
    return map;
  }

  function parseNcxTitles(ncxXml) {
    // EPUB2 toc.ncx: <navPoint><navLabel><text>Title</text></navLabel><content src="ch1.html"/>
    var map = {};
    try {
      var doc = new DOMParser().parseFromString(ncxXml, 'application/xml');
      var points = doc.getElementsByTagName('navPoint');
      for (var i = 0; i < points.length; i++) {
        var labelEl = points[i].getElementsByTagName('text')[0];
        var contentEl = points[i].getElementsByTagName('content')[0];
        if (!labelEl || !contentEl) continue;
        var label = (labelEl.textContent || '').replace(/\s+/g, ' ').trim();
        var src = (contentEl.getAttribute('src') || '').split('#')[0];
        if (src && label && !map[src]) map[src] = label;
      }
    } catch (e) {}
    return map;
  }

  // Main entry. `file` is a File/Blob (the uploaded .epub). Returns Promise<book>.
  function parse(file, fallback) {
    fallback = fallback || {};
    var JSZipLib = getJSZip();
    return JSZipLib.loadAsync(file).then(function (zip) {
      // 1. container.xml → opf path
      var containerFile = zip.file('META-INF/container.xml');
      if (!containerFile) err('Not a valid EPUB (missing META-INF/container.xml).');
      return containerFile.async('string').then(function (containerXml) {
        var cdoc = parseXML(containerXml);
        var rootfile = cdoc && cdoc.getElementsByTagName('rootfile')[0];
        var opfPath = rootfile && rootfile.getAttribute('full-path');
        if (!opfPath) err('EPUB container does not point to a package file.');

        var opfFile = zip.file(opfPath);
        if (!opfFile) err('EPUB package file not found: ' + opfPath);
        return opfFile.async('string').then(function (opfXml) {
          var opf = parseXML(opfXml);
          if (!opf) err('Could not parse the EPUB package file.');

          // 2. metadata
          function metaText(tag) {
            var el = opf.getElementsByTagName(tag)[0] ||
              opf.getElementsByTagNameNS && opf.getElementsByTagNameNS('*', tag)[0];
            return el ? (el.textContent || '').trim() : null;
          }
          var title = metaText('dc:title') || metaText('title') || fallback.title || 'Untitled';
          var author = metaText('dc:creator') || metaText('creator') || fallback.author || 'Unknown';

          // 3. manifest id → href; spine → ordered idrefs
          var manifest = {};
          var items = opf.getElementsByTagName('item');
          for (var i = 0; i < items.length; i++) {
            var id = items[i].getAttribute('id');
            var href = items[i].getAttribute('href');
            var mt = items[i].getAttribute('media-type') || '';
            if (id && href) manifest[id] = { href: href, mediaType: mt };
          }
          var spineEls = opf.getElementsByTagName('itemref');
          var spine = [];
          for (var s = 0; s < spineEls.length; s++) {
            var idref = spineEls[s].getAttribute('idref');
            if (idref && manifest[idref]) spine.push(manifest[idref]);
          }
          if (!spine.length) err('EPUB has no readable spine (no chapters found).');

          // 4. toc titles (nav or ncx)
          var navInfo = readTocTitles(zip, opfPath, opf);
          var titlesPromise = Promise.resolve({});
          if (navInfo.navHref) {
            var navPath = resolvePath(opfPath, navInfo.navHref);
            var nf = zip.file(navPath);
            if (nf) titlesPromise = nf.async('string').then(function (x) {
              return remapTitles(parseNavTitles(x), navPath, opfPath);
            });
          } else if (navInfo.ncxHref) {
            var ncxPath = resolvePath(opfPath, navInfo.ncxHref);
            var ncf = zip.file(ncxPath);
            if (ncf) titlesPromise = ncf.async('string').then(function (x) {
              return remapTitles(parseNcxTitles(x), ncxPath, opfPath);
            });
          }

          // toc hrefs are relative to the toc file; remap them to be relative to
          // the opf (same base we resolve spine hrefs against) for lookup.
          function remapTitles(map, tocPath, opfPath) {
            var out = {};
            Object.keys(map).forEach(function (k) {
              var abs = resolvePath(tocPath, k);
              out[abs] = map[k];
            });
            return out;
          }

          return titlesPromise.then(function (tocTitles) {
            // 5. read each spine doc in order, build chapters
            var chapters = [];
            var seq = Promise.resolve();
            spine.forEach(function (item) {
              seq = seq.then(function () {
                var docPath = resolvePath(opfPath, item.href);
                var f = zip.file(docPath);
                if (!f) return;
                return f.async('string').then(function (xhtml) {
                  var parsed = xhtmlToParas(xhtml);
                  if (!parsed.paras.length) return; // skip empty docs (covers, etc.)
                  var title = tocTitles[docPath] || parsed.heading || ('Section ' + (chapters.length + 1));
                  chapters.push({ title: title, paras: parsed.paras });
                });
              });
            });
            return seq.then(function () {
              if (!chapters.length) err('No readable text found in this EPUB.');
              var wordCount = chapters.reduce(function (n, c) {
                return n + c.paras.reduce(function (m, p) { return m + countWords(p); }, 0);
              }, 0);
              return { title: title, author: author, wordCount: wordCount, chapters: chapters };
            });
          });
        });
      });
    });
  }

  var api = { parse: parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.EpubParser = api;
})(typeof self !== 'undefined' ? self : this);
