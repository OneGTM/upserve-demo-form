#!/usr/bin/env node
/**
 * build.js — turns the readable source into one Webflow-sized embed.
 *
 *   src/webflow-embed.html  (source of truth, edit this)
 *        |
 *        +--> webflow/embed.html   ONE paste -> one Webflow Embed element
 *        +--> preview.html         full page for local testing
 *        +--> prototype.html       shareable demo, Default + Google stubbed
 *
 * Webflow caps a Code Embed at 50,000 characters. The source is ~76,000
 * readable characters, so this strips comments and collapses whitespace.
 * Nothing is renamed or rewritten: the output is the same code, unindented,
 * so it stays debuggable in devtools.
 *
 * Run:  node build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src', 'webflow-embed.html');
const OUT_DIR = path.join(ROOT, 'webflow');

const EMBED_LIMIT = 50000;

/* ---------------------------------------------------------------------------
   A single scanner walks the JS once, classifying every character as code,
   string, template, regex or comment. Comment stripping and whitespace
   collapsing both ride on it, so neither can corrupt a `//` inside a URL or a
   `/` inside a character class.
   --------------------------------------------------------------------------- */
function minifyJs(src) {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'terser');
  if (fs.existsSync(bin)) {
    const tmp = path.join(os.tmpdir(), 'usv-terser-in.js');
    try {
      fs.writeFileSync(tmp, src);
      const out = execFileSync(bin,
        [tmp, '--compress', '--mangle', '--format', 'quote_style=1'],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      fs.unlinkSync(tmp);
      if (out && out.trim()) return out.trim();
    } catch (e) {
      console.warn('  warn: terser failed, falling back to the built-in stripper');
      console.warn('        ' + String(e.message).split('\n')[0]);
    }
  } else {
    console.warn('  warn: terser not installed — run `npm install` for a smaller build');
  }
  return stripAndCollapse(src);
}

/* The fallback: comment stripping and whitespace collapsing only. Keeps the
   build working without node_modules, just larger. */
