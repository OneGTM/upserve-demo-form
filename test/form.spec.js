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

async function open(page) {
  await page.setContent(HTML, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('[role="combobox"]'));
  openedAt.set(page, Date.now());
  // let boot() finish wiring the provider
  await page.waitForTimeout(150);
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
  await page.getByRole('button', { name: /book my demo/i }).click();
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

async function chooseType(page, value = 'Full-service restaurant') {
  await page.selectOption('select[name="business_type"]', value);
}

async function continueToStep2(page) {
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.locator('input[name="first_name"]')).toBeVisible();
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

  await chooseType(page);
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

  await chooseType(page);
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

    await chooseType(page);
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
  await chooseType(page);
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
  await chooseType(page);
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
    await page.clock.install();
    await page.setContent(HTML, { waitUntil: 'load' });
    await page.waitForFunction(() => !!document.querySelector('[role="combobox"]'));
    await page.clock.runFor(200);

    const input = page.locator('[role="combobox"]');
    await input.click();
    await input.fill('Tautog');
    await page.clock.runFor(400);                 // debounce + stubbed lookup
    await page.locator('[role="option"]').first().click();
    await page.clock.runFor(200);                 // place details

    await page.selectOption('select[name="business_type"]', 'Full-service restaurant');
    await page.getByRole('button', { name: /continue/i }).click();
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
  await chooseType(page);
  await continueToStep2(page);
  await page.fill('input[name="email"]', 'joe@gmail');   // no TLD
  await page.locator('input[name="first_name"]').click();  // blur
  await expect(page.getByText(/missing something/i)).toBeVisible();
});

test('a typo is offered a fix, and the submit button is not swallowed',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await chooseType(page);
    await continueToStep2(page);
    await fillContact(page, { email: 'jamie@gmial.com.com' });
    await page.locator('input[name="first_name"]').click();  // blur

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
  await chooseType(page, 'Quick service / fast casual');
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
  await chooseType(page);
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

test('step 1 will not advance without a business type', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.locator('input[name="first_name"]')).toHaveCount(1);
  await expect(page.locator('input[name="first_name"]')).not.toBeVisible();
});

/* ── what Default sees ───────────────────────────────────────────────────── */

test('every field arrives under a readable label, never a raw slug',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await chooseType(page);
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
  await chooseType(page);
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

  await pickRestaurant(page, 'Tautog');
  await chooseType(page);
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
  await chooseType(page);
  await continueToStep2(page);
  await fillContact(page);
  await submit(page);

  await expect.poll(() => submissions(page).then((s) => s.length)).toBe(1);
  const fired = await events(page);
  expect(fired).toEqual(expect.arrayContaining([
    'usv_form_step1_view', 'usv_form_place_selected',
    'usv_form_step2_view', 'usv_form_submit'
  ]));
  expect(fired.indexOf('usv_form_step1_view'))
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
    await chooseType(page);
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

    await chooseType(page);
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
    await chooseType(page);
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
  await chooseType(page);
  await continueToStep2(page);

  await page.fill('input[name="email"]', 'joe@gmail.c');
  await page.locator('input[name="first_name"]').click();
  await expect(page.getByText(/missing something/i)).toBeVisible();
});

test('a legitimate multi-part domain is accepted', async ({ page }) => {
  await open(page);
  await pickRestaurant(page, 'Tautog');
  await chooseType(page);
  await continueToStep2(page);

  await page.fill('input[name="email"]', 'chef@my-diner.co.uk');
  await page.locator('input[name="first_name"]').click();
  await expect(page.getByText(/missing something/i)).not.toBeVisible();
});

test('each status option carries only its title, not the description too',
  async ({ page }) => {
    await open(page);
    await pickRestaurant(page, 'Tautog');
    await chooseType(page);
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
  await chooseType(page);
  await continueToStep2(page);
  // y=42 lands on the description row, not the title
  await page.locator('[data-status="exploring"]').click({ position: { x: 120, y: 42 } });
  await expect(page.locator('input[value="exploring"]')).toBeChecked();
});
