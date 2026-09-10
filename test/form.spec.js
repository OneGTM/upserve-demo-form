/**
 * Drives the built embed in a real browser, through user-facing selectors only
 * — `name` attributes, roles and visible text. Nothing here reaches into the
 * form's internals, so the class-name minifier can rename whatever it likes and
 * these still pass.
 *
 * The two assertions that matter most:
 *   - a trap firing must result in ZERO submissions reaching Default
 *   - every field Default receives must arrive under a human-readable label
 */
'use strict';

const { test, expect } = require('@playwright/test');
const { page: buildPage, pageInWebflowColumn } = require('./harness');

const HTML = buildPage();
/* The same embed on a page that asks for annual revenue, the way a real one
   would: a wrapper around the Embed element carrying the attribute. */
const HTML_REV = buildPage({ revenue: 'attribute' });

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** When each page was rendered, so we can respect the real speed floor. */
const openedAt = new WeakMap();

/** Click the Continue that is actually on screen — step 0 and step 1 both have one. */
async function clickContinue(page) {
  await page.locator('button:visible').filter({ hasText: /continue/i }).first().click();
}

/** Open the form and clear the triage step as a prospect. */
async function open(page, visitor = 'prospect', html = HTML) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('[role="combobox"]'));
  openedAt.set(page, Date.now());
  await page.waitForTimeout(150);
  if (visitor) {
    await page.locator('input[value="' + visitor + '"]').check({ force: true });
    await clickContinue(page);
  }
}

/**
 * Click submit, having waited out the production submit-speed floor.
 *
 * The tests fill the form far faster than a person can, which is exactly what
 * the floor exists to catch — so without this every test trips the bot trap.
 * We wait rather than lowering CFG.MIN_SUBMIT_SECONDS, so the suite exercises
 * the same threshold that ships. Tests run in parallel, so the wait overlaps.
 */
const FLOOR_MS = 3000;
async function submit(page) {
  const elapsed = Date.now() - (openedAt.get(page) || 0);
  if (elapsed < FLOOR_MS + 200) await page.waitForTimeout(FLOOR_MS + 200 - elapsed);
  // the label names the destination: demo, account team, or support
  await page.getByRole('button',
    { name: /book my demo|connect with the account team|send to support/i }).click();
}

/** Type into the finder and pick the first real result. */
async function pickRestaurant(page, query) {
  const input = page.locator('[role="combobox"]');
  await input.click();
  await input.fill(query);
  const option = page.locator('[role="option"]').first();
  await option.waitFor({ state: 'visible', timeout: 4000 });
  const label = (await option.innerText()).split('\n')[0];
  await option.click();
  await page.waitForTimeout(120);
  return label;
}

async function continueToStep2(page) {
  await clickContinue(page);
  await expect(page.locator('input[name="first_name"]')).toBeVisible();
  // The step focuses its first empty field ~40ms after arriving. Left to race,
  // that steals focus midway through a test's own fill/blur and the blur
  // handler never runs - the source of every intermittent failure so far.
  await page.waitForTimeout(120);
}

async function fillContact(page, { first = 'Jamie', last = 'Okafor',
                                   email = 'jamie@tautogtavern.com',
                                   phone = '4018492900' } = {}) {
  await page.fill('input[name="first_name"]', first);
  await page.fill('input[name="last_name"]', last);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="phone"]', phone);
}

const submissions = (page) => page.evaluate(() => window.__submissions);
const events = (page) =>
  page.evaluate(() => window.__events.map((e) => e.event).filter(Boolean));

/* ── the finder ──────────────────────────────────────────────────────────── */

test('picking a Google result carries the place through to Default', async ({ page }) => {
  await open(page);
  const picked = await pickRestaurant(page, 'Tautog');
  expect(picked).toBe('Tautog Tavern');

  await continueToStep2(page);
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields, form_id } = (await submissions(page))[0];

  expect(form_id).toBe('579305');
  expect(fields.place_verified).toBe('true');
  expect(fields.place_source).toBe('google');
  expect(fields.restaurant_name).toBe('Tautog Tavern');
  expect(fields.place_city).toBe('Newport');
  expect(fields.place_region).toBe('RI');
  expect(fields.place_postal_code).toBe('02840');
  expect(fields.place_hours).toContain('Monday');
  expect(fields.phone).toBe('+14018492900');
});

test('"not listed yet" routes to a brand-new opening', async ({ page }) => {
  await open(page);
  const input = page.locator('[role="combobox"]');
  await input.click();
  await input.fill('Somewhere Brand New');
  const notListed = page.getByRole('option', { name: /isn.t listed yet/i });
  await notListed.waitFor({ state: 'visible' });
  await notListed.click();

  await expect(page.locator('input[value="brand_new_opening"]')).toBeChecked();

  await continueToStep2(page);
  await fillContact(page, { email: 'chef@brandnew.com' });
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields } = (await submissions(page))[0];
  expect(fields.place_source).toBe('not_listed');
  expect(fields.place_verified).toBe('false');
  expect(fields.routing_owner).toBe('AE');
});

test('a permanently closed listing is treated as a new opening, not a POS swap',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Old Anchor');
    await expect(page.locator('input[value="brand_new_opening"]')).toBeChecked();

    await continueToStep2(page);
    await fillContact(page, { email: 'new@owner.com' });
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { fields } = (await submissions(page))[0];
    expect(fields.place_closed).toBe('permanently');
    expect(fields.routing_owner).toBe('AE');
  });

/* ── routing ─────────────────────────────────────────────────────────────── */

test('"just exploring" routes to SDR, everything else to AE', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await page.locator('[data-status="exploring"]').click();
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  expect((await submissions(page))[0].fields.routing_owner).toBe('SDR');
});

/* ── the traps: nothing may reach Default ────────────────────────────────── */

test('honeypot blocks the submission and Default is never called', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await fillContact(page);

  // only a bot fills a field positioned off-screen
  await page.evaluate(() => {
    const hp = document.querySelector('input[name="company_website_confirm"]');
    hp.value = 'http://spam.example';
  });
  await submit(page);   // honeypot must block even after a human-plausible delay

  await expect(page.getByText(/in touch shortly/i)).toBeVisible();
  expect(await submissions(page)).toHaveLength(0);
  expect(await events(page)).toContain('usv_form_blocked');
});

test('submitting under the speed floor blocks, and Default is never called',
  async ({ page }) => {
    // A frozen clock makes this deterministic. Racing real time is flaky: on a
    // slow run the setup alone takes longer than the floor, and the trap
    // correctly does not fire. Here the form only ever sees ~1.2s elapse,
    // however long the machine actually takes.
    // install() alone installs controllable timers but leaves Date.now()
    // tracking real time — pauseAt() is what actually freezes it.
    const T0 = new Date("2026-01-01T12:00:00Z");
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0);
    await page.setContent(HTML, { waitUntil: 'load' });
    await page.waitForFunction(() => !!document.querySelector('[role="combobox"]'));
    await page.clock.runFor(200);

    await page.locator('input[value="prospect"]').check({ force: true });
    await clickContinue(page);
    await page.clock.runFor(100);

    const input = page.locator('[role="combobox"]');
    await input.click();
    await input.fill('Tautog');
    await page.clock.runFor(400);                 // debounce + stubbed lookup
    await page.locator('[role="option"]').first().click();
    await page.clock.runFor(200);                 // place details

    await clickContinue(page);
    await fillContact(page);
    await page.clock.runFor(400);

    // ~1.2s of form-visible time: well inside the 3s floor
    await page.getByRole('button', { name: /book my demo/i }).click();
    await page.clock.runFor(500);

    await expect(page.getByText(/in touch shortly/i)).toBeVisible();
    expect(await submissions(page)).toHaveLength(0);
    expect(await events(page)).toContain('usv_form_blocked');
  });

