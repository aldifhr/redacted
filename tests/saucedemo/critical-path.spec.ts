import { test, expect } from '@playwright/test';

const BASE = 'https://www.saucedemo.com';

test.describe('SauceDemo Critical Path', () => {
  test('TC-LOGIN-001: Valid login with standard_user redirects to inventory', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#user-name').fill('standard_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();
    await expect(page).toHaveURL(/inventory\.html/);
    await expect(page.locator('.inventory_item')).toHaveCount(6);
  });

  test('TC-PROD-001: Inventory displays 6 products with add-to-cart buttons', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#user-name').fill('standard_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();
    await expect(page).toHaveURL(/inventory\.html/);
    const items = page.locator('.inventory_item');
    await expect(items).toHaveCount(6);
    const buttons = page.locator('.inventory_item button');
    await expect(buttons).toHaveCount(6);
    for (const btn of await buttons.all()) {
      await expect(btn).toContainText('Add to cart');
    }
  });

  test('TC-PROD-003: Add to cart updates badge and toggles button', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#user-name').fill('standard_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();
    await page.locator('#add-to-cart-sauce-labs-backpack').click();
    await expect(page.locator('.shopping_cart_badge')).toHaveText('1');
    await expect(page.locator('#remove-sauce-labs-backpack')).toBeVisible();
  });

  test('TC-CART-001: Cart page shows added items with quantity and remove option', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#user-name').fill('standard_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();
    await page.locator('#add-to-cart-sauce-labs-backpack').click();
    await page.locator('.shopping_cart_link').click();
    await expect(page).toHaveURL(/cart\.html/);
    await expect(page.locator('.cart_item')).toHaveCount(1);
    await expect(page.locator('.inventory_item_name')).toContainText('Sauce Labs Backpack');
    await expect(page.locator('.cart_quantity')).toHaveText('1');
  });

  test('TC-CHECKOUT-001+002: Full checkout flow completes order', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#user-name').fill('standard_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();

    await page.locator('#add-to-cart-sauce-labs-backpack').click();
    await page.locator('.shopping_cart_link').click();

    await page.locator('#checkout').click();
    await expect(page).toHaveURL(/checkout-step-one\.html/);
    await page.locator('#first-name').fill('John');
    await page.locator('#last-name').fill('Doe');
    await page.locator('#postal-code').fill('12345');
    await page.locator('#continue').click();

    await expect(page).toHaveURL(/checkout-step-two\.html/);
    await expect(page.locator('.cart_item')).toHaveCount(1);
    await expect(page.locator('.summary_subtotal_label')).toBeVisible();
    await expect(page.locator('.summary_tax_label')).toBeVisible();
    await expect(page.locator('.summary_total_label')).toBeVisible();

    await page.locator('#finish').click();
    await expect(page).toHaveURL(/checkout-complete\.html/);
    await expect(page.locator('.complete-header')).toHaveText(/thank you for your order/i);
  });

  test('TC-LOGIN-002: Invalid login shows error', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#user-name').fill('invalid_user');
    await page.locator('#password').fill('wrong_password');
    await page.locator('#login-button').click();
    await expect(page.locator('h3[data-test="error"]')).toBeVisible();
    await expect(page).toHaveURL(BASE + '/');
  });

  test('TC-LOGIN-003: Locked out user cannot login', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#user-name').fill('locked_out_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();
    await expect(page.locator('h3[data-test="error"]')).toBeVisible();
    await expect(page.locator('h3[data-test="error"]')).toContainText('locked out');
  });

  test('TC-CHECKOUT-003: Step one with empty fields shows error', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#user-name').fill('standard_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();
    await page.locator('#add-to-cart-sauce-labs-backpack').click();
    await page.locator('.shopping_cart_link').click();
    await page.locator('#checkout').click();
    await page.locator('#continue').click();
    await expect(page.locator('.error-message-container')).toBeVisible();
    await expect(page.locator('.error-message-container')).toContainText('First Name is required');
  });
});
