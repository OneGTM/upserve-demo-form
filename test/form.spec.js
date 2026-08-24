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
const { page: buildPage } = require('./harness');

const HTML = buildPage();

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** When each page was rendered, so we can respect the real speed floor. */
const openedAt = new WeakMap();

/** Click the Continue that is actually on screen — step 0 and step 1 both have one. */
async function clickContinue(page) {
  await page.locator('button:visible').filter({ hasText: /continue/i }).first().click();
}

/** Open the form and clear the triage step as a prospect. */
async function open(page, visitor = 'prospect') {
  await page.setContent(HTML, { waitUntil: 'load' });
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

/** Business type is required on the finder step, so answer it on the way past. */
async function chooseBusinessType(page, value = "full_service") {
  const sel = page.locator('select[name="business_type"]');
  if (await sel.isVisible()) await sel.selectOption(value);
}

async function continueToStep2(page) {
  await chooseBusinessType(page);
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

    await chooseBusinessType(page);
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
    await expect(page.getByText(/only used to answer your question/i)).toBeVisible();
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
    await expect(page.getByText(/right person/i)).toBeVisible();
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

/* ── business type ───────────────────────────────────────────────────────── */

test('business type is required before the details step', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await clickContinue(page);                       // without answering it
  await expect(page.locator('input[name="first_name"]')).not.toBeVisible();
  await expect(page.getByText(/choose the closest match/i)).toBeVisible();
});

test('business type reaches Default as an option group including Non-restaurant',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await chooseBusinessType(page, 'non_restaurant');
    await clickContinue(page);
    await fillContact(page);
    await submit(page);

    await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
    const { fields, labels, optionsByName } = (await submissions(page))[0];
    expect(fields.business_type).toBe('non_restaurant');
    // the asterisk is part of the label Default already has on file, so this
    // re-attaches to the existing field instead of creating a second one
    expect(labels.business_type).toBe('What kind of business is it?*');
    expect(optionsByName.business_type).toEqual([
      '', 'full_service', 'quick_service', 'fine_dining', 'enterprise', 'non_restaurant'
    ]);
  });