/* ── email ───────────────────────────────────────────────────────────────── */

test('a malformed address is flagged on blur, before submit', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await page.fill('input[name="email"]', 'joe@gmail');   // no TLD
  await page.locator('input[name="email"]').blur();
  await expect(page.getByText(/missing something/i)).toBeVisible();
});

test('a typo is offered a fix, and the submit button is not swallowed',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await fillContact(page, { email: 'jamie@gmial.com.com' });
    await page.locator('input[name="email"]').blur();

    await expect(page.getByRole('button', { name: /use it/i })).toBeVisible();
    await page.getByRole('button', { name: /use it/i }).click();
    await expect(page.locator('input[name="email"]')).toHaveValue('jamie@gmail.com');

    // one click, one submission — the hint must not eat it
    await submit(page);
    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  });

test('a free inbox is welcomed and labelled, never blocked', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Just Wing It');
  await continueToStep2(page);
  await fillContact(page, { email: 'marcus@yahoo.com', phone: '9175551234' });
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields } = (await submissions(page))[0];
  expect(fields.email_type).toBe('free');
  expect(fields.email_domain_match).toBe('personal');   // its own answer, not a miss
});

test('an email on the restaurant domain is the strongest match', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await fillContact(page, { email: 'jamie@tautogtavern.com', phone: '4018492900' });
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields } = (await submissions(page))[0];
  expect(fields.email_domain_match).toBe('match');
  expect(fields.email_type).toBe('business');
  expect(fields.phone_vs_place).toBe('exact');
});

/* ── validation ──────────────────────────────────────────────────────────── */

test('every field arrives under a readable label, never a raw slug',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await fillContact(page);
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { labels } = (await submissions(page))[0];

    // nothing may fall back to its wire name
    const slugs = Object.entries(labels)
      .filter(([name, label]) => label === name)
      .map(([name]) => name);
    expect(slugs, `these fields have no label: ${slugs.join(', ')}`).toEqual([]);

    expect(labels.place_postal_code).toBe('Restaurant ZIP');
    expect(labels.place_hours).toBe('Opening hours');
    expect(labels.routing_owner).toBe('Routing owner (AE or SDR)');
  });

test('the honeypot fields never reach Default', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields } = (await submissions(page))[0];
  expect(fields).not.toHaveProperty('company_website_confirm');
  expect(fields).not.toHaveProperty('form_render_time');
});

/* ── attribution ─────────────────────────────────────────────────────────── */

test('UTM and gclid ride along with the lead', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.removeItem('usv_attr'); } catch (e) { /* no-op */ }
  });
  await page.goto('https://example.com/book?utm_source=google&utm_medium=cpc' +
                  '&utm_campaign=pos-switch&gclid=ABC123');
  await page.setContent(HTML, { waitUntil: 'load' });
  openedAt.set(page, Date.now());
  await page.waitForTimeout(150);
  await page.locator('input[value="prospect"]').check({ force: true });
  await clickContinue(page);

  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields } = (await submissions(page))[0];
  expect(fields.utm_source).toBe('google');
  expect(fields.utm_campaign).toBe('pos-switch');
  expect(fields.gclid).toBe('ABC123');
});

/* The channel is set per page on the wrapper, typed by hand in the Designer:
   it arrives trimmed but otherwise exactly as typed, and a page without it
   still sends the field so Default always has it to map. */
for (const [how, opts, want] of [
  ['a wrapper attribute sends its value', { leadSource: ' Automated Outbound ' },
   'Automated Outbound'],
  ['no attribute sends an empty lead_source', {}, ''],
  ['it sits alongside the revenue switch', { revenue: 'attribute', leadSource: 'paid' },
   'paid']
]) {
  test(`lead source: ${how}`, async ({ page }) => {
    await open(page, 'prospect', buildPage(opts));
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    if (opts.revenue) await pickRevenue(page, '1m_plus');
    await fillContact(page);
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { fields, labels } = (await submissions(page))[0];
    expect(fields.lead_source).toBe(want);
    expect(labels.lead_source).toMatch(/lead source/i);
  });
}

// Anything reading the form before submit — Default included — sees it too.
test('lead source is in the form from load', async ({ page }) => {
  await open(page, null, buildPage({ leadSource: 'paid' }));
  await expect(page.locator('form input[type="hidden"][name="lead_source"]'))
    .toHaveValue('paid');
});

/* ── funnel events ───────────────────────────────────────────────────────── */

test('the funnel fires in order and survives a missing dataLayer', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const fired = await events(page);
  expect(fired).toEqual(expect.arrayContaining([
    'usv_form_step0_view', 'usv_form_visitor_type', 'usv_form_place_selected',
    'usv_form_step2_view', 'usv_form_submit'
  ]));
  expect(fired.indexOf('usv_form_step0_view'))
    .toBeLessThan(fired.indexOf('usv_form_step2_view'));
});

test('tracking cannot break a submission even if dataLayer is hostile',
  async ({ page }) => {
    await page.addInitScript(() => {
      // a broken analytics setup on the page must not take the form down
      Object.defineProperty(window, 'dataLayer', {
        get() { throw new Error('analytics exploded'); },
        set() { throw new Error('analytics exploded'); }
      });
    });
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await fillContact(page);
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  });

/* ── graceful degradation ────────────────────────────────────────────────── */

test('with Google unavailable the field still works and still submits',
  async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'google', { value: undefined, writable: false });
    });
    await open(page);

    const input = page.locator('[role="combobox"]');
    await input.click();
    await input.fill('Some Unlisted Diner');

    // the only offer is "not listed yet" — never a dead end
    const notListed = page.getByRole('option', { name: /isn.t listed yet/i });
    await notListed.waitFor({ state: 'visible' });
    await notListed.click();

    await continueToStep2(page);
    await fillContact(page, { email: 'owner@somediner.com' });
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { fields } = (await submissions(page))[0];
    expect(fields.place_verified).toBe('false');
    expect(fields.restaurant_name).toBe('Some Unlisted Diner');
  });

/* ── field-level validation ──────────────────────────────────────────────── */

test('an incomplete phone number is flagged at the field, not after submit',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);

    await page.fill('input[name="phone"]', '401849');        // too short
    await page.locator('input[name="first_name"]').click();  // blur
    await expect(page.getByText(/looks incomplete/i)).toBeVisible();

    await page.fill('input[name="phone"]', '4018492900');
    await page.locator('input[name="first_name"]').click();
    await expect(page.getByText(/looks incomplete/i)).not.toBeVisible();
  });

