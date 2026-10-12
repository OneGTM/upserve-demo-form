#!/usr/bin/env node
/**
 * Which build of the form is each live page actually running?
 *
 * Installing the form is a manual paste into Webflow, so nothing ties a merged
 * PR to what visitors see. This closes that gap: it fingerprints the script in
 * every committed version of webflow/embed.html and webflow/partner-embed.html,
 * then finds those fingerprints on the live pages.
 *
 *   npm run check-live                       every page in upserve.com's sitemap
 *   npm run check-live -- /book-a-demo /go/restaurant-pos
 *
 * STALE  an older committed build: re-paste.
 * FAILED could not load the page, so it is unchecked.
 * EDITED close to a build but changed by hand in Webflow, with the difference.
 *        Port the edit into src/ or it is lost on the next paste.
 *
 * Exits 1 if any page runs something other than the current build, so it can
 * gate a release checklist. Read-only: it fetches public pages, nothing else.
 */
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://www.upserve.com';
const FILES = { 'webflow/embed.html': 'demo', 'webflow/partner-embed.html': 'partner' };

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
/* The build writes non-ASCII as \u2019 escapes; somewhere between the
   clipboard and the published page they come back as the literal characters.
   Same code either way, so decode before hashing. */
const norm = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
const hash = (s) => crypto.createHash('sha1').update(norm(s)).digest('hex');

/* For a script that matches no build: the closest one, and what differs.
   Common prefix and suffix are enough to show a hand edit. */
function closest(known, s) {
  const a = norm(s);
  let best = null;
  for (const v of known.values()) {
    const b = v.text;
    let i = 0, j = 0;
    while (i < a.length && a[i] === b[i]) i++;
    while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    const changed = Math.max(a.length - i - j, b.length - i - j);
    if (!best || changed < best.changed) {
      best = { v, changed, live: a.slice(i, a.length - j), build: b.slice(i, b.length - j),
               at: a.slice(Math.max(0, i - 30), i) };
    }
  }
  return best;
}
const scriptsIn = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/* fingerprint -> { form, ref, current } for every committed build, plus the
   working tree, which is what the next paste would ship. */
function knownBuilds() {
  const known = new Map();
  for (const [file, form] of Object.entries(FILES)) {
    const log = git('log', '--format=%h %ad %s', '--date=short', '--', file).trim().split('\n');
    log.reverse().forEach((line, i) => {
      const sha = line.split(' ')[0];
      let body;
      try { body = git('show', sha + ':' + file); } catch (e) { return; }
      for (const s of scriptsIn(body)) {
        known.set(hash(s), { form, ref: line.slice(0, 70), current: i === log.length - 1, text: norm(s) });
      }
    });
    const disk = path.join(ROOT, file);
    if (fs.existsSync(disk)) {
      for (const s of scriptsIn(fs.readFileSync(disk, 'utf8'))) {
        const h = hash(s);
        for (const v of known.values()) if (v.form === form) v.current = false;
        known.set(h, Object.assign({}, known.get(h) || { ref: 'working tree (not committed)' },
          { form, current: true, text: norm(s) }));
      }
    }
  }
  return known;
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (upserve-form check-live)' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function pages(args) {
  if (args.length) return args.map((a) => (a.startsWith('http') ? a : SITE + a));
  const xml = await get(SITE + '/sitemap.xml');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

(async () => {
  const known = knownBuilds();
  const urls = await pages(process.argv.slice(2));
  const explicit = process.argv.length > 2;
  let stale = 0;
  let seen = 0;

  for (let i = 0; i < urls.length; i += 8) {
    const batch = urls.slice(i, i + 8);
    /* One retry, then report it: a page that failed to load is not a page
       without the form, and skipping it hid /book-a-demo once. */
    const htmls = await Promise.all(batch.map((u) =>
      get(u).catch(() => get(u)).catch((e) => ({ failed: e.message || String(e) }))));
    batch.forEach((url, j) => {
      const html = htmls[j];
      if (html && html.failed) {
        stale++;
        console.log('FAILED ' + url + '  (could not load: ' + html.failed + ')');
        return;
      }
      const hasForm = /id="?usv-(partner-)?form\b/.test(html);
      if (!hasForm) {
        if (explicit) { stale++; console.log('NONE   ' + url + '  (no Upserve form on the page)'); }
        return;
      }
      seen++;
      const scripts = scriptsIn(html);
      const hits = scripts.map((s) => known.get(hash(s))).filter(Boolean);
      if (!hits.length) {
        stale++;
        const own = scripts.filter((s) => /usv/.test(s)).sort((x, y) => y.length - x.length)[0];
        const c = own && closest(known, own);
        console.log('EDITED ' + url + (c && c.changed < 400
          ? '  ' + c.v.form + ' form, ' + c.v.ref + '\n         differs after "…' + c.at + '": live "' +
            c.live.slice(0, 80) + '" vs build "' + c.build.slice(0, 80) + '"'
          : '  (a form, but no committed build is close: hand-edited?)'));
        return;
      }
      for (const h of hits) {
        if (!h.current) stale++;
        console.log((h.current ? 'ok     ' : 'STALE  ') + url + '  ' + h.form + ' form, ' + h.ref);
      }
    });
  }

  console.log('\n' + seen + ' page(s) with the form, ' + stale + ' need attention (stale, edited, missing or failed to load).');
  process.exit(stale ? 1 : 0);
})();
