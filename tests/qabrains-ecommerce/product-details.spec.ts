import { test, expect } from '@playwright/test';

const BASE = 'https://practice.qabrains.com/ecommerce';
const EMAIL = 'test@qabrains.com';
const PASSWORD = 'Password123';

test.describe('Product Details', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button.btn-submit.uppercase');
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  });

  test('TC-010: should navigate to product detail page and show product info', async ({ page }) => {
    await page.goto(`${BASE}/product-details?id=1`);
    await expect(page.locator('h1.text-2xl.font-bold')).toContainText('Sample Shirt Name');
    await expect(page.locator('img[alt="Sample Shirt Name"]')).toBeVisible();
    await expect(page.locator('input.w-10')).toHaveValue('1');
    await expect(page.locator('button:has-text("Add to cart")')).toBeVisible();
    await expect(page.locator('button:has-text("Back to Products")')).toBeVisible();
  });

  test('TC-011: should increment and decrement quantity on product detail page', async ({ page }) => {
    await page.goto(`${BASE}/product-details?id=1`);
    const qtyInput = page.locator('input.w-10');
    await expect(qtyInput).toHaveValue('1');

    await page.click('button:has-text("+")');
    await expect(qtyInput).toHaveValue('2');

    await page.click('button:has-text("+")');
    await expect(qtyInput).toHaveValue('3');

    await page.click('button:has-text("−")');
    await expect(qtyInput).toHaveValue('2');
  });

  test('TC-012: should add product to cart from detail page with quantity', async ({ page }) => {
    await page.goto(`${BASE}/product-details?id=1`);
    await page.click('button:has-text("+")'); // qty = 2
    await expect(page.locator('input.w-10')).toHaveValue('2');
    await page.click('button:has-text("Add to cart")');
    // The header badge counts line items, not quantity — assert the cart itself.
    await page.goto(`${BASE}/cart`);
    await expect(page.getByText('Quantity').locator('..')).toContainText('2');
    await expect(page.getByText('Total').locator('..')).toContainText('$99.98');
  });

  test('TC-013: should navigate back to products from detail page', async ({ page }) => {
    await page.goto(`${BASE}/product-details?id=1`);
    await page.click('button:has-text("Back to Products")');
    await expect(page).toHaveURL(/\/ecommerce\/?$/);
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  });

  test('TC-030: should display correct product info for different products', async ({ page }) => {
    const products = [
      { id: 1, name: 'Sample Shirt Name' },
      { id: 2, name: 'Sample Shoe Name' },
      { id: 5, name: 'Sample T-Shirt Name' },
    ];
    for (const p of products) {
      await page.goto(`${BASE}/product-details?id=${p.id}`);
      await expect(page.locator('h1.text-2xl.font-bold')).toContainText(p.name);
    }
  });
});