test('a one-letter TLD is rejected', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);

  await page.fill('input[name="email"]', 'joe@gmail.c');
  await page.locator('input[name="email"]').blur();
  await expect(page.getByText(/missing something/i)).toBeVisible();
});

test('a legitimate multi-part domain is accepted', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);

  await page.fill('input[name="email"]', 'chef@my-diner.co.uk');
  await page.locator('input[name="email"]').blur();
  await expect(page.getByText(/missing something/i)).not.toBeVisible();
});

test('each status option carries only its title, not the description too',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await fillContact(page);
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { optionLabels } = (await submissions(page))[0];

    // Default shows these in its condition builder; the sub-copy must not bleed in
    expect(optionLabels.brand_new_opening).toBe('We’re opening a brand-new spot');
    expect(optionLabels.replacing_pos).toBe('We’re replacing our current POS');
    expect(optionLabels.exploring).toBe('We’re just exploring');
  });

test('clicking the description still selects the card', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  // y=42 lands on the description row, not the title
  await page.locator('[data-status="exploring"]').click({ position: { x: 120, y: 42 } });
  await expect(page.locator('input[value="exploring"]')).toBeChecked();
});

/* ── triage: the people who should never reach the sales queue ───────────── */

// Dropped on the New Lead Form call: diners are not the audience, and the
// option only existed because of a marketing constraint that has passed.
test('there is no diner option, and no off-ramp left behind', async ({ page }) => {
  await open(page, null);
  await expect(page.locator('input[value="diner"]')).toHaveCount(0);
  await expect(page.getByText(/i ate at a restaurant/i)).toHaveCount(0);
  await expect(page.getByText(/we make the software/i)).toHaveCount(0);
  await expect(page.locator('input[name="visitor_type"]')).toHaveCount(2);
});

test('triage will not advance without a choice', async ({ page }) => {
  await open(page, null);
  await clickContinue(page);
  await expect(page.locator('[role="combobox"]')).not.toBeVisible();
  await expect(page.getByText(/pick the one that fits/i)).toBeVisible();
});

test('visitor_type reaches Default under a readable label', async ({ page }) => {
  await open(page);                              // prospect
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields, labels } = (await submissions(page))[0];
  expect(fields.visitor_type).toBe('prospect');
  expect(labels.visitor_type).toBe('Who they are');
});

/* ── branching: one form, two questionnaires ─────────────────────────────── */

/** Walk a branch to the details step and answer its question. */
async function walkTo(page, visitor, choiceValue) {
  await open(page, visitor);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await page.locator('input[value="' + choiceValue + '"]').check({ force: true });
  await fillContact(page);
}

test('a customer is asked what they need, not where they are', async ({ page }) => {
  await open(page, 'current_customer');
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);

  await expect(page.getByText(/what do you need help with/i).first()).toBeVisible();
  await expect(page.locator('[data-help="add_location"]')).toBeVisible();
  await expect(page.locator('[data-status="brand_new_opening"]')).not.toBeVisible();
});

test('a prospect is asked where they are, not what they need', async ({ page }) => {
  await open(page, 'prospect');
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);

  await expect(page.getByText(/where are you today/i).first()).toBeVisible();
  await expect(page.locator('[data-status="brand_new_opening"]')).toBeVisible();
  await expect(page.locator('[data-help="add_location"]')).not.toBeVisible();
});

for (const [choice, owner] of [['add_location', 'AM'], ['add_products', 'AM']]) {
  test('a customer choosing ' + choice + ' routes to ' + owner, async ({ page }) => {
    await walkTo(page, 'current_customer', choice);
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { fields } = (await submissions(page))[0];
    expect(fields.routing_owner).toBe(owner);
    expect(fields.help_topic).toBe(choice);
    expect(fields.visitor_type).toBe('current_customer');
    // the question that was never asked must not travel with the lead
    expect(fields).not.toHaveProperty('restaurant_status');
  });
}

for (const choice of ['product_help', 'account_billing', 'other']) {
  test('a customer choosing ' + choice + ' is tagged SUPPORT and shown where to go',
    async ({ page }) => {
      await walkTo(page, 'current_customer', choice);
      await submit(page);

      await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
      const { fields } = (await submissions(page))[0];
      expect(fields.routing_owner).toBe('SUPPORT');
      expect(fields.help_topic).toBe(choice);

      // captured, but pointed at support rather than a scheduler
      await expect(page.getByText(/support will follow up/i)).toBeVisible();
      await expect(page.getByRole('link', { name: /help center/i })).toBeVisible();
    });
}

for (const [status, owner] of [['brand_new_opening', 'AE'], ['replacing_pos', 'AE'],
                               ['exploring', 'SDR']]) {
  test('a prospect choosing ' + status + ' routes to ' + owner, async ({ page }) => {
    await walkTo(page, 'prospect', status);
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { fields } = (await submissions(page))[0];
    expect(fields.routing_owner).toBe(owner);
    expect(fields.restaurant_status).toBe(status);
    expect(fields).not.toHaveProperty('help_topic');
  });
}

test('the details step will not submit without answering its question',
  async ({ page }) => {
    await open(page, 'current_customer');
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await fillContact(page);
    await submit(page);

    expect(await submissions(page)).toHaveLength(0);
    await expect(page.getByText(/let us know what you need/i)).toBeVisible();
  });

test('every contact field is required on both branches', async ({ page }) => {
  for (const visitor of ['prospect', 'current_customer']) {
    await open(page, visitor);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await page.locator('input[value="' +
      (visitor === 'prospect' ? 'exploring' : 'other') + '"]').check({ force: true });
    await submit(page);
    expect(await submissions(page), visitor + ' submitted with empty contact fields')
      .toHaveLength(0);
  }
});

/* ── schema stability ────────────────────────────────────────────────────── */

/**
 * Default builds its field list from what a submission contains. If a field is
 * omitted when blank it never appears in the mapping UI, so the shape has to be
 * identical whether or not Google matched.
 */
test('every field reaches Default even when nothing was matched', async ({ page }) => {
  // no Google: the name is typed, so every place_* value is blank
  await page.addInitScript(() => {
    Object.defineProperty(window, 'google', { value: undefined, writable: false });
  });
  await open(page, 'prospect');

  const input = page.locator('[role="combobox"]');
  await input.click();
  await input.fill('Somewhere Unlisted');
  await page.getByRole('option', { name: /isn.t listed yet/i }).click();
  await continueToStep2(page);
  await fillContact(page, { email: 'chef@somewhere.com' });
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields } = (await submissions(page))[0];

  for (const name of ['place_id', 'place_city', 'place_region', 'place_postal_code',
                      'place_country', 'place_website', 'place_phone', 'place_hours',
                      'place_rating', 'place_category', 'utm_source', 'gclid',
                      'email_type', 'phone_vs_place', 'visitor_type']) {
    expect(fields, name + ' missing — Default would never learn it exists')
      .toHaveProperty(name);
  }
});

