/**
 * The content gate, driven through the built embed with Default stubbed.
 * User-facing selectors only, same as form.spec.js.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const { gatePage } = require('./harness');

const HTML = gatePage();
const FLOOR_MS = 3000;

async function open(page, html = HTML) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('input[name="restaurant_name"]'));
  await page.evaluate(() => {
    window.__unlocks = [];
    document.addEventListener('upserve:gate-unlocked', (e) => window.__unlocks.push(e.detail));
  });
  return Date.now();
}

async function fill(page) {
  await page.getByLabel('First name').first().fill('Alex');
  await page.getByLabel('Last name').first().fill('Rivera');
  await page.getByLabel('Work email').fill('alex@harborhg.com');
  await page.getByLabel('Phone', { exact: true }).fill('3055550142');
  await page.getByLabel('Restaurant or group').fill('Harbor Hospitality Group');
}

async function submit(page, openedAt) {
  const wait = FLOOR_MS + 200 - (Date.now() - openedAt);
  if (wait > 0) await page.waitForTimeout(wait);
  await page.getByRole('button', { name: 'Get my results' }).click();
}

const subs = (page) => page.evaluate(() => window.__submissions);
const unlocks = (page) => page.evaluate(() => window.__unlocks);

test('a complete submission reaches Default tagged with the asset, then unlocks', async ({ page }) => {
  const t = await open(page);
  await fill(page);
  await submit(page, t);

  await expect(page.getByText(/thanks, alex\. you.re all set/i)).toBeVisible();
  const [s] = await subs(page);
  expect(s.form_id).toBe('515151');
  expect(s.fields).toMatchObject({
    first_name: 'Alex',
    last_name: 'Rivera',
    email: 'alex@harborhg.com',
    phone: '(305) 555-0142',
    restaurant_name: 'Harbor Hospitality Group',
    form_type: 'content_asset',
    content_asset: 'Guest Value Calculator',
    content_asset_id: 'guest-value-calc-gate',
    lead_source: 'Inbound',
    lead_status_reason: 'Creation',
    country: 'US',
    phone_e164: '+13055550142',
    email_domain: 'harborhg.com',
    asset_details: ''
  });
  expect(s.labels).toMatchObject({
    restaurant_name: 'Restaurant or group',
    content_asset: 'Content asset',
    lead_status_reason: 'Lead status reason'
  });
  expect(s.fields).not.toHaveProperty('company_website_confirm');
  expect(s.fields).toHaveProperty('utm_source', '');
  expect(await unlocks(page)).toEqual([{ asset: 'Guest Value Calculator', id: 'guest-value-calc-gate' }]);
  // the form carries the asset's own id, which Default shows as the HTML form id
  expect(await page.locator('form#guest-value-calc-gate').count()).toBe(1);
});

test('the page can attach details to the lead, and a page that throws still sends', async ({ page }) => {
  let t = await open(page, gatePage({ head: '<script>window.usvGateDetails = function () { return "Total: $41,200/yr"; };</script>' }));
  await fill(page);
  await submit(page, t);
  expect((await subs(page))[0].fields.asset_details).toBe('Total: $41,200/yr');

  t = await open(page, gatePage({ head: '<script>window.usvGateDetails = function () { throw new Error("x"); };</script>' }));
  await fill(page);
  await submit(page, t);
  expect((await subs(page))[0].fields.asset_details).toBe('');
});

test('a page can override the lead source', async ({ page }) => {
  const t = await open(page, gatePage({ attrs: { 'data-upserve-lead-source': 'Paid' } }));
  await fill(page);
  await submit(page, t);
  expect((await subs(page))[0].fields.lead_source).toBe('Paid');
});

test('an empty submit flags all five fields and sends nothing', async ({ page }) => {
  const t = await open(page);
  await submit(page, t);
  await expect(page.locator('.is-invalid')).toHaveCount(5);
  expect(await subs(page)).toHaveLength(0);
  expect(await unlocks(page)).toHaveLength(0);
});

test('a trap unlocks the content but sends nothing', async ({ page }) => {
  await open(page);
  await fill(page);
  await page.getByRole('button', { name: 'Get my results' }).click();   // under the floor
  await expect(page.getByText(/you.re all set/i)).toBeVisible();
  expect(await subs(page)).toHaveLength(0);
  expect(await unlocks(page)).toHaveLength(1);
});

test('a misspelt email is offered a fix once, then goes through as typed', async ({ page }) => {
  const t = await open(page);
  await fill(page);
  await page.getByLabel('Work email').fill('alex@gmial.com');
  await submit(page, t);
  await expect(page.getByText(/did you mean alex@gmail\.com/i).first()).toBeVisible();
  expect(await subs(page)).toHaveLength(0);
  await page.getByRole('button', { name: /no, it.s right/i }).click();
  await page.getByRole('button', { name: 'Get my results' }).click();
  await expect(page.getByText(/you.re all set/i)).toBeVisible();
  expect((await subs(page))[0].fields.email).toBe('alex@gmial.com');
});

test('the form fits the viewport with no sideways scroll', async ({ page }) => {
  await open(page);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe('next to the demo form, as on the calculator page', () => {
  const BOTH = gatePage({ withDemo: true });

  test('no element id appears twice', async ({ page }) => {
    await open(page, BOTH);
    const dupes = await page.evaluate(() => {
      const seen = {}, out = [];
      document.querySelectorAll('[id]').forEach((el) => {
        if (seen[el.id]) out.push(el.id);
        seen[el.id] = 1;
      });
      return out;
    });
    expect(dupes).toEqual([]);
  });

  test('a gate submission leaves the demo form untouched', async ({ page }) => {
    const t = await open(page, BOTH);
    await fill(page);
    await submit(page, t);
    await expect(page.getByText(/thanks, alex\. you.re all set/i)).toBeVisible();
    const s = await subs(page);
    expect(s).toHaveLength(1);
    expect(s[0].fields.form_type).toBe('content_asset');
    // the demo form's callbacks heard Default's success and ignored it
    await page.waitForTimeout(300);
    await expect(page.locator('input[value="prospect"]').locator('..')).toBeVisible();
  });
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  test('all five fields are already in the page', async ({ page }) => {
    await page.setContent(HTML);
    for (const name of ['first_name', 'last_name', 'email', 'phone', 'restaurant_name']) {
      await expect(page.locator('input[name="' + name + '"]')).toBeVisible();
    }
  });
});
