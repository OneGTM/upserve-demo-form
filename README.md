# Upserve — demo request form (Webflow embed)

Three-step demo request form. It asks who you are before it asks anything
else, finds the restaurant on Google Places, and posts through Default's SDK
so Default branches on submitted data with the conditional logic it already
has.

The first step is the one that matters most: most of the junk on an inbound
demo form is not spam, it is people in the wrong place. Diners chasing a
receipt and existing customers needing support both get answered and sent
somewhere useful, and neither one creates anything in Default.

---

## Files

| File | What it is |
|---|---|
| `src/webflow-embed.html` | **Source of truth.** Markup + CSS + logic, commented. Edit this. |
| `webflow/embed.html` | Generated but **committed**, live key included. **One paste, one Embed element.** |
| `webflow/embed-revenue.html` | The same form plus the annual revenue question. Same deal: one paste. |
| `webflow/embed.names.json` | Generated. Minified class name → source name, for devtools. |
| `preview.html` | Generated. Open locally to test the readable source. |
| `prototype.html` | Generated. Shareable demo with Default and Google stubbed. |
| `build.js` | Regenerates all of the above. `node build.js` |

---

## Install in Webflow

`webflow/embed.html` is committed with the key already in it, so you can copy
it straight out of the repo — no clone, no build, no `config.local.json`. On a
machine that has the repo:

```bash
npm run copy            # webflow/embed.html on your clipboard
npm run copy:revenue    # webflow/embed-revenue.html instead
```

1. Open the demo page in the Designer.
2. Drag an **Embed** element where the form should sit.
3. Paste (the clipboard already holds the variant you copied).
4. Save and publish.

One paste. Nothing in Page Settings, no second embed, no external script.

### Sizing the Embed element

Give the Embed element the **full width of whatever column it sits in** and
leave it at that — no fixed width, no fixed height, no min-height, no padding
tuned to the form. Every constraint the form needs is already in its own CSS:
it centres itself, caps at 780px, shrinks to 280px, and sets its own responsive
padding. Sizing it a second time in the Designer only gives the two a chance to
disagree — and the Designer's copy is invisible to the tests, so a layout bug
introduced there is one nobody can reproduce from the repo.

The one thing that *is* worth setting in Webflow is the vertical space around
the embed, since that belongs to the page, not the form.

> **Paste `webflow/embed.html`, never `src/webflow-embed.html`.** The source is
> ~95,000 characters — mostly comments — and Webflow will reject it at 50,000.
> The build strips all 21,000 characters of comments; they cost nothing in the
> embed, which is why the source stays heavily documented.

`node build.js` prints exactly what to paste and only writes files that are
actually pasteable, so an oversized file can never sit there waiting to be
truncated. If the form ever outgrows the cap it splits into
`embed-part1.html` + `embed-part2.html` and says so.

### Two variants

`build.js` emits both from the same source, and they are byte-identical apart
from one attribute on the form's root element:

| File | Asks annual revenue |
|---|---|
| `webflow/embed.html` | no |
| `webflow/embed-revenue.html` | yes, on the prospect branch only |

There is no second source file and no flag to remember. Everything in
`src/webflow-embed.html` ships to both; the attribute decides whether the
revenue question survives boot. A build where it does not survive removes the
node from the DOM outright rather than hiding it, so a plain embed cannot leak
an `annual_revenue` field to Default even by accident.

To preview the variant off the readable source, add `?rev=1` to `preview.html`.

### Why there's a build step

