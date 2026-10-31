# MEMORY.md — ingatan jangka panjang Faray

> Aturan file ini: satu fakta per baris, diawali "- ".
> JANGAN simpan password, API key, token, atau rahasia akun asli di sini.

## Fakta

- saucedemo cart page is at /cart.html with shopping_cart_link, item count badge .shopping_cart_badge, and Checkout/Continue Shopping buttons
- saucedemo checkout steps: step-one (fill name/zip), step-two (overview with items, subtotal, tax, total), finish shows confirmation page
- report rule, all sites: server assigns Verified/Visited only/Planned-Unverified from browser evidence only; never trust model-written status
- coverage rule, all sites: URL-area mapping must be generic (urlMatchesArea + interaction signals), never a hardcoded per-site page list