test('the two branches submit the same shape apart from their own question',
  async ({ page }) => {
    const shapeOf = async (visitor, choice) => {
      await open(page, visitor);
      await pickRestaurant(page, 'Tautog');
      await continueToStep2(page);
      await page.locator('input[value="' + choice + '"]').check({ force: true });
      await fillContact(page);
      await submit(page);
      await expect.poll(() => submissions(page).then((s) => s.length)).toBeGreaterThan(0);
      const all = await submissions(page);
      return Object.keys(all[all.length - 1].fields).sort();
    };

    const prospect = await shapeOf('prospect', 'exploring');
    const customer = await shapeOf('current_customer', 'add_location');

    const onlyProspect = prospect.filter((k) => !customer.includes(k));
    const onlyCustomer = customer.filter((k) => !prospect.includes(k));

    expect(onlyProspect).toEqual(['restaurant_status']);
    expect(onlyCustomer).toEqual(['help_topic']);
  });

test('all three questions arrive as option groups Default can branch on',
  async ({ page }) => {
    await open(page, 'prospect');
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await page.locator('input[value="exploring"]').check({ force: true });
    await fillContact(page);
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { optionsByName, labels } = (await submissions(page))[0];

    // a hidden input carries a value but no options, so Default has nothing to
    // pick from when building a condition — every question must be a real group
    expect(optionsByName.visitor_type).toEqual(['prospect', 'current_customer']);
    expect(optionsByName.restaurant_status).toEqual(
      ['brand_new_opening', 'replacing_pos', 'exploring']);

    expect(labels.visitor_type).toBe('Who they are');
  });

/* ── the always-visible way out ──────────────────────────────────────────── */

test('the New Restaurant button fills the field without typing anything first', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /new restaurant/i }).click();
  await expect(page.locator('[role="combobox"]')).toHaveValue('New Restaurant');

  await continueToStep2(page);
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields } = (await submissions(page))[0];
  expect(fields.restaurant_name).toBe('New Restaurant');
  expect(fields.place_source).toBe('not_listed');
  expect(fields.place_verified).toBe('false');
  // not listed almost always means brand new, which is an AE
  expect(fields.restaurant_status).toBe('brand_new_opening');
  expect(fields.routing_owner).toBe('AE');
});

test('the button overwrites a half-typed name, since that is what it says it does',
  async ({ page }) => {
    await open(page);
    const input = page.locator('[role="combobox"]');
    await input.click();
    await input.fill('Taut');
    await page.getByRole('button', { name: /new restaurant/i }).click();
    await expect(input).toHaveValue('New Restaurant');
    // and the list it was covering is closed
    await expect(page.locator('[role="option"]')).toHaveCount(0);
  });

/* ── going backwards ─────────────────────────────────────────────────────── */

test('Back on the finder returns to triage without losing the answer', async ({ page }) => {
  await open(page);                                  // prospect, now on the finder
  await page.getByRole('button', { name: /^.?\s*back$/i }).click();
  await expect(page.locator('input[value="prospect"]')).toBeChecked();
  await expect(page.locator('[role="combobox"]')).not.toBeVisible();
});

test('Back on the details step returns to the finder with the place intact', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await page.getByRole('button', { name: /^.?\s*back$/i }).click();

  const input = page.locator('[role="combobox"]');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Tautog Tavern');

  await continueToStep2(page);
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  expect((await submissions(page))[0].fields.place_source).toBe('google');
});

/**
 * No em dash anywhere in what ships.
 *
 * The earlier version of this swept live text nodes, which missed two: copy
 * injected by JS into a panel the sweep never reached, and a dash written as
 * a — escape rather than a literal. Scanning the built artifact catches
 * both, plus any panel no test happens to visit.
 */
test('the shipped embed contains no em or en dash', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'webflow');
  const files = ['embed.html', 'embed-part1.html', 'embed-part2.html']
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f));

  expect(files.length).toBeGreaterThan(0);

  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    // literal dashes, HTML entities, and JS unicode escapes alike
    const re = /.{0,40}(—|–|&mdash;|&ndash;|\\u201[34]).{0,40}/g;
    let m;
    while ((m = re.exec(text))) offenders.push(path.basename(f) + ': ' + m[0].trim());
  }
  expect(offenders).toEqual([]);
});

/* ── the button has to name where it actually goes ───────────────────────── */

const SUPPORT_TOPICS = ['product_help', 'account_billing', 'other'];
const AM_TOPICS = ['add_location', 'add_products'];

for (const topic of SUPPORT_TOPICS) {
  test(`${topic} offers to send to support, not to book a demo`, async ({ page }) => {
    await open(page, 'current_customer');
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await page.locator(`input[value="${topic}"]`).check({ force: true });

    await expect(page.getByRole('button', { name: /send to support/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /book my demo/i })).toHaveCount(0);
    await expect(page.getByText(/only used to/i)).toHaveCount(0);
  });
}

// An existing customer adding a terminal is not being sold a demo. Calling it
// one is the fastest way to get the call declined.
for (const topic of AM_TOPICS) {
  test(`${topic} offers the account team, never a demo`, async ({ page }) => {
    await open(page, 'current_customer');
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await page.locator(`input[value="${topic}"]`).check({ force: true });

    await expect(page.getByRole('button', { name: /connect with the account team/i }))
      .toBeVisible();
    await expect(page.getByRole('button', { name: /book my demo/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /send to support/i })).toHaveCount(0);
  });
}

test('switching from a support topic back to a booking one restores the label',
  async ({ page }) => {
    await open(page, 'current_customer');
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await page.locator('input[value="account_billing"]').check({ force: true });
    await expect(page.getByRole('button', { name: /send to support/i })).toBeVisible();
    await page.locator('input[value="add_location"]').check({ force: true });
    await expect(page.getByRole('button', { name: /connect with the account team/i }))
      .toBeVisible();
    await expect(page.getByText(/only used to/i)).toHaveCount(0);
  });

test('a prospect never sees the support label, whatever they pick', async ({ page }) => {
  await open(page);                                   // prospect
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  for (const v of ['brand_new_opening', 'replacing_pos', 'exploring']) {
    await page.locator(`input[value="${v}"]`).check({ force: true });
    await expect(page.getByRole('button', { name: /book my demo/i })).toBeVisible();
  }
});

/* ── every step you can reach, you can leave ─────────────────────────────── */

test('no step between triage and submit is a dead end', async ({ page }) => {
  await open(page, null);
  const backish = /back|that.s not me/i;

  await page.locator('input[value="prospect"]').check({ force: true });
  await clickContinue(page);
  await expect(page.locator('[role="combobox"]')).toBeVisible();
  await expect(page.getByRole('button', { name: backish })).toHaveCount(1);   // finder

  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await expect(page.getByRole('button', { name: backish })).toHaveCount(1);   // details
});

/* ── what we take from Places ────────────────────────────────────────────── */

test('the form makes no promise about not calling', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await expect(page.getByText(/no cold calls/i)).toHaveCount(0);
});

test('every Places field we pay for reaches Default', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const { fields, labels } = (await submissions(page))[0];

  // restored after being dropped in an earlier pass
  expect(fields.place_types).toContain('restaurant');
  expect(labels.place_types).toBe('Google place types');

  // machine value, not just the human-readable display name
  expect(fields.place_primary_type).toBe('seafood_restaurant');
  expect(fields.place_category).toBe('Seafood restaurant');

  // same shape as the lead's own number
  expect(fields.place_phone_e164).toBe('+14018492900');
  expect(fields.place_phone).toBe('(401) 849-2900');

  expect(fields.place_price_range).toBe('20-40 USD');
  expect(fields.place_service_area_only).toBe('false');
});

