import { test, expect } from '@playwright/test';

const BASE = 'https://practice.qabrains.com/ecommerce';
const EMAIL = 'test@qabrains.com';
const PASSWORD = 'Password123';

test.describe('Login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/login`);
  });

  test('TC-001: should login with valid credentials and navigate to products page', async ({ page }) => {
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button.btn-submit.uppercase');
    await expect(page).toHaveURL(/\/ecommerce\/?$/);
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  });

  test('TC-002: should show error for invalid email', async ({ page }) => {
    await page.fill('#email', 'invalid@test.com');
    await page.fill('#password', PASSWORD);
    await page.click('button.btn-submit.uppercase');
    await expect(page).toHaveURL(/\/ecommerce\/login/);
    await expect(page.getByText('Username is incorrect.', { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('TC-003: should show error for invalid password', async ({ page }) => {
    await page.fill('#email', EMAIL);
    await page.fill('#password', 'wrongpass');
    await page.click('button.btn-submit.uppercase');
    await expect(page).toHaveURL(/\/ecommerce\/login/);
    await expect(page.getByText('Password is incorrect.', { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('TC-004: should show error for empty fields', async ({ page }) => {
    await page.click('button.btn-submit.uppercase');
    await expect(page).toHaveURL(/\/ecommerce\/login/);
  });
});
