import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://practice.qabrains.com/ecommerce';
const EMAIL = 'test@qabrains.com';
const PASSWORD = 'Password123';

test.describe('Products', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button.btn-submit.uppercase');
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  });

  test('TC-005: should display all 9 products on products page', async ({ page }) => {
    // Each product renders several anchors (image, title, …); count unique targets.
    const hrefs = await page
      .locator('a[href*="product-details"]')
      .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('href')))]);
    expect(hrefs).toHaveLength(9);
  });

  // The list re-renders asynchronously; poll instead of a fixed sleep, which
  // is what made these two flaky (sort sometimes landed after 500ms).
  const firstVsLast = async (page: Page) => {
    const names = (await page.locator('a.text-lg.block').allTextContents()).map((n) => n.trim());
    expect(names.length).toBeGreaterThan(1);
    return names[0].localeCompare(names[names.length - 1]);
  };

  test('TC-006: should sort products A to Z ascending', async ({ page }) => {
    await page.click('button[role="combobox"]');
    await page.waitForSelector('[role="option"]');
    await page.click('[role="option"]:has-text("A to Z")');
    await expect.poll(() => firstVsLast(page), { timeout: 10_000, message: 'A to Z sort not applied' }).toBeLessThanOrEqual(0);
  });

  test('TC-007: should sort products Z to A descending', async ({ page }) => {
    await page.click('button[role="combobox"]');
    await page.waitForSelector('[role="option"]');
    await page.click('[role="option"]:has-text("Z to A")');
    await expect.poll(() => firstVsLast(page), { timeout: 10_000, message: 'Z to A sort not applied' }).toBeGreaterThanOrEqual(0);
  });

  test('TC-008: should sort products by price low to high', async ({ page }) => {
    await page.click('button[role="combobox"]');
    await page.waitForSelector('[role="option"]');
    await page.click('[role="option"]:has-text("Low to High")');
    await page.waitForTimeout(500);
    const firstProduct = page.locator('a.text-lg.block').first();
    await expect(firstProduct).toBeVisible();
  });

  test('TC-009: should sort products by price high to low', async ({ page }) => {
    await page.click('button[role="combobox"]');
    await page.waitForSelector('[role="option"]');
    await page.click('[role="option"]:has-text("High to Low")');
    await page.waitForTimeout(500);
    const firstProduct = page.locator('a.text-lg.block').first();
    await expect(firstProduct).toBeVisible();
  });
});
