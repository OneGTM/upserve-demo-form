/**
 * Builds the page the tests drive.
 *
 * It runs the REAL built embed — webflow/embed.html, the exact file that gets
 * pasted into Webflow — with two things stubbed so a test run never reaches a
 * live service:
 *
 *   Default  captured in window.__submissions instead of posted
 *   Google   a small fixed set of restaurants, so results are deterministic
 *
 * Everything else is production code: the same validation, the same traps, the
 * same gate, the same hidden-field construction.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const STUB = `<script>
(function () {
  'use strict';
  window.__submissions = [];
  window.__events = [];
  var CB = {};

  window.__default__ = window.__default__ || {};
  window.__default__.registerSubmissionCallbacks = function (c) { CB = c || {}; };
  window.__default__.reportSchedulerNotBooked = function () { return false; };
  window.__default__.displayLoadingModal = function () {};
  window.__default__loaded = true;          // stop the real SDK loading

  // Default's own listener: bubble phase on the form, reads the DOM at submit.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.hasAttribute || !f.hasAttribute('data-default-form-id')) return;
    var fields = {}, labels = {}, optionLabels = {}, optionsByName = {}, i, el, fs_, lab;
    for (i = 0; i < f.elements.length; i++) {
      el = f.elements[i];
      if (!el.name || el.type === 'password') continue;
      // Default reads a select's options the same way it reads a radio group
      if (el.tagName === 'SELECT') {
        optionsByName[el.name] = [];
        for (var oi = 0; oi < el.options.length; oi++) {
          optionsByName[el.name].push(el.options[oi].value);
        }
      }
      if (el.type === 'radio') {
        (optionsByName[el.name] = optionsByName[el.name] || []).push(el.value);
        optionLabels[el.value] =
          ((el.labels && el.labels[0] && el.labels[0].textContent) || '')
            .replace(/\\s+/g, ' ').trim();
      }
      if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) continue;
      fs_ = el.closest('fieldset');
      lab = (el.type === 'radio'
              ? (fs_ && fs_.querySelector('legend') && fs_.querySelector('legend').textContent.trim())
              : (el.labels && el.labels[0] && el.labels[0].textContent.trim()))
         || el.getAttribute('aria-label') || el.placeholder || el.name;
      fields[el.name] = el.value;
      labels[el.name] = lab.replace(/\\s+/g, ' ').trim();
    }
    window.__submissions.push({
      form_id: f.getAttribute('data-default-form-id'),
      fields: fields, labels: labels, optionLabels: optionLabels, optionsByName: optionsByName
    });
    setTimeout(function () { CB.onSuccess && CB.onSuccess({ success: true }); }, 20);
  });

  // dataLayer capture
  window.dataLayer = window.dataLayer || [];
  var push = window.dataLayer.push.bind(window.dataLayer);
  window.dataLayer.push = function (o) { window.__events.push(o); return push(o); };

  var DATA = [
    { id:'p_tautog', name:'Tautog Tavern', addr:'20 Bowens Wharf, Newport, RI 02840',
      city:'Newport', region:'RI', postal:'02840', site:'https://tautogtavern.com',
      tel:'(401) 849-2900', rating:4.3, reviews:1290, price:'MODERATE', status:'OPERATIONAL' },
    { id:'p_justwingit', name:'Just Wing It', addr:'318 Thames St, Newport, RI 02840',
      city:'Newport', region:'RI', postal:'02840', site:'', tel:'(401) 555-0184',
      rating:4.6, reviews:642, price:'INEXPENSIVE', status:'OPERATIONAL' },
    { id:'p_closed', name:'Old Anchor Grill', addr:'12 Dock St, Newport, RI 02840',
      city:'Newport', region:'RI', postal:'02840', site:'', tel:'(401) 555-0111',
      rating:3.9, reviews:210, price:'MODERATE', status:'CLOSED_PERMANENTLY' }
  ];

  function makePlace(rec) {
    return {
      id: rec.id,
      fetchFields: function () {
        var self = this;
        return new Promise(function (res) {
          setTimeout(function () {
            self.displayName = rec.name;
            self.formattedAddress = rec.addr;
            self.websiteURI = rec.site;
            self.nationalPhoneNumber = rec.tel;
            self.rating = rec.rating;
            self.userRatingCount = rec.reviews;
            self.priceLevel = rec.price;
            self.businessStatus = rec.status;
            self.googleMapsURI = 'https://maps.google.com/?cid=' + rec.id;
            self.primaryTypeDisplayName = 'Seafood restaurant';
            self.primaryType = 'seafood_restaurant';
            self.types = ['seafood_restaurant', 'restaurant', 'food', 'establishment'];
            self.isPureServiceAreaBusiness = false;
            self.internationalPhoneNumber = '+1 401-849-2900';
            self.priceRange = { startPrice:{units:20,currencyCode:'USD'},
                                endPrice:{units:40,currencyCode:'USD'} };
            self.utcOffsetMinutes = -240;
            self.location = { lat: function () { return 41.4901; },
                              lng: function () { return -71.3128; } };
            self.regularOpeningHours = {
              weekdayDescriptions: ['Monday: 11:00 AM - 10:00 PM', 'Tuesday: 11:00 AM - 10:00 PM',
                'Wednesday: 11:00 AM - 10:00 PM', 'Thursday: 11:00 AM - 11:00 PM',
                'Friday: 11:00 AM - 12:00 AM', 'Saturday: 10:00 AM - 12:00 AM',
                'Sunday: 10:00 AM - 9:00 PM']
            };
            self.addressComponents = [
              { types:['locality'], longText:rec.city, shortText:rec.city },
              { types:['administrative_area_level_1'], longText:rec.region, shortText:rec.region },
              { types:['postal_code'], longText:rec.postal, shortText:rec.postal },
              { types:['country'], longText:'United States', shortText:'US' }
            ];
            res({ place: self });
          }, 10);
        });
      }
    };
  }

  var PLACES = {
    AutocompleteSessionToken: function () { this.t = 1; },
    AutocompleteSuggestion: {
      fetchAutocompleteSuggestions: function (req) {
        var q = String(req.input || '').toLowerCase().trim();
        return new Promise(function (res) {
          setTimeout(function () {
            res({ suggestions: DATA.filter(function (r) {
              return (r.name + ' ' + r.addr).toLowerCase().indexOf(q) >= 0;
            }).map(function (r) {
              return { placePrediction: {
                placeId: r.id, text: r.name + ', ' + r.addr,
                mainText: r.name, secondaryText: r.addr,
                toPlace: function () { return makePlace(r); }
              } };
            }) });
          }, 10);
        });
      }
    }
  };

  window.google = window.google || {};
  window.google.maps = window.google.maps || {};
  window.__placesLoads = 0;      // so a test can prove it is not fetched early
  window.google.maps.importLibrary = function (n) {
    if (n === 'places') window.__placesLoads++;
    return Promise.resolve(n === 'places' ? PLACES : {});
  };
}());
</script>`;

/**
 * The page under test: real embed + stubs.
 *
 * One embed goes on every page; the PAGE decides whether it also asks for
 * annual revenue. `opts` builds a host page that says yes the way a real one
 * would, so the tests exercise the switch a marketer actually touches:
 *
 *   { revenue: 'attribute' }  a wrapper carrying data-upserve-revenue="1"
 *   { revenue: 'global' }     window.USV_ASK_REVENUE set in the head
 *   { revenue: '<value>' }    that literal value on the wrapper, to check
 *                             that "0" and "false" read as a no
 *   { paths: ['/x'] }         seed CFG.REVENUE_PATHS, for the path route
 *   { leadSource: 'paid' }    a wrapper carrying data-upserve-lead-source
 */