function stripAndCollapse(src) {
  let out = '';
  let i = 0;
  const n = src.length;

  // Last significant character emitted, used to decide `/` = regex vs divide.
  let prev = '';
  const KEYWORD_BEFORE_REGEX =
    /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/;

  const regexCanFollow = () => {
    if (prev === '') return true;
    if ('(,=:[!&|?{};+-*%~^<>'.includes(prev)) return true;
    return KEYWORD_BEFORE_REGEX.test(out.replace(/\s+$/, ''));
  };

  // Whitespace between these needs no space at all.
  const PUNCT = '{}()[];,:<>+-*/%=!&|?~^';

  const emit = (s) => {
    out += s;
    const t = s.replace(/\s+$/, '');
    if (t) prev = t[t.length - 1];
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '/' && c2 === '/') {                       // line comment
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    if (c === '/' && c2 === '*') {                       // block comment
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    if (c === '"' || c === "'") {                        // string
      const quote = c;
      let s = c; i++;
      while (i < n) {
        if (src[i] === '\\') { s += src[i] + (src[i + 1] || ''); i += 2; continue; }
        s += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      emit(s);
      continue;
    }

    if (c === '`') {                                     // template literal
      let s = c; i++;
      while (i < n) {
        if (src[i] === '\\') { s += src[i] + (src[i + 1] || ''); i += 2; continue; }
        s += src[i];
        if (src[i] === '`') { i++; break; }
        i++;
      }
      emit(s);
      continue;
    }

    if (c === '/' && regexCanFollow()) {                 // regex literal
      let s = c; i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { s += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        s += src[i];
        if (src[i] === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[gimsuyd]/.test(src[i])) { s += src[i]; i++; }
      emit(s);
      continue;
    }

    if (/\s/.test(c)) {                                  // whitespace run
      let j = i;
      let sawNewline = false;
      while (j < n && /\s/.test(src[j])) { if (src[j] === '\n') sawNewline = true; j++; }
      i = j;

      // Peek at the next real character to decide whether any gap is needed.
      const next = src[i] || '';

      // Two identifier/literal characters must stay apart. Everything else
      // (a brace, a paren, an operator on either side) needs nothing.
      const needsGap = !PUNCT.includes(prev) && !PUNCT.includes(next) && prev !== '' && next !== '';

      if (needsGap) {
        out += ' ';
      } else if (sawNewline && !PUNCT.includes(prev) && prev !== '') {
        // Keep a newline where ASI might be load-bearing: after an identifier,
        // literal or `)` with no semicolon. Cheap insurance, costs one byte.
        out += '\n';
      }
      continue;
    }

    emit(c);
    i++;
  }

  return out.replace(/\n{2,}/g, '\n').trim();
}

/**
 * Escape non-ASCII to \uXXXX. Curly quotes and em dashes live in the
 * user-facing strings; if a host ever serves the page without a charset, or a
 * CMS re-encodes on paste, those bytes come back as mojibake ("isn't" ->
 * "isnâ€™t"). \uXXXX is charset proof.
 */
function escapeNonAscii(js) {
  return js.replace(/[^\x00-\x7F]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .replace(/\s*!important/g, '!important')
    .replace(/:\s*0px\b/g, ':0')
    .trim();
}

/**
 * Collapse HTML whitespace without touching anything a browser renders.
 * Inline elements are whitespace-sensitive, so gaps between tags are only
 * removed when at least one side is a block-level tag we control.
 */
function minifyHtml(html) {
  const BLOCK = 'div|section|form|fieldset|ul|li|p|h2|h3|button|select|option|input|link|style';
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n\s*/g, '\n')
    .replace(new RegExp('>\\s*\\n\\s*<(/?(?:' + BLOCK + ')\\b)', 'g'), '><$1')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+>/g, '>')
    .trim();
}

/**
 * Shorten every `usv-*` class, id and `--usv-*` custom property to a short
 * token, consistently across CSS, markup and JS.
 *
 * Safe because every name this form owns carries the `usv-` prefix and always
 * appears as a whole token. Default's own `def-form-*` classes, `name`
 * attributes, `aria-*` and `data-*` hooks are untouched, so the form is still
 * addressable from the outside by the things that actually matter.
 *
 * Generated names are letters-only (ua, ub, ... uaa). That matters: the option
 * rows build their ids as `'usv-opt-' + index`, so the mapped prefix gets a
 * digit appended at runtime — a letters-only alphabet means those runtime ids
 * can never collide with a name assigned here.
 */
function shortenTokens(parts) {
  const TOKEN = /(--)?usv-[a-z0-9-]*/g;
  const seen = new Map();
  let counter = 0;

  const nextName = () => {
    let n = counter++;
    let s = '';
    do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return 'u' + s;
  };

  for (const text of parts) {
    for (const m of text.matchAll(TOKEN)) {
      if (!seen.has(m[0])) seen.set(m[0], (m[1] ? '--' : '') + nextName());
    }
  }

  const map = Object.fromEntries(seen);
  const applied = parts.map((t) => t.replace(TOKEN, (m) => map[m]));
  return { parts: applied, map };
}

/* --------------------------------------------------------------------------- */

/**
 * Secrets live outside git. config.local.json is gitignored; the tracked
 * source keeps a placeholder so a client's API key never enters history.
 * Copy config.example.json -> config.local.json and fill it in.
 */
function loadLocalConfig() {
  const p = path.join(ROOT, 'config.local.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error('config.local.json is not valid JSON: ' + e.message); process.exit(1); }
}

let source = fs.readFileSync(SRC, 'utf8');
const local = loadLocalConfig();

if (local && local.GOOGLE_MAPS_API_KEY) {
  const before = source;
  source = source.replace(
    /(GOOGLE_MAPS_API_KEY\s*:\s*)'[^']*'/,
    "$1'" + local.GOOGLE_MAPS_API_KEY + "'"
  );
  if (source === before) console.warn("  warn: could not inject GOOGLE_MAPS_API_KEY");
}

const scriptOpen = source.lastIndexOf('<script>');
const scriptClose = source.lastIndexOf('</script>');
if (scriptOpen < 0 || scriptClose < 0) {
  console.error('Could not find the <script> block in ' + SRC);
  process.exit(1);
}

const head = source.slice(0, scriptOpen).trimEnd();

/* The demo triggers are a prototype affordance, not a product feature. Strip
   the whole block so nothing demo-related can ever reach the live site — not
   the chips, not the ?demo=1 switch, not the debug logging. */
const js = source
  .slice(scriptOpen + '<script>'.length, scriptClose)
  .replace(/\/\* DEMO-BLOCK-START \*\/[\s\S]*?\/\* DEMO-BLOCK-END \*\//, '');

const styleMatch = head.match(/<style>([\s\S]*?)<\/style>/);
const markup = head.replace(/<style>[\s\S]*?<\/style>/, '__STYLE__');

const BANNER =
  '<!-- Upserve demo request form. One Webflow Embed element, nothing else needed.\n' +
  '     Generated by build.js - edit src/webflow-embed.html, not this file.\n' +
  '     Config (Google key, Default question IDs, routing) is at the top of the script. -->\n';

const shortened = shortenTokens([
  minifyHtml(markup),
  minifyCss(styleMatch ? styleMatch[1] : ''),
  escapeNonAscii(minifyJs(js))
]);
const [outHtml, outCss, outJs] = shortened.parts;

const embed =
  BANNER +
  outHtml.replace('__STYLE__', '<style>' + outCss + '</style>') +
  '\n<script>' + outJs + '</script>\n';

fs.mkdirSync(OUT_DIR, { recursive: true });
if (embed.length <= EMBED_LIMIT) fs.writeFileSync(path.join(OUT_DIR, 'embed.html'), embed);

/* Webflow caps ONE Code Embed at 50,000 characters. When the form outgrows
   that, the sanctioned workaround is a second embed — so emit the split
   automatically rather than making someone discover the cap by having Webflow
   truncate their paste. Splitting at the style/script boundary is safe: the
   markup and CSS land first, the script runs after and finds the DOM waiting.

   embed.html stays the canonical artifact either way — it is what the tests
   drive, and what any host without a 50k cap can use as-is. */
const styleEnd = embed.indexOf('</style>') + '</style>'.length;
const usesSplit = embed.length > EMBED_LIMIT;

if (usesSplit) {
  const head =
    '<!-- Upserve demo form — PART 1 of 2: styles + markup.\n' +
    '     Paste into a Webflow Embed element. Part 2 goes in a SECOND embed\n' +
    '     directly below this one. Order matters. -->\n' +
    embed.slice(0, styleEnd) + '\n' +
    embed.slice(styleEnd, embed.indexOf('<script>')).trim() + '\n';
  const tail =
    '<!-- Upserve demo form — PART 2 of 2: logic.\n' +
    '     Paste into a Webflow Embed element placed AFTER part 1. -->\n' +
    embed.slice(embed.indexOf('<script>'));

  fs.writeFileSync(path.join(OUT_DIR, 'embed-part1.html'), head);
  fs.writeFileSync(path.join(OUT_DIR, 'embed-part2.html'), tail);
  global.__usvSplit = [head.length, tail.length];

  /* embed.html is over the cap and must not be pasted, so it does not get to
     sit in webflow/ looking like the thing to paste. The parts are the
     artifact; concatenating them reproduces it exactly if ever needed. */
  const whole = path.join(OUT_DIR, 'embed.html');
  if (fs.existsSync(whole)) fs.unlinkSync(whole);
} else {
  for (const stale of ['embed-part1.html', 'embed-part2.html']) {
    const q = path.join(OUT_DIR, stale);
    if (fs.existsSync(q)) fs.unlinkSync(q);
  }
}

/* Names are shortened in the output. Keep the mapping so a minified class seen
   in devtools can be traced back to its source name. */
fs.writeFileSync(
  path.join(OUT_DIR, 'embed.names.json'),
  JSON.stringify(shortened.map, null, 2) + '\n'
);

/* remove the old two-part output so nobody pastes a stale half */
for (const stale of ['1-form.html', '2-script.html']) {
  const p = path.join(OUT_DIR, stale);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/* --- local preview: the untouched source wrapped in a page ----------------- */
const preview = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upserve — Demo Request Form (preview)</title>
<style>
  html,body{margin:0;padding:0;}
  body{
    min-height:100vh;
    background:
      radial-gradient(1100px 620px at 50% -12%, rgba(255,205,4,.16), transparent 62%),
      linear-gradient(180deg,#151310 0%,#0a0908 100%);
    background-color:#0a0908;
  }
  .pv-head{display:flex;align-items:center;justify-content:center;gap:10px;padding:44px 20px 4px;}
  .pv-logo{font-family:"Fraunces",Georgia,serif;font-weight:700;font-size:30px;color:#fff;letter-spacing:-.02em;}
  .pv-dot{width:27px;height:27px;border-radius:50%;border:2px solid #fff;position:relative;}
  .pv-dot::before{content:"";position:absolute;left:50%;top:5px;transform:translateX(-50%);width:2px;height:6px;background:#fff;}
  .pv-dot::after{content:"";position:absolute;left:4px;right:4px;top:11px;height:2px;background:#fff;border-radius:2px;box-shadow:0 4px 0 -0.5px #fff;}
  .pv-note{max-width:560px;margin:0 auto;padding:0 20px 40px;font-family:"Lato",system-ui,sans-serif;
    font-size:12.5px;line-height:1.6;color:rgba(255,255,255,.42);text-align:center;}
  .pv-note code{color:rgba(255,255,255,.68);}
</style>
</head>
<body>
  <div class="pv-head"><span class="pv-dot"></span><span class="pv-logo">Upserve</span></div>
${source}
  <p class="pv-note">
    Local preview of the readable source. Add <code>?demo=1</code> for the bot-fill,
    fast-submit and typo-email triggers. Places autocomplete needs a real key in
    <code>CFG.GOOGLE_MAPS_API_KEY</code> — without one the name field is a plain text
    input and everything else still works.
  </p>
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, 'preview.html'), preview);

/* --- prototype.html: shareable demo ---------------------------------------
   Same code path, two swaps so it is safe to hand to anyone:
     1. window.DefaultSDK is stubbed, so nothing reaches Default.
     2. google.maps.importLibrary is stubbed with canned restaurants, so the
        autocomplete is demonstrable without shipping an API key in a public page.
   The artifact host supplies its own <head>, so the JS is escaped rather than
   relying on a charset declaration.
   --------------------------------------------------------------------------- */
const protoSource = source
  .replace(/GOOGLE_MAPS_API_KEY\s*:\s*'[^']*'/, "GOOGLE_MAPS_API_KEY : 'PROTOTYPE_CANNED_DATA'")
  .replace(/<script>([\s\S]*?)<\/script>/g,
    (_, body) => '<script>' + escapeNonAscii(body) + '</script>');

const protoShell = fs.readFileSync(path.join(ROOT, 'src', 'prototype-shell.html'), 'utf8');
fs.writeFileSync(
  path.join(ROOT, 'prototype.html'),
  protoShell.replace('<!--FORM-->', buildPrototypeStub() + '\n' + protoSource)
);

function buildPrototypeStub() {
  return `<script>
/* Prototype harness - not part of the Webflow build.
   Stubs Default and Google so this page is safe to share and click. */
(function () {
  'use strict';

  try { history.replaceState({}, '', location.pathname + '?demo=1'); } catch (e) {}

  /* Mimic Default's auto-attach SDK: bind to any form carrying
     data-default-form-id, read the fields off the DOM the way it does, and
     record the payload instead of sending it. */
  /* Stop the real Default SDK from ever loading here. Without this the embed
     boots it, it attaches to the form, and a completed prototype submission
     creates a genuine lead in Default and redirects off the page. */
  window.__default__loaded = true;

  window.__usvSubmissions = [];
  var CB = {};
  window.__default__ = window.__default__ || {};
  window.__default__.registerSubmissionCallbacks = function (cbs) { CB = cbs || {}; };
  window.__default__.reportSchedulerNotBooked = function () { return false; };
  window.__default__.displayLoadingModal = function () {};

  function readForm(form) {
    var out = {}, i, el;
    for (i = 0; i < form.elements.length; i++) {
      el = form.elements[i];
      if (!el.name || el.type === 'password') continue;
      if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) continue;
      out[el.name] = el.value;
    }
    return out;
  }

  function bind() {
    var forms = document.querySelectorAll('form[data-default-form-id]');
    for (var i = 0; i < forms.length; i++) {
      if (forms[i].__usvBound) continue;
      forms[i].__usvBound = true;
      (function (f) {
        f.addEventListener('submit', function () {
          var payload = {
            form_id: f.getAttribute('data-default-form-id'),
            team_id: window.__default__.team_id,
            fields: readForm(f)
          };
          window.__usvSubmissions.push(payload);
          if (window.console) console.log('[prototype] captured, not sent:', payload);
          window.setTimeout(function () { CB.onSuccess && CB.onSuccess({ success: true }); }, 420);
        });
      }(forms[i]));
    }
  }
  var bindTries = 0;
  var bindPoll = setInterval(function () { bind(); if (bindTries++ > 40) clearInterval(bindPoll); }, 150);

  var DATA = [
    { id:'p_shortys_south',  name:"Shorty's BBQ South Miami",  addr:'9200 S Dixie Hwy, Miami, FL 33156',
      city:'Miami', region:'FL', postal:'33156', site:'https://shortys.com', tel:'(305) 670-7732',
      rating:4.5, reviews:4821, price:'INEXPENSIVE' },
    { id:'p_shortys_west',   name:"Shorty's BBQ West Miami",   addr:'11575 SW 40th St, Miami, FL 33165',
      city:'Miami', region:'FL', postal:'33165', site:'https://shortys.com', tel:'(305) 227-3196',
      rating:4.4, reviews:3110, price:'INEXPENSIVE' },
    { id:'p_tautog',         name:'Tautog Tavern',             addr:'20 Bowens Wharf, Newport, RI 02840',
      city:'Newport', region:'RI', postal:'02840', site:'https://tautogtavern.com', tel:'(401) 849-2900',
      rating:4.3, reviews:1290, price:'MODERATE' },
    { id:'p_justwingit',     name:'Just Wing It',              addr:'318 Thames St, Newport, RI 02840',
      city:'Newport', region:'RI', postal:'02840', site:'', tel:'(401) 555-0184',
      rating:4.6, reviews:642, price:'INEXPENSIVE' },
    { id:'p_harborline',     name:'Harborline Oyster Bar',     addr:'55 Long Wharf, Boston, MA 02110',
      city:'Boston', region:'MA', postal:'02110', site:'https://harborline.com', tel:'(617) 555-0142',
      rating:4.7, reviews:2044, price:'EXPENSIVE' },
    { id:'p_federalhill',    name:'Federal Hill Trattoria',    addr:'233 Atwells Ave, Providence, RI 02903',
      city:'Providence', region:'RI', postal:'02903', site:'https://fedhilltrattoria.com', tel:'(401) 555-0110',
      rating:4.5, reviews:1873, price:'MODERATE' },
    { id:'p_copperkettle',   name:'Copper Kettle Brewing Co.', addr:'1401 Blake St, Denver, CO 80202',
      city:'Denver', region:'CO', postal:'80202', site:'https://copperkettle.beer', tel:'(303) 555-0177',
      rating:4.4, reviews:988, price:'MODERATE' },
    { id:'p_grayowl',        name:'The Gray Owl',              addr:'742 Valencia St, San Francisco, CA 94110',
      city:'San Francisco', region:'CA', postal:'94110', site:'https://thegrayowlsf.com', tel:'(415) 555-0163',
      rating:4.6, reviews:1544, price:'EXPENSIVE' },
    { id:'p_nixta',          name:'Nixta Taqueria',            addr:'2512 E 12th St, Austin, TX 78702',
      city:'Austin', region:'TX', postal:'78702', site:'https://nixtataqueria.com', tel:'(512) 555-0129',
      rating:4.8, reviews:3306, price:'INEXPENSIVE' },
    { id:'p_barvela',        name:'Bar Vela',                  addr:'88 N 6th St, Brooklyn, NY 11249',
      city:'Brooklyn', region:'NY', postal:'11249', site:'', tel:'(718) 555-0195',
      rating:4.2, reviews:511, price:'MODERATE' }
  ];

  var CITIES = [
    { city:'New York',  region:'NY', postal:'10010', addr:'1112 Broadway',     area:'212', lat:40.7392, lng:-73.9903 },
    { city:'Chicago',   region:'IL', postal:'60607', addr:'820 W Randolph St', area:'312', lat:41.8842, lng:-87.6489 },
    { city:'Austin',    region:'TX', postal:'78701', addr:'404 Colorado St',   area:'512', lat:30.2669, lng:-97.7428 },
    { city:'Miami',     region:'FL', postal:'33139', addr:'1200 Collins Ave',  area:'305', lat:25.7860, lng:-80.1300 },
    { city:'Denver',    region:'CO', postal:'80202', addr:'1600 Wazee St',     area:'303', lat:39.7524, lng:-105.0006 }
  ];
  var CATS = ['Restaurant', 'Bar & grill', 'Italian restaurant', 'Seafood restaurant', 'Cafe'];

  function titleCase(s) {
    return s.replace(/\\S+/g, function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  }

  /* Deterministic so the same query always yields the same demo results. */
  function synth(input, n) {
    var seed = 0, i;
    for (i = 0; i < input.length; i++) seed += input.charCodeAt(i);
    var nm = titleCase(input), out = [];
    for (i = 0; i < n; i++) {
      var c = CITIES[(seed + i) % CITIES.length];
      out.push({
        id: 'demo_' + seed + '_' + i,
        name: nm,
        addr: c.addr + ', ' + c.city + ', ' + c.region + ' ' + c.postal,
        city: c.city, region: c.region, postal: c.postal,
        site: 'https://' + nm.toLowerCase().replace(/[^a-z0-9]+/g, '') + '.com',
        tel: '(' + c.area + ') 555-0' + (100 + ((seed + i) % 800)),
        rating: Number((3.9 + ((seed + i) % 11) / 10).toFixed(1)),
        reviews: 120 + ((seed * (i + 3)) % 3400),
        price: ['INEXPENSIVE','MODERATE','EXPENSIVE'][(seed + i) % 3],
        cat: CATS[(seed + i) % CATS.length],
        lat: c.lat, lng: c.lng
      });
    }
    return out;
  }

  function makePlace(rec) {
    return {
      id: rec.id,
      fetchFields: function () {
        var self = this;
        return new Promise(function (res) {
          window.setTimeout(function () {
            self.displayName         = rec.name;
            self.formattedAddress    = rec.addr;
            self.websiteURI          = rec.site;
            self.nationalPhoneNumber = rec.tel;
            self.rating              = rec.rating;
            self.userRatingCount     = rec.reviews;
            self.priceLevel          = rec.price;
            self.businessStatus      = 'OPERATIONAL';
            self.googleMapsURI       = 'https://maps.google.com/?cid=' + rec.id;
            self.primaryTypeDisplayName = rec.cat || 'Restaurant';
            self.utcOffsetMinutes    = -240;
            self.types               = ['restaurant', 'food', 'point_of_interest'];
            self.location            = { lat: function () { return rec.lat || 41.4901; },
                                         lng: function () { return rec.lng || -71.3128; } };
            self.regularOpeningHours = {
              openNow: true,
              weekdayDescriptions: [
                'Monday: 11:00 AM - 10:00 PM', 'Tuesday: 11:00 AM - 10:00 PM',
                'Wednesday: 11:00 AM - 10:00 PM', 'Thursday: 11:00 AM - 11:00 PM',
                'Friday: 11:00 AM - 12:00 AM', 'Saturday: 10:00 AM - 12:00 AM',
                'Sunday: 10:00 AM - 9:00 PM'
              ]
            };
            self.addressComponents   = [
              { types:['locality'],                    longText: rec.city,   shortText: rec.city },
              { types:['administrative_area_level_1'], longText: rec.region, shortText: rec.region },
              { types:['postal_code'],                 longText: rec.postal, shortText: rec.postal },
              { types:['country'],                     longText:'United States', shortText:'US' }
            ];
            res({ place: self });
          }, 260);
        });
      }
    };
  }

  var FAKE_PLACES = {
    AutocompleteSessionToken: function () { this.t = 1; },
    AutocompleteSuggestion: {
      fetchAutocompleteSuggestions: function (req) {
        var q = String(req.input || '').toLowerCase().trim();
        return new Promise(function (res) {
          window.setTimeout(function () {
            var matched = DATA.filter(function (r) {
              var hay = (r.name + ' ' + r.addr).toLowerCase();
              return q.split(/\\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
            });
            /* Any name the visitor types resolves, so the demo behaves like the
               live form instead of looking broken on an unknown restaurant.
               The curated rows above still win when they match. */
            if (matched.length < 3 && q.length > 1) {
              matched = matched.concat(synth(String(req.input).trim(), 4 - matched.length));
            }
            var hits = matched.slice(0, 5).map(function (r) {
              return {
                placePrediction: {
                  placeId       : r.id,
                  text          : r.name + ', ' + r.addr,
                  mainText      : r.name,
                  secondaryText : r.addr,
                  toPlace       : function () { return makePlace(r); }
                }
              };
            });
            res({ suggestions: hits });
          }, 170);
        });
      }
    }
  };

  window.google = window.google || {};
  window.google.maps = window.google.maps || {};
  window.google.maps.importLibrary = function (name) {
    return Promise.resolve(name === 'places' ? FAKE_PLACES : {});
  };
}());
</script>`;
}

/* --------------------------------------------------------------------------- */
console.log('\nBuilt from src/webflow-embed.html (' + source.length + ' readable chars)\n');

let ok = true;
if (global.__usvSplit) {
  const [a, b] = global.__usvSplit;
  ok = a <= EMBED_LIMIT && b <= EMBED_LIMIT;
  console.log('  PASTE THESE TWO into Webflow, part 1 first:\n');
  console.log('  ' + (a <= EMBED_LIMIT ? 'ok  ' : 'OVER') + '  webflow/embed-part1.html'.padEnd(30) +
              String(a).padStart(6) + ' / ' + EMBED_LIMIT);
  console.log('  ' + (b <= EMBED_LIMIT ? 'ok  ' : 'OVER') + '  webflow/embed-part2.html'.padEnd(30) +
              String(b).padStart(6) + ' / ' + EMBED_LIMIT);
} else {
  const spare = EMBED_LIMIT - embed.length;
  console.log('  PASTE THIS into Webflow:\n');
  console.log('  ok    webflow/embed.html'.padEnd(32) + String(embed.length).padStart(6) +
              ' / ' + EMBED_LIMIT + '  (' + spare + ' spare)');
}
console.log('  ok    preview.html'.padEnd(32) + String(preview.length).padStart(6) + ' chars');
console.log('  ok    prototype.html\n');
process.exit(ok ? 0 : 1);
