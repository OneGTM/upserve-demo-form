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
    var fields = {}, labels = {}, optionLabels = {}, i, el, fs_, lab;
    for (i = 0; i < f.elements.length; i++) {
      el = f.elements[i];
      if (!el.name || el.type === 'password') continue;
      if (el.type === 'radio') {
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
      fields: fields, labels: labels, optionLabels: optionLabels
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
  window.google.maps.importLibrary = function (n) {
    return Promise.resolve(n === 'places' ? PLACES : {});
  };
}());
</script>`;

/** The page under test: real embed + stubs. */
function page() {
  const embedPath = path.join(ROOT, 'webflow', 'embed.html');
  if (!fs.existsSync(embedPath)) {
    throw new Error('webflow/embed.html is missing — run `node build.js` first');
  }
  // Neutralise whatever key the local build injected; tests never call Google.
  const embed = fs
    .readFileSync(embedPath, 'utf8')
    .replace(/GOOGLE_MAPS_API_KEY\s*:\s*'[^']*'/, "GOOGLE_MAPS_API_KEY:'TEST'");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>form under test</title></head><body>
${STUB}
${embed}
</body></html>`;
}

module.exports = { page };
