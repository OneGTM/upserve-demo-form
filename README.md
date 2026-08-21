# Upserve — demo request form (Webflow embed)

Two-step demo request form. Google Places finds the restaurant, a required
business-type dropdown does the work a CAPTCHA would, and Default's SDK reads
the finished form straight off the DOM — so Default branches on submitted data
using the conditional logic it already has.

Default never receives a webhook and never waits on anything mid-workflow. Every
signal — including the verified flag and the Google place ID — arrives as a plain
form field.

---

## Files

| File | What it is |
|---|---|
| `src/webflow-embed.html` | **Source of truth.** Markup + CSS + logic, commented. Edit this. |
| `webflow/embed.html` | Generated. **One paste, one Embed element.** |
| `webflow/embed.names.json` | Generated. Minified class name → source name, for devtools. |
| `preview.html` | Generated. Open locally to test the readable source. |
| `prototype.html` | Generated. Shareable demo with Default and Google stubbed. |
| `build.js` | Regenerates all of the above. `node build.js` |

---

## Install in Webflow

1. Open the demo-contact page in the Designer.
2. Drag an **Embed** element where the form should sit.
3. Paste all of `webflow/embed.html`.
4. Save and publish.

That's it. Nothing in Page Settings, no second embed, no external script.

### Why there's a build step

Webflow caps a Code Embed at
[50,000 characters](https://help.webflow.com/hc/en-us/articles/33961332238611-Custom-code-embed).
The readable source is ~87,100 so `build.js` strips comments, collapses
whitespace, and shortens the `usv-*` class names. Output is **49,099** — it
fails loudly if an edit ever pushes it over.

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

`config.local.json` is gitignored, the tracked source keeps a placeholder, and
CI fails if a key ever appears in a tracked file. `build.js` injects it at
build time.

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

## What gets sent to Default

Default ingests **everything** — all form input plus everything the lookup
resolved. Empty fields are dropped, so it never sees blank strings.

**Contact** — `first_name`, `last_name`, `email`, `phone` (normalised to E.164
in the field itself), `restaurant_name` (the Google display name when one was
picked, otherwise what they typed).

**Qualification** — `business_type`, `restaurant_status`, `routing_owner`.

**Place (only when someone picks a Google result)** — `place_id`,
`place_verified`, `place_source`, `place_maps_url`, `place_address`,
`place_city`, `place_region`, `place_postal_code`, `place_country`,
`place_lat`, `place_lng`, `place_timezone_offset`, `place_website`,
`place_phone`, `place_category`, `place_types`, `place_hours`,
`place_open_now`, `place_rating`, `place_review_count`,
`place_price_level`, `place_business_status`, `place_closed`.

`place_source` is `google`, `manual`, or `not_listed`, so Default can tell a
verified match from a hand-typed name without parsing anything.

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

### Atmosphere fields (off by default)

`CFG.PLACE_ATMOSPHERE = true` adds dine-in, takeout, delivery, reservations,
whether they serve beer/wine/cocktails, meal periods, and Google's editorial
blurb. Useful for qualifying a restaurant, but these are Places
"Enterprise + Atmosphere" fields and bill at a higher rate than everything
else. Add matching `FIELDS` labels for any you turn on.

**Scoring signals** — none of these gate anyone; they all just travel with the
lead.

| Field | Values | What it means |
|---|---|---|
| `email_type` | `business` / `free` / `disposable` | Free inboxes are welcome — the label is for scoring, not filtering. |
| `email_domain_match` | `match` / `personal` / `different` / `unknown` | Email domain vs the restaurant's own website from Google. `match` is the strongest "this person really works here" signal available at form time. **`personal` is its own answer, not a miss** — plenty of real operators run the place from a gmail address. |
| `phone_vs_place` | `exact` / `same_area` / `different` / `unknown` | The number they gave vs the number Google lists for the place. `exact` means they handed over the restaurant's own line. Mobile numbers travel with people, so `different` means nothing on its own. |
| `place_closed` | `permanently` / `temporarily` / omitted | Google says the listing is shut. Usually a stale pick — sometimes a new operator taking over the space, which is a *good* lead. A permanently closed match pre-selects "brand-new opening" instead of "replacing POS". |
| `email_domain` | the domain itself | For your own scoring rules. |

**Attribution** — `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
`utm_content`, `gclid`, `landing_page`, `referrer`. First touch is persisted in
`localStorage` on the visitor's first landing, so a lead who arrives from an ad
and converts three days later still carries the campaign.

The Default SDK also attaches its own UTM, gclid, referrer and submission URL
independently. Sending them as explicit fields on top of that is what lets
Default branch on them in conditional logic.

---

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
npm test          # builds, then runs 34 checks on desktop + mobile
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

Six events push to GTM's `dataLayer`, so the two-step drop-off is measurable:

| Event | Fires when |
|---|---|
| `usv_form_step1_view` | form renders |
| `usv_form_place_selected` | a Google result or "not listed yet" is picked |
| `usv_form_step2_view` | step 2 reached — the drop-off denominator |
| `usv_form_submit` | a real submission goes to Default |
| `usv_form_blocked` | a trap fired (spam volume, without polluting Default) |

`submit` carries `place_source`, `place_verified`, `routing_owner` and
`business_type`.

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
- **Size headroom.** The embed builds to 49,099 of 50,000 characters — about
  900 spare. This is the binding constraint: anything substantial now needs
  something traded out first. `build.js` and CI both fail rather than letting
  Webflow truncate silently. This is the binding constraint now: a large new section will need
  something trimmed first. `build.js` fails loudly rather than letting Webflow
  truncate silently. A large new section may need something trimmed; `build.js` will
  tell you rather than letting Webflow truncate silently.
- **Minified class names.** Styling the form from Webflow's own CSS would need
  the shortened names in `embed.names.json`, which change between builds. Add
  styles to `src/webflow-embed.html` instead.