test('a place missing the optional Places data still submits a full shape',
  async ({ page }) => {
    // Just Wing It has no website and the stub gives it no priceRange
    await open(page);
    await pickRestaurant(page, 'Just Wing');
    await continueToStep2(page);
    await fillContact(page, { email: 'owner@justwingit.com' });
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { fields } = (await submissions(page))[0];
    for (const k of ['place_types', 'place_primary_type', 'place_phone_e164',
                     'place_price_range', 'place_service_area_only']) {
      expect(fields, k + ' must be present even when blank').toHaveProperty(k);
    }
  });

/* ── responsive + weight ─────────────────────────────────────────────────
 * These run in both projects, so every assertion below is checked at desktop
 * width and at Pixel 5 width. The harness sets the same viewport meta the
 * host page does; without it a mobile run silently measures the desktop
 * layout at 980px.
 */

test('no step ever scrolls the page sideways', async ({ page }) => {
  const noOverflow = async (where) => {
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - window.innerWidth);
    expect(over, where + ' overflows by ' + over + 'px').toBeLessThanOrEqual(0);
  };
  await open(page, null);
  await noOverflow('triage');
  await page.locator('input[value="prospect"]').check({ force: true });
  await clickContinue(page);
  await noOverflow('finder');
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await noOverflow('details');
  await page.fill('input[name="email"]', 'jamie@gmial.com');   // widest state
  await page.locator('input[name="email"]').blur();
  await page.waitForTimeout(150);
  await noOverflow('details with the typo hint open');
});

// Both pages: the revenue select only exists on one of them, and a select is
// exactly the control a 16px floor is easiest to forget on.
for (const [what, html] of [['a plain page', undefined],
                            ['a page asking for revenue', 'REV']]) {
test('no visible field is small enough to make iOS zoom on focus, on ' + what,
  async ({ page }) => {
  await open(page, 'prospect', html === 'REV' ? HTML_REV : HTML);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  const tooSmall = await page.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea')]
      .filter((e) => {
        const b = e.getBoundingClientRect();
        // on-screen and actually visible: the honeypot sits at left:-9999px
        return e.offsetParent && getComputedStyle(e).opacity !== '0' &&
               b.height > 4 && b.right > 0 && b.left < window.innerWidth;
      })
      .map((e) => ({ name: e.name, size: parseFloat(getComputedStyle(e).fontSize) }))
      .filter((x) => x.size < 16));
  expect(tooSmall).toEqual([]);
});
}

test('the text-sized controls have a hit area far bigger than their text',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await page.fill('input[name="email"]', 'jamie@gmial.com');
    await page.locator('input[name="email"]').blur();
    await page.waitForTimeout(150);

    const targets = await page.evaluate(() => {
      const want = ['Back', 'Change', 'New Restaurant', "No, it", 'Use it'];
      return [...document.querySelectorAll('button')].filter((e) => e.offsetParent)
        .filter((e) => want.some((w) => e.textContent.includes(w)))
        .map((e) => {
          const b = e.getBoundingClientRect();
          const a = getComputedStyle(e, '::after');
          const g = (v) => Math.abs(parseFloat(v) || 0);
          const grown = a.content !== 'none';
          return { t: e.textContent.replace(/\s+/g, ' ').trim().slice(0, 20),
                   h: Math.round(b.height + (grown ? g(a.top) + g(a.bottom) : 0)) };
        });
    });
    expect(targets.length).toBeGreaterThanOrEqual(4);
    // WCAG 2.5.8 asks for 24; these clear it comfortably
    for (const t of targets) {
      expect(t.h, `"${t.t}" hit area is only ${t.h}px tall`).toBeGreaterThanOrEqual(32);
    }
  });

test('the Maps SDK is not requested until the visitor heads for the finder',
  async ({ page }) => {
    await open(page, null);                       // sitting on triage
    expect(await page.evaluate(() => window.__placesLoads),
      'Maps must not load before the visitor shows any intent').toBe(0);

    await page.locator('input[value="prospect"]').check({ force: true });
    await page.waitForTimeout(150);
    // warmed a whole step early, so it is ready by the time they type
    expect(await page.evaluate(() => window.__placesLoads)).toBeGreaterThan(0);
  });

test('a support-bound customer never causes the Maps SDK to load twice',
  async ({ page }) => {
    await open(page, 'current_customer');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => window.__placesLoads);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    expect(await page.evaluate(() => window.__placesLoads)).toBe(after);
  });

/* ── the suggestion list must never be cut off ───────────────────────────── */

test('the card does not clip its own dropdown', async ({ page }) => {
  await open(page);
  const input = page.locator('[role="combobox"]');
  await input.click();
  await input.fill('Tautog');
  await page.locator('[role="option"]').first().waitFor({ state: 'visible' });

  const r = await page.evaluate(() => {
    const lb = document.querySelector('[role="listbox"]');
    const card = lb.closest('form').parentElement;
    const b = lb.getBoundingClientRect(), c = card.getBoundingClientRect();
    return { clips: getComputedStyle(card).overflow !== 'visible',
             extendsPastCardBy: Math.round(b.bottom - c.bottom) };
  });
  // it legitimately hangs below the short finder step, so the card must not clip
  expect(r.clips, 'the card is clipping again').toBe(false);
  expect(r.extendsPastCardBy).toBeGreaterThan(0);
});

test('the dropdown stays inside the viewport, flipping above the field if it must',
  async ({ page }, testInfo) => {
    // a short viewport with the form pushed down: the classic cut-off case
    await page.setViewportSize({ width: testInfo.project.name === 'mobile' ? 390 : 740,
                                 height: 380 });
    await page.setContent(HTML.replace('<body>', '<body><div style="height:320px"></div>'),
                          { waitUntil: 'load' });
    await page.waitForFunction(() => !!document.querySelector('[role="combobox"]'));
    await page.locator('input[value="prospect"]').check({ force: true });
    await clickContinue(page);
    const input = page.locator('[role="combobox"]');
    await input.click();
    await input.fill('Tautog');
    await page.locator('[role="option"]').first().waitFor({ state: 'visible' });

    const r = await page.evaluate(() => {
      const lb = document.querySelector('[role="listbox"]');
      const b = lb.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom),
               vh: window.innerHeight, height: Math.round(b.height) };
    });
    expect(r.height, 'the list collapsed to nothing').toBeGreaterThan(60);
    expect(r.bottom, 'runs past the bottom of the screen').toBeLessThanOrEqual(r.vh);
    expect(r.top, 'runs off the top of the screen').toBeGreaterThanOrEqual(0);
  });

/**
 * prototype.html is the link that gets handed round, and it is opened on
 * phones. Without a meta viewport a phone lays it out at 980px and scales the
 * whole thing down, so the form arrives as an unreadable miniature desktop and
 * none of the narrow-width layout ever runs. It is a one-line omission that
 * looks exactly like "the mobile layout is broken", so it gets a test.
 */