Webflow caps a Code Embed at
[50,000 characters](https://help.webflow.com/hc/en-us/articles/33961332238611-Custom-code-embed)
and **truncates silently** past it. The readable source is ~95,000, so
`build.js` runs it through terser (compress + mangle), minifies the CSS,
collapses the markup, and shortens the `usv-*` class names. Output is
**46,461** — it fails loudly if an edit ever pushes it over.

Terser is worth ~7,200 characters on its own; without it the build still
works but falls back to comment-and-whitespace stripping and splits into two
embeds. Run `npm install` to get the single-paste build.

Nothing is renamed inside the JavaScript, so the logic is still readable in
devtools. Only the CSS class and ID names are shortened; `embed.names.json`
maps them back. The `name` attributes Default reads (`email`, `phone`,
`restaurant_name`, …), plus every `aria-*` and `data-*` hook, are untouched.

**Always edit `src/webflow-embed.html` and re-run `node build.js`.** Editing
`webflow/embed.html` by hand works but gets overwritten on the next build.

---

## Configure

Everything adjustable lives in the `CFG` block at the top of the script.

### The place lookup — scope and provider

The lookup is scoped to **the restaurant-name field and nothing else**. It only
ever sees what the visitor typed into that one input. It never touches name,
email, phone or status, and it is never a gate: whatever it returns, the form
still submits and Default still ingests every field.

**Why Google and not Yelp or Foursquare.** Both Yelp Fusion and Foursquare
require the API key to live on a server — no CORS, and a browser key would be
public. Either one needs a proxy endpoint before it can be called from a
Webflow embed. Google's JS SDK is the only one that runs client-side, which is
what keeps this a single paste with no backend.

**Yelp and Foursquare belong downstream, not here.** Neither can run in a
browser, and their real value (review velocity, price tier, foot traffic) has no
latency budget at form time. The form already sends `place_id`,
`place_website`, `place_address` and `place_phone` — enough to match into
either one server-side, in Clay or Deepline, after the lead lands.

To swap providers later, replace `fetchSuggestions` and the detail lookup in
`choose()`. Everything downstream reads `S.place` and `S.match`, not
Google-specific shapes, and `place_source` already travels to Default so you
can tell which provider verified a given lead.

### Google Maps key — required for autocomplete

The key lives outside git. Copy the example config and paste it in:

```bash
cp config.example.json config.local.json
# { "GOOGLE_MAPS_API_KEY": "AIza…" }
node build.js
```

`config.local.json` is gitignored and the tracked source keeps a placeholder;
`build.js` injects the key at build time. The built `webflow/embed.html` is
committed with the key in it — safe only because this repo is private — and CI
fails if a key appears in any other tracked file.

In Google Cloud Console:

1. Enable **Places API (New)** and **Maps JavaScript API**.
2. Credentials → Create credentials → API key.
3. Restrict it: **Application restrictions → HTTP referrers**, add the live
   domain and `*.webflow.io/*` so staging works too.
4. **API restrictions → Restrict key** → the two APIs above.

Billing is per autocomplete *session*, not per keystroke. One session covers
every keystroke plus the details lookup, and the code opens a fresh session
token after each pick. At this form's volume that is single-digit dollars a
month.

**If the key is missing, blocked, or Google is down, the form still works.** The
name field degrades to a plain text input, still offers "my restaurant isn't
listed yet", and still submits — `place_verified` just comes through as `false`.
That degradation is tested, not hoped for.

### Default — how it's wired

Default's SDK attaches itself to any `<form>` on the page and builds the
payload by reading the DOM at submit time, keyed on each input's `name`.
**There are no question IDs to map and nothing to keep in sync.** Everything
derived — routing, the resolved place, email class, UTM — is written into
hidden inputs just before the submit propagates.

The form is stamped with `data-default-form-id`, which the SDK treats as
authoritative: it overrides the page-level snippet and skips the
`listenToIds` / `excludeIds` allowlists entirely.

```js
FORM_ID : 579305,
TEAM_ID : 743,
```

> Confirmed: this form posts to **579305**. The page-level snippet on
> `upserve.com/book-a-demo` boots a different id (967265); the stamp is what
> makes this form's target explicit rather than inheriting the page default.

#### The submit gate

Default's listener does **not** call `preventDefault`, so a raw form would
navigate away mid-submit. A capture-phase listener on `document` runs ahead of
Default's and decides what happens:

| Outcome | What it does |
|---|---|
| Always | `preventDefault()` — no native navigation |
| Blocking (validation fails, bot trap trips) | `stopPropagation()` — Default never sees the event, nothing is created |
| Passing | lets the event through — Default reads the form and posts it |

Default's own workflow opens the scheduler. That's what was missing before.

### Routing

```js
ROUTING : {
  brand_new_opening : 'AE',
  replacing_pos     : 'AE',
  exploring         : 'SDR'
}
```

Sent as `routing_owner`, so Default branches on a plain string.

### Other knobs

| Setting | Default | Notes |
|---|---|---|
| `REGIONS` | `['us','ca']` | Places country filter |
| `MIN_SUBMIT_SECONDS` | `3` | Submit-speed floor |
| `MIN_QUERY_CHARS` | `2` | Characters before the first lookup |
| `DEBOUNCE_MS` | `180` | Keystroke debounce |
| `MAX_SUGGESTIONS` | `5` | Rows before "not listed yet" |

---

## The questionnaire

One form, two branches. Step 1 decides which.

| Who they are | Then |
|---|---|
| New or returning | Restaurant finder → **restaurant status** → contact |
| Already a customer | Restaurant finder → **what they need help with** → contact |
| Ate at a restaurant | Answered and stopped. Nothing submitted. |

All fields are required on both branches: first name, last name, email,
mobile phone, restaurant name, and the branch question.

### Annual revenue (revenue variant only)

`webflow/embed-revenue.html` adds one required question between the branch
question and the name fields, and **only on the prospect branch** — an existing
customer asking for support is not being qualified.

| `annual_revenue` | Shown as |
|---|---|
| `under_300k` | Under $300k |
| `300k_1m` | $300k to $1 million |
| `1m_plus` | $1 million+ |

It is a `<select>` rather than a fourth set of radio cards: three more cards
push the last step past a phone screen, and picking a range is a lookup, not a
decision worth that much room. The label carries "Approximate, per location" so
a multi-location operator has an answer instead of a reason to abandon.

Switching to the customer branch after answering clears it, so a range can
never ride along on a submission that never asked for one.

### Routing

| Branch | Answer | `routing_owner` |
|---|---|---|
| Prospect | Brand-new opening | `AE` |
| Prospect | Replacing current POS | `AE` |
| Prospect | Exploring / not sure | `SDR` |
| Customer | Add a new location | `AM` |
| Customer | Expand an existing location | `AM` |
| Customer | Product help | `SUPPORT` |
| Customer | Account or billing | `SUPPORT` |
| Customer | Something else | `SUPPORT` |

The question that was **not** asked never reaches Default — a prospect never
sends `help_topic`, a customer never sends `restaurant_status`. An empty field
reads as missing data; an absent one reads as not applicable.

### The SUPPORT outcome

A support-shaped request is still **captured** — they have handed over their
details and a real customer needs answering — but it is tagged
`routing_owner=SUPPORT` so Default keeps it out of a sales queue, and the
visitor is shown support routes instead of a scheduler that would never open
for them.

If you would rather these never reach Default at all, the change is one branch
in the submit gate.

Support routes come from `CFG.SUPPORT`:

```js
SUPPORT : [
  ['Help Center',  'https://help.upserve.com',  'Guides and troubleshooting'],
  ['Sign in',      'https://upserve.com/login', 'Your account and billing'],
  ['Call support', 'tel:+18556643887',          '(855) 664-3887']
]
```

> **Check these before launch.** A wrong number sends a frustrated customer
> straight back to this form.

### A note on what was removed

The old "what kind of business is it?" dropdown is gone — it is not in the
agreed field list. It had been doing double duty as an accidental-submission
filter, since a required dropdown with no "Other" is the one field autofill
cannot guess. That role is now covered by the triage step and the branch
question, which are both required and both demand a real decision. The
qualification signal it carried (full-service vs quick-service vs bar) is the
real loss; `place_category` from Google partly replaces it.

## What gets sent to Default

Default ingests **everything** — all form input plus everything the lookup
resolved. Empty fields are dropped, so it never sees blank strings.

**Contact** — `first_name`, `last_name`, `email`, `phone` (normalised to E.164
in the field itself), `restaurant_name` (the Google display name when one was
picked, otherwise what they typed).

**Qualification** — `visitor_type` (`prospect` / `current_customer`), plus
either `restaurant_status` or `help_topic` depending on the branch, and
`routing_owner`. The revenue build adds `annual_revenue` on the prospect
branch.

A diner never submits.

**Place (only when someone picks a Google result)** — `place_id`,
`place_verified`, `place_source`, `place_maps_url`, `place_address`,
`place_city`, `place_region`, `place_postal_code`, `place_country`,
`place_lat`, `place_lng`, `place_timezone_offset`, `place_website`,
`place_phone`, `place_category`, `place_types`, `place_hours`,
`place_open_now`, `place_rating`, `place_review_count`,
`place_price_level`, `place_business_status`, `place_closed`.

`place_source` is `google`, `manual`, or `not_listed`, so Default can tell a
verified match from a hand-typed name without parsing anything.

### Registering the fields in Default

Default learns its schema **from what a submission contains**. A field that is
not in a submission never appears in the mapping UI, so every field is sent on
every submission — blank when unknown — rather than omitted when empty.

The one exception is the branch question: a prospect never sends `help_topic`
and a customer never sends `restaurant_status`, because there a blank would
misread as "answered with nothing" instead of "not applicable".

That means **two discovery submissions** register the complete schema:

```
upserve.com/book-a-demo?updateDefaultFields=true
```

1. Run it once as **new/returning** → registers everything + `restaurant_status`
2. Run it once as **already a customer** → adds `help_topic`

Then map them in Default → Webform Fields → Save mappings.

### Field labels in Default

Default derives each field's name from the DOM. For a hidden input the only
thing it can read is `aria-label` — without one it falls back to the raw name
and the Webform Fields list shows `place_postal_code` instead of
"Restaurant ZIP".

Every field therefore carries an explicit label, all of them in one place:

```js
FIELDS : {
  place_postal_code : 'Restaurant ZIP',
  place_hours       : 'Opening hours',
  routing_owner     : 'Routing owner (AE or SDR)',
  ...
}
```

Edit the right-hand side freely — it only changes what Default displays. The
left side is the wire name and should stay stable once Default has mapped it.

### Adding more Places fields

The details call requests a fixed list in `choose()`. Adding a field there plus
a matching `FIELDS` label is all it takes.

One caveat: service-model fields (dine-in, delivery, serves-alcohol, editorial
summary) sit in Places' higher-priced *Enterprise + Atmosphere* tier, unlike
everything currently requested, which all rides in the tier the rating and
website fields already put us in.

## The anti-spam layer

Three things, no CAPTCHA, nothing for a mobile user to squint at.

**Honeypot.** A field positioned off-screen that no human ever sees or tabs
into. Bots fill it because it's in the DOM.

**Submit-speed floor.** Nobody reads two steps and types four fields in under
three seconds.

**The type dropdown.** Meta pre-fills text inputs, so accidental submitters sail
straight through anything you can type into. A required dropdown with no
"Other" is the one field that demands a real decision — and it's where
non-restaurants exit on their own.

The trap fields lose their `name` attributes just before a real submission
propagates, so Default never receives two junk questions on every good lead.

When a trap trips, the visitor gets the same polite thank-you a human gets and
**nothing is created anywhere**. Default is never called. Verified: the speed
floor and the honeypot both complete the flow with zero calls to
`DefaultSDK.submit`.

---

## Email and phone validation

Both are checked **on blur** — at the field, while the visitor is still looking
at it — and again at submit.

**Email** must be `something@something.tld` with a real 2+ letter TLD.

```
reject   joe@gmail   joe@gmail.c   joe@.com   joe@gmail..com   joe@@x.com
accept   jamie@tautog.com   joe+tag@gmail.com   chef@my-diner.co.uk
```

**Phone** is structural NANP: ten digits, area code and exchange may not start
with 0 or 1, all-same-digit numbers are out. A leading `+` switches to
international mode (8–15 digits).

```
reject   1018492900   4010492900   0000000000   401849290   911
accept   (401) 849-2900   +44 20 7946 0958
```

### Format only, on purpose

This validates **shape**, not **deliverability**. `joe@totallyfake12345.xyz` is
correctly formatted and passes; nothing client-side can tell you the domain has
no mail server. Same for phone — well-formed is not the same as active, and not
the same as a mobile.

That is a deliberate call, not a gap. Live verification needs a server-side
lookup, which means a backend, an API bill and latency on a form that currently
has none of the three. The typo rescue already catches the failure that actually
happens: a misspelt common domain.

## Email typo rescue

`gmial.com.com` → *Did you mean alex@gmail.com?* with a one-click fix.

Catches doubled TLDs, a table of known misspellings, near-misses on common
consumer domains, and bad TLDs on otherwise-fine domains (`.con` → `.com`).

It suggests. It never blocks. If a visitor dismisses it, the address goes
through exactly as typed.

**Free inboxes are welcome.** Requiring a business email would have blocked Just
Wing It (yahoo, $5.3M group, at closing) and Tautog Tavern (gmail, existing
customer, real $720K business). The domain rides along as `email_type` for
scoring and never gates anyone.

---

## Demo mode

The trigger chips live on `prototype.html`, on the page around the form —
never inside the form card. **`build.js` strips the entire demo block out of
`webflow/embed.html`**, so no chip markup, no `?demo=1` switch and no debug
logging can reach the live site.

- **Bot fill** — fills the honeypot and submits. The thank-you appears; Default is never called.
- **Fast submit** — resets the clock and submits under the speed floor.
- **Typo email** — loads `alex@gmial.com.com` so the rescue fires.
- **Reset** — reload.

---

## Testing

```bash
npm install
npx playwright install chromium
npm test          # builds, then runs 74 checks on desktop + mobile
```

The suite drives the **built** `webflow/embed.html` — the exact file you paste
— in a real browser, through user-facing selectors only (`name` attributes,
roles, visible text). It never reaches into internals, so the class-name
minifier can rename whatever it likes and the tests still pass.

Default and Google are stubbed, so a run never touches a live service. The two
assertions that matter most:

- a trap firing results in **zero** submissions reaching Default
- every field Default receives arrives under a **readable label**, never a slug

It also honours the real 3-second submit floor rather than lowering it for
tests — which is why each test takes ~3.5s, and why they run in parallel.

CI runs the same suite plus the size and secret guards on every push and PR.

### Manual preview

```bash
node build.js
python3 -m http.server 8811
# http://localhost:8811/preview.html?demo=1
```

`preview.html` runs the readable source, so devtools shows real names.
`prototype.html` is the shareable version with Default and Google stubbed.

Hard-reload after a rebuild — `python3 -m http.server` sends caching headers and
Chrome will happily serve you the old file.

The built `webflow/embed.html` has been driven end to end in a browser using
only user-facing selectors: autocomplete, place pick, both step validations,
typo rescue, phone formatting, the honeypot, and a full submit. The captured
payload passes Default's validation rules (every response key has a matching
question, the email-typed question carries a value).