function page(opts = {}) {
  // The build emits ONE of two shapes: a single embed.html when it fits under
  // Webflow's cap, or two parts when it doesn't. Test whichever exists — that
  // is what actually gets pasted.
  const embedPath = path.join(ROOT, 'webflow', 'embed.html');
  const p1 = path.join(ROOT, 'webflow', 'embed-part1.html');
  const p2 = path.join(ROOT, 'webflow', 'embed-part2.html');
  const split = fs.existsSync(p1) && fs.existsSync(p2);

  if (!split && !fs.existsSync(embedPath)) {
    throw new Error('No build output in webflow/ — run `node build.js` first');
  }
  // Neutralise whatever key the local build injected; tests never call Google.
  const raw = split
    ? fs.readFileSync(p1, 'utf8') + '\n' + fs.readFileSync(p2, 'utf8')
    : fs.readFileSync(embedPath, 'utf8');
  let embed = raw
    .replace(/GOOGLE_MAPS_API_KEY\s*:\s*'[^']*'/, "GOOGLE_MAPS_API_KEY:'TEST'");

  // The shipped list is empty. Seeding it here keeps the path route testable
  // without committing a path the live site does not have.
  if (opts.paths) {
    const before = embed;
    embed = embed.replace('REVENUE_PATHS:[]',
                          'REVENUE_PATHS:' + JSON.stringify(opts.paths));
    if (embed === before) throw new Error('REVENUE_PATHS is not in the built embed');
  }

  const rev = opts.revenue;
  const globalFlag = rev === 'global'
    ? '<script>window.USV_ASK_REVENUE = true;</script>' : '';
  // 'attribute' is the shorthand for the value a page would actually carry.
  let attr = rev && rev !== 'global'
    ? ' data-upserve-revenue="' + (rev === 'attribute' ? '1' : rev) + '"' : '';
  if (opts.leadSource != null) attr += ' data-upserve-lead-source="' + opts.leadSource + '"';
  const open = attr ? '<div' + attr + '>' : '';
  const close = attr ? '</div>' : '';

  // The host page sets this, and mobile emulation depends on it: without it the
  // layout viewport falls back to 980px, so a phone-sized run silently measures
  // the desktop layout. upserve.com sets exactly this.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>form under test</title>
${globalFlag}</head><body>
${STUB}
${open}${embed}${close}
</body></html>`;
}

/**
 * The same embed, wrapped in the container chain upserve.com actually puts it
 * in — measured off the live page.
 *
 * The detail that matters is `.code-embed{display:flex}`: Webflow's Embed
 * wrapper is a flex container, which makes the form root a flex ITEM. A flex
 * item's min-width:auto floors it at its own min-content width, and that floor
 * beats max-width. Dropping the embed straight into <body> — which is what
 * page() does — never exercises this, so the whole class of bug is invisible
 * to every test that uses it.
 */
function pageInWebflowColumn(opts = {}) {
  const inner = page(opts);
  const body = inner.slice(inner.indexOf('<body>') + 6, inner.lastIndexOf('</body>'));
  // page() puts the `revenue: 'global'` route in the HEAD. This wrapper builds
  // its own head, so carry that script across — dropping it turned a supported
  // option into a page with the question quietly switched off.
  const head = inner.slice(inner.indexOf('</title>') + 8, inner.indexOf('</head>'));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>form in a Webflow column</title>
${head}
<style>
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0}
  .container-79 {display:flex;max-width:1440px;margin:0 auto;padding:0 15px}
  .container-104{display:flex;max-width:380px;margin:0 auto;padding:0 5px}
  .div-block-102{max-width:360px}
  .code-embed  {display:flex}
</style></head><body>
<section><div class="container-79"><div class="container-104"><div class="div-block-102">
<div class="code-embed">${body}</div>
</div></div></section>
</body></html>`;
}

module.exports = { page, pageInWebflowColumn };