test('the shareable prototype tells phones to use their own width', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');

  // A phone-width layout viewport, standards mode, and a declared encoding.
  expect(html).toMatch(/<meta\s+name=["']viewport["'][^>]*width=device-width/i);
  expect(html.slice(0, 200)).toMatch(/<!doctype html>/i);
  expect(html.slice(0, 1024)).toMatch(/<meta\s+charset=["']utf-8["']/i);
});

/**
 * The two-up rows have to stack on the width the row actually has, not on the
 * width of the phone. The embed drops into whatever Webflow column it is given,
 * so a viewport media query is right only when those two happen to agree.
 */
test('the paired fields stack on their own width, not the viewport',
  async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);

    const sideBySide = async () => page.evaluate(() => {
      const box = (n) => document.querySelector('input[name="' + n + '"]')
        .getBoundingClientRect();
      const pair = (a, b) => Math.abs(box(a).top - box(b).top) < 4;
      return { names: pair('first_name', 'last_name'),
               contact: pair('email', 'phone') };
    });

    // Wide viewport, wide column: both pairs share a line.
    expect(await sideBySide()).toEqual({ names: true, contact: true });

    // Same wide viewport, narrow column - the shape of an embed dropped into a
    // sidebar. A viewport media query would leave both pairs crushed side by
    // side; sizing on the row's own width stacks them.
    await page.addStyleTag({ content: 'body{max-width:380px;}' });
    await page.waitForTimeout(80);
    expect(await sideBySide()).toEqual({ names: false, contact: false });
  });


/* ── the embed inside Webflow's own container ────────────────────────────── */

/**
 * Everything above drops the embed straight into <body>, where the parent is a
 * plain block and max-width:100% is enough. Webflow's Embed wrapper is
 * display:flex, which makes the form root a flex item — and a flex item's
 * min-width:auto floors it at its min-content width, overriding max-width. A
 * fixed `width` anywhere inside therefore travels up and blows the column out.
 *
 * That shipped once: the card carried width:780px, so on upserve.com/book-a-demo
 * the root measured 804px inside a 320px column, sat at left:-202px, and the
 * page scrolled sideways with the form's left edge cut off.
 */
const FLEX_WIDTHS = [320, 360, 390, 400, 430, 768, 1440];

for (const width of FLEX_WIDTHS) {
  test('the embed fits Webflow\'s flex column at ' + width + 'px',
    async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(pageInWebflowColumn(), { waitUntil: 'load' });
      await page.waitForFunction(() => !!document.querySelector('input[value="prospect"]'));
      await page.waitForTimeout(150);

      const m = await page.evaluate(() => {
        const wrap = document.querySelector('.code-embed');
        const root = wrap.querySelector(':scope > div:not([style])') || wrap.firstElementChild;
        const w = wrap.getBoundingClientRect(), r = root.getBoundingClientRect();
        return {
          over: document.documentElement.scrollWidth - window.innerWidth,
          wrapW: Math.round(w.width),
          rootW: Math.round(r.width),
          rootLeft: Math.round(r.left),
          wrapLeft: Math.round(w.left),
        };
      });

      // the page must not scroll sideways
      expect(m.over, 'page overflows by ' + m.over + 'px').toBeLessThanOrEqual(0);
      // and the form must not be wider than the column it was given
      expect(m.rootW, 'form root ' + m.rootW + 'px in a ' + m.wrapW + 'px column')
        .toBeLessThanOrEqual(m.wrapW);
      // nor hang off its left edge, which is how the clipping showed up
      expect(m.rootLeft).toBeGreaterThanOrEqual(m.wrapLeft - 1);
    });
}

/**
 * The tests above measure the form root against the column it was given, which
 * is the failure that shipped first. They say nothing about a single control
 * spilling out of the card while the root itself stays honest - and that
 * shipped too: the "If you're a new business use ..." shortcut sat on the
 * label row at flex:0 0 auto, so once its 266px of text outgrew the row it
 * hung over the card's right edge instead of wrapping. Nothing caught it,
 * because the root was still the right width and the page still did not
 * scroll sideways; only the text was outside the card.
 *
 * The widths here are deliberately below FLEX_WIDTHS' 320px floor. The embed
 * sits inside whatever padding the Webflow page wraps it in, so the width the
 * card actually gets is well under the viewport - at a 320px viewport this
 * harness leaves the label row 252 usable pixels.
 */
const SPILL_WIDTHS = [320, 300, 280];

for (const width of SPILL_WIDTHS) {
  test('no control spills out of the card at ' + width + 'px',
    async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(pageInWebflowColumn(), { waitUntil: 'load' });
      await page.waitForFunction(() => !!document.querySelector('input[value="prospect"]'));
      await page.waitForTimeout(150);
      await page.locator('input[value="prospect"]').check({ force: true });
      await page.locator('button:visible').filter({ hasText: /continue/i }).first().click();
      await page.waitForTimeout(250);

      const spills = await page.evaluate(() => {
        // The build minifies every class name, so the card is found by what it
        // looks like rather than what it is called: the nearest ancestor of the
        // name field that paints itself white and carries real padding.
        // Start ABOVE the field: an input paints itself --usv-paper too, and
        // only its padding kept it from ending this walk on itself and making
        // every assertion below vacuous.
        let card = document.querySelector('[name="restaurant_name"]').parentElement;
        while (card && card !== document.body) {
          const c = getComputedStyle(card);
          if (c.backgroundColor === 'rgb(255, 255, 255)'
              && parseFloat(c.paddingLeft) >= 16) break;
          card = card.parentElement;
        }
        const cs = getComputedStyle(card);
        const box = card.getBoundingClientRect();
        const left = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        const right = box.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        const out = [];
        for (const el of card.querySelectorAll('*')) {
          // Overlays (the suggestion list) place themselves and are allowed out.
          const s = getComputedStyle(el);
          if (s.position === 'absolute' || s.position === 'fixed') continue;
          if (!el.getClientRects().length) continue;
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          // Screen-reader-only text is parked far off to the left on purpose.
          if (r.right <= 0) continue;
          if (r.right > right + 1 || r.left < left - 1) {
            out.push((el.id || el.className || el.tagName) + ' by ' +
                     Math.round(Math.max(r.right - right, left - r.left)) + 'px');
          }
        }
        return out;
      });

      expect(spills, 'spilling out of the card: ' + spills.join(', ')).toEqual([]);
    });
}

/**
 * The direct cause, asserted on its own so the reason survives even if the
 * layout above is rearranged: nothing in the embed may declare a fixed width,
 * because a fixed width becomes a min-content floor that escapes any container.
 */
test('no element in the shipped embed declares a fixed pixel width', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'webflow');
  const files = ['embed.html', 'embed-part1.html', 'embed-part2.html']
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f));
  expect(files.length).toBeGreaterThan(0);

  const offenders = [];
  for (const f of files) {
    const css = (fs.readFileSync(f, 'utf8').match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
    // three digits or more, so 19px marks and 16px icons stay legal
    const re = /[^-a-z]width\s*:\s*(\d{3,})px/g;
    let m;
    while ((m = re.exec(css))) {
      // max-width and min-width are caps, not intrinsic sizes — those are fine
      const before = css.slice(Math.max(0, m.index - 4), m.index + 1);
      if (/max-|min-/.test(before)) continue;
      offenders.push(path.basename(f) + ': ' + m[0].trim());
    }
  }
  expect(offenders).toEqual([]);
});

