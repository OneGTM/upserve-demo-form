/**
 * The partner form, driven through the built embed with Default stubbed.
 * User-facing selectors only, same as form.spec.js.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const { partnerPage } = require('./harness');

const HTML = partnerPage({ leadSource: 'Partner' });
const FLOOR_MS = 3000;

async function open(page, html = HTML) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('input[name="partner_type"]'));
  return Date.now();
}

async function fill(page) {
  await page.getByLabel('First name').fill('Alex');
  await page.getByLabel('Last name').fill('Rivera');
  await page.getByLabel('Business name').fill('Acme Payments');
  await page.getByLabel('Email address').fill('alex@acmepay.com');
  await page.getByLabel('Phone number').fill('3055550142');
  await page.locator('input[name="worked_with_upserve_before"][value="no"]').check({ force: true });
  await page.locator('input[name="partner_type"][value="tech"]').check({ force: true });
  await page.locator('input[name="restaurant_owners_per_month"][value="20_to_50"]').check({ force: true });
}

async function submit(page, openedAt) {
  const wait = FLOOR_MS + 200 - (Date.now() - openedAt);
  if (wait > 0) await page.waitForTimeout(wait);
  await page.getByRole('button', { name: /get started/i }).click();
}

const subs = (page) => page.evaluate(() => window.__submissions);

test('a complete submission reaches Default with every field', async ({ page }) => {
  const t = await open(page);
  await fill(page);
  await submit(page, t);

  await expect(page.getByText(/thanks, alex/i)).toBeVisible();
  const [s] = await subs(page);
  expect(s.form_id).toBe('424242');
  expect(s.fields).toMatchObject({
    first_name: 'Alex',
    last_name: 'Rivera',
    business_name: 'Acme Payments',
    email: 'alex@acmepay.com',
    phone: '(305) 555-0142',
    worked_with_upserve_before: 'no',
    partner_type: 'tech',
    restaurant_owners_per_month: '20_to_50',
    form_type: 'partner',
    phone_e164: '+13055550142',
    email_domain: 'acmepay.com',
    lead_source: 'Partner'
  });
  // hidden fields carry a readable label, not the wire name
  expect(s.labels.phone_e164).toBe('Phone (E.164)');
  expect(s.labels).toMatchObject({
    worked_with_upserve_before: 'Worked with Upserve before',
    partner_type: 'Partner type',
    restaurant_owners_per_month: 'Restaurant owners engaged per month'
  });
});

test('an empty submit flags every required field and sends nothing', async ({ page }) => {
  const t = await open(page);
  await submit(page, t);
  await expect(page.locator('.is-invalid')).toHaveCount(8);
  expect(await subs(page)).toHaveLength(0);
});

test('a filled honeypot shows thanks but sends nothing', async ({ page }) => {
  const t = await open(page);
  await fill(page);
  await page.locator('input[name="company_website_confirm"]').evaluate((el) => { el.value = 'x'; });
  await submit(page, t);
  await expect(page.getByText(/thanks/i)).toBeVisible();
  expect(await subs(page)).toHaveLength(0);
});

test('submitting faster than a person can is trapped', async ({ page }) => {
  await open(page);
  await fill(page);
  await page.getByRole('button', { name: /get started/i }).click();
  await expect(page.getByText(/thanks/i)).toBeVisible();
  expect(await subs(page)).toHaveLength(0);
});

test('the form fits the viewport with no sideways scroll', async ({ page }) => {
  await open(page);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a misspelt email domain is offered a fix, and "Use it" applies it', async ({ page }) => {
  await open(page);
  const email = page.getByLabel('Email address');
  await email.fill('alex@gmial.com');
  await email.blur();
  await expect(page.getByText(/did you mean alex@gmail\.com/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Use it' }).click();
  await expect(email).toHaveValue('alex@gmail.com');
});

test('a typo stops the first submit once, then "No, it\'s right" lets it through', async ({ page }) => {
  const t = await open(page);
  await fill(page);
  await page.getByLabel('Email address').fill('alex@acmepay.con');
  await submit(page, t);
  await expect(page.getByText(/did you mean alex@acmepay\.com/i).first()).toBeVisible();
  expect(await subs(page)).toHaveLength(0);

  await page.getByRole('button', { name: /no, it.s right/i }).click();
  await page.getByRole('button', { name: /get started/i }).click();
  await expect(page.getByText(/thanks, alex/i)).toBeVisible();
  expect((await subs(page))[0].fields.email).toBe('alex@acmepay.con');
});
