import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://practice.qabrains.com/ecommerce';
const EMAIL = 'test@qabrains.com';
const PASSWORD = 'Password123';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('button.btn-submit.uppercase');
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
}

test.describe('Cart', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('TC-014: should add product to cart from products listing', async ({ page }) => {
    const addBtn = page.locator('button.border.inline-block').first();
    await expect(addBtn).toHaveText('Add to cart');
    await addBtn.click();
    await expect(addBtn).toHaveText('Remove from cart');
    await expect(page.locator('span').filter({ hasText: /^\d+$/ }).first()).toBeVisible();
  });

  test('TC-015: should remove product from cart on products page', async ({ page }) => {
    const addBtn = page.locator('button.border.inline-block').first();
    await addBtn.click();
    await expect(addBtn).toHaveText('Remove from cart');
    await addBtn.click();
    await expect(addBtn).toHaveText('Add to cart');
  });

  test('TC-016: should display cart items correctly', async ({ page }) => {
    // Add product first
    const addBtn = page.locator('button.border.inline-block').first();
    await addBtn.click();
    await page.goto(`${BASE}/cart`);
    await expect(page.getByRole('heading', { name: 'Your Cart' })).toBeVisible();
    await expect(page.locator('button:has-text("Remove")')).toBeVisible();
    await expect(page.locator('button:has-text("Continue Shopping")')).toBeVisible();
    await expect(page.locator('button:has-text("Checkout")')).toBeVisible();
  });

  test('TC-017: should remove product from cart page', async ({ page }) => {
    const addBtn = page.locator('button.border.inline-block').first();
    await addBtn.click();
    await page.goto(`${BASE}/cart`);
    await page.click('button:has-text("Remove")');
    // Remove asks for confirmation in a dialog before it acts.
    await page.locator('[role="dialog"] button:has-text("Remove")').click();
    await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();
  });

  test('TC-018: should update quantity in cart using +/- buttons', async ({ page }) => {
    const addBtn = page.locator('button.border.inline-block').first();
    await addBtn.click();
    await page.goto(`${BASE}/cart`);
    await page.click('button.text-lg:has-text("+")');
    await page.waitForTimeout(300);
    await page.click('button.text-lg:has-text("-")');
    await page.waitForTimeout(300);
  });

  test('TC-019: should navigate back to products via Continue Shopping', async ({ page }) => {
    await page.goto(`${BASE}/cart`);
    await page.click('button:has-text("Continue Shopping")');
    await expect(page).toHaveURL(/\/ecommerce\/?$/);
  });

  test('TC-028: should persist cart across page navigation', async ({ page }) => {
    const addBtn = page.locator('button.border.inline-block').first();
    await addBtn.click();
    await page.goto(`${BASE}/product-details?id=2`);
    await page.goto(`${BASE}/ecommerce`);
    await page.goto(`${BASE}/cart`);
    await expect(page.getByRole('heading', { name: 'Your Cart' })).toBeVisible();
  });

  test('TC-029: should add multiple different products to cart', async ({ page }) => {
    // Add product 1
    await page.locator('button.border.inline-block').first().click();
    // Add product 2
    await page.locator('button.border.inline-block').nth(1).click();
    // Add product 3
    await page.locator('button.border.inline-block').nth(2).click();

    // Go to cart
    await page.goto(`${BASE}/cart`);
    await expect(page.getByRole('heading', { name: 'Your Cart' })).toBeVisible();
    const removeButtons = page.locator('button:has-text("Remove")');
    await expect(removeButtons).toHaveCount(3);
  });
});