/* ── the revenue question ────────────────────────────────────────────────────
 *
 * One embed goes on every page; the page decides whether it also asks for
 * revenue. What has to hold is that a page which does not ask cannot leak the
 * field, that the ones which do get it in the right place, and that all four
 * ways of saying yes actually work — those are the strings a marketer types
 * into the Designer, and a build that renamed one of them would fail silently.
 */

const REVENUE = 'input[name="annual_revenue"]';
const pickRevenue = (page, v) =>
  page.locator(`input[value="${v}"]`).check({ force: true });
/* The three cards are one question. It is "shown" when its label is on screen;
   the radios themselves are visually hidden inside their cards, as every other
   card group on this form already is. */
const revenueShown = (page) =>
  expect(page.getByText(/annual revenue/i).first()).toBeVisible();
/* On the customer branch the question is hidden, not removed — removal is what
   a page that never asks gets, and those tests assert a count of zero. */
const revenueHidden = (page) =>
  expect(page.getByText(/annual revenue/i).first()).toBeHidden();

test('a page that does not ask has no revenue question in it at all',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);

    await expect(page.locator(REVENUE)).toHaveCount(0);
    await expect(page.getByText(/annual revenue/i)).toHaveCount(0);

    await fillContact(page);
    await submit(page);
    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    expect((await submissions(page))[0].fields).not.toHaveProperty('annual_revenue');
  });

/* Each of these is a switch someone flips in Webflow, so each is tested
   against the built file rather than trusted. */
const SWITCHES = [
  ['a wrapper attribute',      { revenue: 'attribute' }],
  ['the attribute set to true', { revenue: 'true' }],
  ['a window global set in the head', { revenue: 'global' }],
  ['a path in REVENUE_PATHS',  { paths: ['/book-a-demo'] }],
  ['a path written with a trailing slash', { paths: ['/book-a-demo/'] }]
];

for (const [how, opts] of SWITCHES) {
  test(`${how} turns the revenue question on`, async ({ page }) => {
    const html = buildPage(opts);
    if (opts.paths) {
      // the path route is the only one that needs a real URL
      await page.route('**/*', (r) =>
        r.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('http://upserve.test' +
                      opts.paths[0].replace(/\/+$/, ''));
      await page.waitForFunction(() => !!document.querySelector('[role="combobox"]'));
      openedAt.set(page, Date.now());
      await page.waitForTimeout(150);
      await page.locator('input[value="prospect"]').check({ force: true });
      await clickContinue(page);
    } else {
      await open(page, 'prospect', html);
    }
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await revenueShown(page);
  });
}

// A section saying no wins over anything above it saying yes. The value is
// typed by hand into a Designer field, so capitalisation and a stray space
// must not flip its meaning.
for (const off of ['0', 'false', 'False', ' false ', '  0']) {
  test(`the attribute set to "${off}" is a deliberate no`, async ({ page }) => {
    await open(page, 'prospect', buildPage({ revenue: off }));
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await expect(page.locator(REVENUE)).toHaveCount(0);
  });
}

test('a page that does ask puts it between the timeline and their name',
  async ({ page }) => {
    await open(page, 'prospect', HTML_REV);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);

    await revenueShown(page);

    // Order is the point: after the cards, before the name row.
    const order = await page.evaluate(() => {
      const sel = document.querySelector('input[name="annual_revenue"]');
      const status = document.querySelector('input[name="restaurant_status"]');
      const first = document.querySelector('input[name="first_name"]');
      const pos = (a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
      return { afterStatus: !!pos(status, sel), beforeName: !!pos(sel, first) };
    });
    expect(order).toEqual({ afterStatus: true, beforeName: true });
  });

test('a customer is never asked their revenue', async ({ page }) => {
  await open(page, 'current_customer', HTML_REV);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);

  await revenueHidden(page);

  await page.locator('input[value="add_location"]').check({ force: true });
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  /* Absent, not empty. An unchecked radio group contributes nothing, where the
     select this replaced sent annual_revenue='' — and the form's own rule is
     that an empty field reads as missing data while an absent one reads as not
     applicable. This is the shape a customer's submission should have. */
  expect((await submissions(page))[0].fields).not.toHaveProperty('annual_revenue');
});

test('a prospect cannot submit without a range', async ({ page }) => {
  await open(page, 'prospect', HTML_REV);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await page.locator('input[value="replacing_pos"]').check({ force: true });
  await fillContact(page);
  await submit(page);

  await expect(page.getByText(/pick the range that fits/i)).toBeVisible();
  expect(await submissions(page)).toHaveLength(0);

  await pickRevenue(page, '1m_plus');
  await expect(page.getByText(/pick the range that fits/i)).toBeHidden();
  await submit(page);
  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
});

test('the range reaches Default with its options and a readable label',
  async ({ page }) => {
    await open(page, 'prospect', HTML_REV);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    await page.locator('input[value="replacing_pos"]').check({ force: true });
    await pickRevenue(page, '300k_1m');
    await fillContact(page);
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { fields, labels, optionsByName } = (await submissions(page))[0];

    expect(fields.annual_revenue).toBe('300k_1m');
    expect(labels.annual_revenue).toMatch(/annual revenue/i);
    expect(labels.annual_revenue).not.toMatch(/annual_revenue/);
    // Default branches on the option set, so all three have to arrive.
    expect(optionsByName.annual_revenue)
      .toEqual(['under_300k', '300k_1m', '1m_plus']);
  });

// Someone who answers as a prospect, backs up, and comes back as a customer
// must not leave a range behind for Default to read.
test('switching to the customer branch drops an answered range', async ({ page }) => {
  await open(page, 'prospect', HTML_REV);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);
  await pickRevenue(page, 'under_300k');

  await page.getByRole('button', { name: /back/i }).first().click();
  await page.getByRole('button', { name: /back/i }).first().click();
  await page.locator('input[value="current_customer"]').check({ force: true });
  await clickContinue(page);
  await clickContinue(page);
  await expect(page.locator('input[name="first_name"]')).toBeVisible();

  await revenueHidden(page);
  expect(await page.locator(REVENUE + ':checked').count()).toBe(0);
});

/* The spill sweep above stops at the finder, because that is where the widest
   things used to be. The details step is now the longest one on the page, and
   its three-across range row is the only thing that lays out sideways, so it
   gets its own pass — in the same
   Webflow flex column, on the narrowest phones anyone still ships. */