---

## Funnel tracking

Events push to GTM's `dataLayer`, so drop-off is measurable at every step —
including how many arrivals were never leads in the first place:

| Event | Fires when |
|---|---|
| `usv_form_step0_view` | form renders |
| `usv_form_visitor_type` | who they said they are |
| `usv_form_deflected` | a diner was answered and stopped |
| `usv_form_place_selected` | a Google result or "not listed yet" is picked |
| `usv_form_step2_view` | step 2 reached — the drop-off denominator |
| `usv_form_submit` | a real submission goes to Default |
| `usv_form_blocked` | a trap fired (spam volume, without polluting Default) |

`submit` carries `place_source`, `place_verified` and `routing_owner`.

The whole thing is wrapped in try/catch and creates `dataLayer` if GTM has not
yet — **analytics can never break a submission**. A test proves it by rigging
`dataLayer` to throw on access and asserting the submission still lands.

## Brand

Audited against `BrandGuideUpserve` and `MiniFontStyleGuide`.

**Type.** Fraunces for headlines at **Regular (400)** — the guide's core headline
weight, and it warns that leaning on heavier cuts makes the brand read less
elevated. Emphasis comes from Fraunces *Italic* on the accent word ("Let's find
*your* restaurant"), never from bolding. Lato Regular for body, Lato Bold only
for UI labels and the button, which is the guide's "Secondary" tier.

Only the weights actually used are requested from Google Fonts: Fraunces
400/600 + italics, Lato 400/700 + italic. Fraunces 700 and Lato 900 were being
downloaded and never used.

**Colour.** `#ffcd04` on the CTA and the accent rule, `#f5e1a4` on dropdown
hover, `#000000` for text and borders. Supporting greys are straight tints of
the brand black (`#474747`, `#737373`) rather than off-palette hues.

---

## Known limits

- **Places types.** Google caps the type filter at five. Tier one asks for
  `restaurant, bar, cafe, bakery, meal_takeaway`; if that returns fewer than
  three matches, tier two re-queries against `establishment` and merges, so food
  halls, hotel F&B and breweries still resolve.
- **Mobile viewport.** The layout stacks below 480px, inputs are 16px so iOS
  doesn't zoom on focus, and tap targets measure ~51px. Verified via computed
  styles and the grid rule; worth one pass on a real handset before launch.
- **Size.** 46,461 of 50,000 — about 3,500 spare. Past that the build splits
  into two embeds automatically rather than truncating. This is the binding constraint now: a large new section will need
  something trimmed first. `build.js` fails loudly rather than letting Webflow
  truncate silently. A large new section may need something trimmed; `build.js` will
  tell you rather than letting Webflow truncate silently.
- **Minified class names.** Styling the form from Webflow's own CSS would need
  the shortened names in `embed.names.json`, which change between builds. Add
  styles to `src/webflow-embed.html` instead.