for (const width of [320, 360, 390]) {
  test('nothing on the details step spills out of the card at ' + width + 'px',
    async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(pageInWebflowColumn({ revenue: 'attribute' }),
                            { waitUntil: 'load' });
      await page.waitForFunction(() => !!document.querySelector('input[value="prospect"]'));
      await page.waitForTimeout(150);
      await page.locator('input[value="prospect"]').check({ force: true });
      await page.locator('button:visible').filter({ hasText: /continue/i }).first().click();

      const input = page.locator('[role="combobox"]');
      await input.click();
      await input.fill('Tautog');
      await page.locator('[role="option"]').first().waitFor();
      await page.locator('[role="option"]').first().click();
      await page.waitForTimeout(150);
      await page.locator('button:visible').filter({ hasText: /continue/i }).first().click();
      await page.waitForTimeout(250);

      await revenueShown(page);

      const spills = await page.evaluate(() => {
        // Start above the field — see the note on the finder's sweep.
        let card = document.querySelector('[name="first_name"]').parentElement;
        while (card && card !== document.body) {
          const c = getComputedStyle(card);
          if (c.backgroundColor === 'rgb(255, 255, 255)'
              && parseFloat(c.paddingLeft) >= 16) break;
          card = card.parentElement;
        }
        const cs = getComputedStyle(card);
        const box = card.getBoundingClientRect();
        const left = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        const right = box.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        const out = [];
        for (const el of card.querySelectorAll('*')) {
          const st = getComputedStyle(el);
          if (st.position === 'absolute' || st.position === 'fixed') continue;
          if (!el.getClientRects().length) continue;
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          if (r.right <= 0) continue;
          if (r.right > right + 1 || r.left < left - 1) {
            out.push((el.id || el.className || el.tagName) + ' by ' +
                     Math.round(Math.max(r.right - right, left - r.left)) + 'px');
          }
        }
        return out;
      });
      expect(spills).toEqual([]);
    });
}

// The whole card is the target, not the words in it. A thumb landing in the
// padding has to count, and each card has to be big enough to hit.
test('the whole range card is tappable, corner to corner', async ({ page }) => {
  await open(page, 'prospect', HTML_REV);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);

  const card = page.locator('input[value="300k_1m"]').locator('..');
  const box = await card.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);   // Apple's floor

  // top-left of the card, well clear of the text
  await page.mouse.click(box.x + 4, box.y + 4);
  await expect(page.locator('input[value="300k_1m"]')).toBeChecked();
});

// Picking one has to release the last, or two ranges reach Default at once.
test('the ranges are one question, not three checkboxes', async ({ page }) => {
  await open(page, 'prospect', HTML_REV);
  await pickRestaurant(page, 'Tautog');
  await continueToStep2(page);

  await pickRevenue(page, 'under_300k');
  await pickRevenue(page, '1m_plus');
  expect(await page.locator(REVENUE + ':checked').count()).toBe(1);
  await expect(page.locator('input[value="1m_plus"]')).toBeChecked();
});

// A phone shows the label row's two halves stacked; a laptop shows them on one
// line. Both have to stay inside the card, and neither may clip the hint.
test('the revenue label and its qualifier share a row on desktop and stack on a phone',
  async ({ page }) => {
    const rows = async () => page.evaluate(() => {
      const sel = document.querySelector('input[name="annual_revenue"]');
      const row = sel.closest('fieldset').previousElementSibling;
      const kids = [...row.children].map((e) => e.getBoundingClientRect());
      return { sameLine: Math.abs(kids[0].top - kids[1].top) < 6,
               overflows: kids.some((r) => r.right > row.getBoundingClientRect().right + 1) };
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, 'prospect', HTML_REV);
    await pickRestaurant(page, 'Tautog');
    await continueToStep2(page);
    expect(await rows()).toEqual({ sameLine: true, overflows: false });

    await page.setViewportSize({ width: 320, height: 900 });
    await page.waitForTimeout(150);
    expect(await rows()).toEqual({ sameLine: false, overflows: false });
  });

/* Arriving at the last step with the first question already answered for them,
   the form picks up at the first empty field below it. With revenue on that is
   the range — landing on the name instead would scroll a required field off
   the top and save the discovery for the submit button. */
test('landing on the details step does not skip past the range', async ({ page }) => {
  await open(page, 'prospect', HTML_REV);
  const input = page.locator('[role="combobox"]');
  await input.click();
  await input.fill('Somewhere Brand New');
  const notListed = page.getByRole('option', { name: /isn.t listed yet/i });
  await notListed.waitFor({ state: 'visible' });
  await notListed.click();
  // "not listed" pre-selects brand-new, which is what makes the step pick a
  // field to focus at all.
  await expect(page.locator('input[value="brand_new_opening"]')).toBeChecked();
  await clickContinue(page);
  await revenueShown(page);
  await page.waitForTimeout(200);

  // Nothing takes focus while the range is unanswered: focusing one of three
  // radios would be a claim about which, and jumping to the name would scroll
  // a required question off the top of a phone.
  expect(await page.evaluate(() => document.activeElement.tagName)).toBe('BODY');

  // Answered, it hands focus on to the name the way it always did.
  await pickRevenue(page, 'under_300k');
  await page.getByRole('button', { name: /back/i }).first().click();
  await clickContinue(page);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.activeElement.name)).toBe('first_name');
});

/* Switching branches has to take the old branch's error with it. A hidden
   field still marked invalid sits earlier in the DOM than the visible one that
   actually failed, so focusFirstInvalid reaches for something that cannot take
   focus and the visitor is left on the submit button with nothing highlighted. */
test('the branch you left does not keep its error', async ({ page }) => {
  await open(page, 'prospect');
  await pickRestaurant(page, 'Just Wing');
  await continueToStep2(page);

  // Fail the prospect branch on purpose: no timeline picked.
  await page.locator('input[name="restaurant_status"]:checked')
    .evaluate((el) => { el.checked = false; }).catch(() => {});
  await fillContact(page);
  await submit(page);
  expect(await submissions(page)).toHaveLength(0);

  // Back out, come back as a customer, and fail that branch instead.
  await page.getByRole('button', { name: /back/i }).first().click();
  await page.getByRole('button', { name: /back/i }).first().click();
  await page.locator('input[value="current_customer"]').check({ force: true });
  await clickContinue(page);
  await clickContinue(page);
  await page.waitForTimeout(150);
  await submit(page);

  // The only field wearing an error is the one that is actually on screen.
  const invalid = await page.evaluate(() =>
    [...document.querySelectorAll('.is-invalid, [class*="invalid"]')]
      .filter((e) => e.querySelector('input,select'))
      .map((e) => ({ hidden: !e.offsetParent,
                     field: e.querySelector('input,select').name })));
  expect(invalid.filter((f) => f.hidden)).toEqual([]);
  expect(invalid.some((f) => f.field === 'help_topic')).toBe(true);
});

/* Whatever this build says to paste has to be IN the repo, because that is how
   it gets to whoever installs it — they open the file on GitHub and copy it,
   with no clone and no build. The parts were gitignored, so the day the form
   crossed the cap the repo would have held nothing pasteable at all: the build
   deletes embed.html when it splits. */
test('the file the build tells you to paste is committed, not ignored', () => {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const root = path.join(__dirname, '..');

  const candidates = ['webflow/embed.html',
                      'webflow/embed-part1.html', 'webflow/embed-part2.html'];
  // check-ignore exits 1 when nothing matches, which is the passing case, so
  // read the status rather than letting execFileSync throw on success.
  let out = '';
  try {
    out = execFileSync('git', ['check-ignore', '--no-index', ...candidates],
                       { cwd: root, encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;          // 1 = no matches; anything else is real
    out = e.stdout || '';
  }

  expect(out.trim().split('\n').filter(Boolean)).toEqual([]);
});
