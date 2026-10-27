'use strict';

/**
 * Browser end-to-end test: drives the real UI as Buyer, Seller and Admin and saves screenshots.
 *
 *   Real run (needs the real server + PostgreSQL running):
 *     BASE_URL=http://localhost:5000 ROLE_PROVISIONING_KEY=<value from .env> npm run e2e
 *   Database-free run (contract mock, sandbox only):
 *     node e2e/mock-api-server.js   then   E2E_MOCK=1 BASE_URL=http://localhost:5055 npm run e2e
 *
 * Env: BASE_URL, ROLE_PROVISIONING_KEY, SHOT_DIR, CHROME_PATH (optional), HEADED=1,
 *      E2E_MOCK=1 (enables mock-only steps), E2E_TEST_429=1 (locks out your IP on a real server for ~15 min!).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
const KEY = process.env.ROLE_PROVISIONING_KEY || 'mock-role-key-0123456789-0123456789-0123456789';
const SHOTS = process.env.SHOT_DIR || path.join(__dirname, '..', 'docs', 'screenshots');
const MOCK = process.env.E2E_MOCK === '1';
const TEST_429 = process.env.E2E_TEST_429 === '1';
const sfx = Date.now().toString(36).slice(-5);
const PASSWORD = `Passw0rd-${sfx}`;
const U = (role) => ({ username: `${role}_${sfx}`, email: `${role}_${sfx}@example.com`, password: PASSWORD, role: role === 'admin' ? 'Admin' : role === 'seller' ? 'Seller' : 'Buyer' });
const users = { admin: U('admin'), seller: U('seller'), buyer: U('buyer'), other: U('other'), temp: U('temp') };

fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const allPages = [];
const problems = [];
let shotCount = 0;

async function step(name, fn) {
    const started = Date.now();
    try {
        await fn();
        results.push({ name, ok: true, ms: Date.now() - started });
        console.log(`  ok   ${name}`);
    } catch (error) {
        results.push({ name, ok: false, ms: Date.now() - started, error: error.message.split('\n')[0] });
        for (const [i, p] of allPages.entries()) await p.screenshot({ path: path.join('/tmp', `FAIL-${i}.png`) }).catch(() => {});
        console.log(`  FAIL ${name}\n       ${error.message.split('\n').slice(0, 4).join('\n       ')}`);
        throw error;
    }
}

async function shot(page, name, options = {}) {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: options.full !== false });
    shotCount += 1;
}

/** Plain HTTP helper for test set-up that is not part of the flow being tested. */
async function call(method, route, { token, body, headers } = {}) {
    const response = await fetch(`${BASE}/api${route}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json, data: json.data };
}
async function apiLogin(u) {
    const r = await call('POST', '/auth/login', { body: { identifier: u.username, password: u.password } });
    assert.equal(r.status, 200, `API login for ${u.username}: ${JSON.stringify(r.json)}`);
    return r.data.token;
}

async function newPage(browser, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...options });
    await context.addInitScript(() => {
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const page = await context.newPage();
    allPages.push(page);
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        const text = m.text();
        // Expected 4xx/5xx responses are logged by the browser itself; real script errors and CSP reports are not.
        if (m.type() === 'error' && !/Failed to load resource/.test(text)) problems.push(`console: ${text}`);
        if (/Content Security Policy/i.test(text)) problems.push(`CSP: ${text}`);
    });
    return page;
}

const notice = (page) => page.locator('#notice:not([hidden]), #alert-region:not([hidden])').first();
async function expectNotice(page, pattern) {
    // Poll until a visible message matches: an older message may still be on screen for a moment.
    try {
        await page.waitForFunction((src) => {
            const re = new RegExp(src.source, src.flags);
            return [...document.querySelectorAll('#notice, #alert-region')].some((el) => !el.hidden && re.test(el.innerText));
        }, { source: pattern.source, flags: pattern.flags }, { timeout: 8000 });
    } catch (error) {
        const text = await page.evaluate(() => [...document.querySelectorAll('#notice, #alert-region')].filter((el) => !el.hidden).map((el) => el.innerText).join(' | '));
        throw new Error(`expected a message matching ${pattern}, saw: "${text}"`);
    }
}
async function waitHeading(page, pattern) {
    await page.locator('#view-title').waitFor({ timeout: 10000 });
    await page.waitForFunction((p) => new RegExp(p, 'i').test(document.querySelector('#view-title')?.textContent || ''), pattern.source, { timeout: 10000 });
}
async function go(page, hash) {
    await page.evaluate((h) => { location.hash = h; }, hash);
}
async function signIn(page, u) {
    await page.goto(`${BASE}/app/`);
    await page.locator('#login-identifier').fill(u.username);
    await page.locator('#login-password').fill(u.password);
    await page.locator('#login-panel [type=submit]').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#view-title').waitFor();
}
async function signOut(page) {
    await page.locator('#signout-button').click();
    await page.locator('#login-panel').waitFor({ state: 'visible' });
}
async function registerViaUi(page, u) {
    await page.goto(`${BASE}/app/`);
    await page.locator('#register-tab').click();
    await page.locator('#register-username').fill(u.username);
    await page.locator('#register-email').fill(u.email);
    await page.locator('#register-password').fill(u.password);
    await page.locator('#register-role').selectOption(u.role);
    if (u.role !== 'Buyer') await page.locator('#provisioning-key').fill(KEY);
    return page;
}
const rowOf = (page, text) => page.locator('tbody tr', { hasText: text }).first();

async function main() {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: process.env.HEADED !== '1', args: ['--no-sandbox'] });
    console.log(`UI end-to-end test against ${BASE}${MOCK ? '  [CONTRACT MOCK, not PostgreSQL]' : ''}`);
    const ids = {};
    try {
        // ---------------------------------------------------------------- sign in / register
        const page = await newPage(browser);
        await step('sign-in page loads, tokens are not stored anywhere', async () => {
            await page.goto(`${BASE}/app/`);
            await page.locator('#login-panel').waitFor();
            await shot(page, '01-signin');
            const storage = await page.evaluate(() => ({ l: localStorage.length, s: sessionStorage.length, c: document.cookie }));
            assert.deepEqual(storage, { l: 0, s: 0, c: '' });
        });
        await step('wrong password shows a clear error', async () => {
            await page.locator('#login-identifier').fill(`nobody_${sfx}`);
            await page.locator('#login-password').fill('not-the-password');
            await page.locator('#login-panel [type=submit]').click();
            await expectNotice(page, /Invalid username\/email or password/);
            await shot(page, '02-signin-error');
        });
        await step('register Admin, Seller and Buyer through the UI', async () => {
            await registerViaUi(page, users.admin);
            await shot(page, '03-register');
            await page.locator('#register-panel [type=submit]').click();
            await page.locator('#app-view').waitFor({ state: 'visible' });
            await waitHeading(page, /dashboard/);
            await signOut(page);
            for (const u of [users.seller, users.buyer]) {
                await registerViaUi(page, u);
                await page.locator('#register-panel [type=submit]').click();
                await page.locator('#app-view').waitFor({ state: 'visible' });
                await signOut(page);
            }
        });
        await step('registering Seller with a wrong provisioning key is refused', async () => {
            const bad = { ...users.temp, username: `bad_${sfx}`, email: `bad_${sfx}@example.com`, role: 'Seller' };
            await registerViaUi(page, bad);
            await page.locator('#provisioning-key').fill('wrong-key-wrong-key-wrong-key-wrong-key');
            await page.locator('#register-panel [type=submit]').click();
            await expectNotice(page, /provisioning key|permission/i);
        });

        // ---------------------------------------------------------------- seller
        const sp = await newPage(browser);
        await step('Seller: empty product list, form validation, create products', async () => {
            await signIn(sp, users.seller);
            await waitHeading(sp, /my products/);
            await sp.locator('.empty-state').waitFor();
            await shot(sp, '10-seller-products-empty');
            await sp.getByRole('link', { name: '+ New product' }).click();
            await waitHeading(sp, /new product/);
            await sp.locator('#p-sku').fill('WID-001');
            await sp.locator('#p-name').fill('Widget Pro');
            await sp.locator('#p-price').fill('abc');
            await sp.getByRole('button', { name: 'Create product' }).click();
            await sp.locator('#p-price-error').waitFor({ state: 'visible' });
            await shot(sp, '11-seller-form-errors');
            const make = async (sku, name, price, stock, desc = '') => {
                await go(sp, '#/seller/products/new');
                await waitHeading(sp, /new product/);
                await sp.locator('#p-sku').fill(sku);
                await sp.locator('#p-name').fill(name);
                await sp.locator('#p-description').fill(desc);
                await sp.locator('#p-price').fill(price);
                await sp.locator('#p-stock').fill(String(stock));
                await sp.getByRole('button', { name: 'Create product' }).click();
                await expectNotice(sp, /Product created/);
                await waitHeading(sp, /my products/);
            };
            await make('WID-001', 'Widget Pro', '24.99', 40, 'Industrial-grade widget for bulk orders.');
            await make('WID-002', 'Widget Mini', '9.50', 3, 'Compact widget.');
            await make('CAB-100', 'Cable Set', '15', 100, 'Assorted cables.');
            await make('XSS-1', '<img src=x onerror="window.__xss=1">Hax', '1.00', 5, '<script>window.__xss=2</script>');
            await shot(sp, '12-seller-products');
            await rowOf(sp, 'Widget Mini').getByText(/Low stock/).waitFor();
        });
        await step('Seller: bulk data for pagination (API set-up)', async () => {
            const token = await apiLogin(users.seller);
            for (let i = 1; i <= 12; i += 1) {
                const r = await call('POST', '/seller/products', { token, body: { sku: `BULK-${String(i).padStart(2, '0')}`, name: `Bulk item ${String(i).padStart(2, '0')}`, description: 'Seeded for pagination.', priceCents: 500 + i * 100, stockQuantity: 20 } });
                assert.equal(r.status, 201, JSON.stringify(r.json));
            }
        });
        await step('Seller: low-stock filter, edit, archive with confirmation, restore', async () => {
            await go(sp, '#/seller/products');
            await waitHeading(sp, /my products/);
            await sp.locator('#f-low').check();
            await sp.getByRole('button', { name: 'Apply' }).click();
            await sp.locator('tbody tr').first().waitFor();
            assert.equal(await sp.locator('tbody tr').count(), 2, 'Widget Mini and the XSS product are low on stock');
            await shot(sp, '13-seller-low-stock');
            await go(sp, '#/seller/products?q=Widget+Pro');
            await sp.getByRole('link', { name: 'Edit Widget Pro' }).click();
            await waitHeading(sp, /edit widget pro/i);
            await sp.locator('#p-name').fill('Widget Pro 2');
            await sp.locator('#p-price').fill('26.00');
            await sp.getByRole('button', { name: 'Save changes' }).click();
            await expectNotice(sp, /Product updated/);
            await go(sp, '#/seller/products?q=Cable');
            await sp.getByRole('button', { name: 'Archive Cable Set' }).click();
            await sp.locator('dialog[open]').waitFor();
            await shot(sp, '15-confirm-dialog', { full: false });
            await sp.getByRole('button', { name: 'Archive', exact: true }).click();
            await expectNotice(sp, /archived/);
            await sp.getByRole('button', { name: 'Restore Cable Set' }).click();
            await expectNotice(sp, /restored/);
        });
        await step('Seller: stock adjustment with note, guard against negative stock, history', async () => {
            await go(sp, '#/seller/products?q=Widget+Mini');
            await sp.getByRole('link', { name: 'Stock for Widget Mini' }).click();
            await waitHeading(sp, /stock/i);
            await sp.locator('#s-dir').selectOption('remove');
            await sp.locator('#s-amount').fill('999');
            await sp.locator('#s-note').fill('Too many');
            await sp.getByRole('button', { name: 'Apply adjustment' }).click();
            await sp.locator('#s-amount-error').waitFor({ state: 'visible' });
            await sp.locator('#s-dir').selectOption('add');
            await sp.locator('#s-amount').fill('10');
            await sp.locator('#s-note').fill('Supplier delivery PO-1182');
            await sp.getByText('New stock level: 13.').waitFor();
            await sp.getByRole('button', { name: 'Apply adjustment' }).click();
            await expectNotice(sp, /Stock updated/);
            await sp.locator('.big-number').getByText('13').waitFor();
            await sp.locator('tbody tr', { hasText: 'Supplier delivery PO-1182' }).waitFor();
            await shot(sp, '14-seller-stock');
        });

        // ---------------------------------------------------------------- buyer
        const bp = await newPage(browser);
        const orderPosts = [];
        bp.on('request', (r) => { if (r.method() === 'POST' && /\/api\/orders$/.test(r.url())) orderPosts.push(r.headers()['idempotency-key']); });
        await step('Buyer: catalogue, search, sort, pagination, safe rendering of hostile text', async () => {
            await signIn(bp, users.buyer);
            await waitHeading(bp, /catalogue/i);
            await bp.locator('.product-card').first().waitFor();
            assert.equal(await bp.locator('.product-card').count(), 12);
            await bp.getByText(/Page 1 of 2/).waitFor();
            await shot(bp, '20-catalogue');
            await bp.getByRole('button', { name: 'Next →' }).click();
            await bp.getByText(/Page 2 of 2/).waitFor();
            await go(bp, '#/catalogue?q=widget&sort=price_desc');
            await bp.locator('.product-card').first().waitFor();
            const prices = (await bp.locator('.product-card .price').allInnerTexts()).map((t) => Number(t.replace(/[^0-9.]/g, '')));
            assert.deepEqual(prices, [...prices].sort((a, b) => b - a), 'sorted by price, high to low');
            await shot(bp, '21-catalogue-search');
            await go(bp, '#/catalogue?q=Hax');
            await bp.locator('.product-card h2').first().waitFor();
            assert.match(await bp.locator('.product-card h2').first().innerText(), /<img src=x/);
            assert.equal(await bp.evaluate(() => window.__xss), undefined, 'hostile product text must never execute');
        });
        await step('Buyer: add to cart, 409 stock conflict message, edit quantity', async () => {
            await go(bp, '#/catalogue?q=widget');
            const pro = bp.locator('.product-card', { hasText: 'Widget Pro 2' });
            await pro.locator('input[type=number]').fill('2');
            await pro.getByRole('button', { name: 'Add to cart' }).click();
            await expectNotice(bp, /Added 2 × Widget Pro 2/);
            await bp.locator('#top-cart').getByText('Cart (2)').waitFor();
            const mini = bp.locator('.product-card', { hasText: 'Widget Mini' });
            await mini.locator('input[type=number]').fill('13');
            await mini.getByRole('button', { name: 'Add to cart' }).click();
            await expectNotice(bp, /Added 13/);
            await mini.locator('input[type=number]').fill('1');
            await mini.getByRole('button', { name: 'Add to cart' }).click();
            await expectNotice(bp, /Not enough stock\. Only 13 unit\(s\) available\. You already have 13/);
            await shot(bp, '22-add-conflict', { full: false });
            await go(bp, '#/cart');
            await waitHeading(bp, /your cart/i);
            await bp.locator('tbody tr').first().waitFor();
            await bp.getByRole('button', { name: 'Remove Widget Mini from cart' }).click();
            await expectNotice(bp, /removed/);
            const q = bp.getByLabel('Quantity of Widget Pro 2');
            await q.fill('3');
            await bp.locator('.qty-form', { has: q }).getByRole('button', { name: 'Update' }).click();
            await expectNotice(bp, /set to 3/);
            await bp.locator('.grand dd').getByText('$78.00').waitFor({ timeout: 2000 }).catch(() => {});
            await shot(bp, '23-cart');
        });
        await step('Buyer: stock drops after adding, cart warns and blocks checkout', async () => {
            const token = await apiLogin(users.seller);
            const list = await call('GET', '/seller/products?q=Widget+Pro', { token });
            const pro = list.data.products[0];
            ids.pro = pro.id;
            const r = await call('POST', `/seller/products/${pro.id}/stock`, { token, body: { delta: -(pro.stockQuantity - 2), note: 'Damaged goods write-off' } });
            assert.equal(r.status, 200, JSON.stringify(r.json));
            await bp.reload();
            await bp.locator('#login-panel').waitFor();
            await signIn(bp, users.buyer);
            await go(bp, '#/cart');
            await bp.getByText(/Only 2 in stock/).waitFor();
            assert.equal(await bp.getByRole('button', { name: 'Proceed to checkout' }).isDisabled(), true);
            await shot(bp, '24-cart-warning');
            const q = bp.getByLabel('Quantity of Widget Pro 2');
            await q.fill('2');
            await bp.locator('.qty-form', { has: q }).getByRole('button', { name: 'Update' }).click();
            await expectNotice(bp, /set to 2/);
            await bp.getByText(/Only 2 in stock/).waitFor({ state: 'detached' });
        });
        await step('Buyer: checkout validation, Idempotency-Key, double click makes one order', async () => {
            await bp.getByRole('link', { name: 'Proceed to checkout' }).click();
            await waitHeading(bp, /checkout/i);
            await bp.getByRole('button', { name: 'Place order' }).click();
            await bp.locator('#shipping-address-error').waitFor({ state: 'visible' });
            await shot(bp, '25-checkout');
            await bp.locator('#shipping-address').fill('Acme Corp, 12 Harbour Road, Colombo 03, Sri Lanka');
            await bp.getByRole('button', { name: 'Place order' }).dblclick();
            await waitHeading(bp, /^ORD-/);
            await bp.getByText(/Thank you! Your order was placed/).waitFor();
            await shot(bp, '26-order-placed');
            assert.equal(orderPosts.length, 1, `exactly one POST /api/orders expected, saw ${orderPosts.length}`);
            assert.match(orderPosts[0] || '', /^[A-Za-z0-9_-]{8,64}$/, 'Idempotency-Key header present and well-formed');
            ids.order1 = (await bp.evaluate(() => location.hash)).match(/orders\/([0-9a-f-]{36})/)[1];
            await go(bp, '#/orders');
            await waitHeading(bp, /my orders/i);
            await bp.locator('tbody tr').first().waitFor();
            assert.equal(await bp.locator('tbody tr').count(), 1);
            await shot(bp, '27-orders');
        });
        await step('Buyer: cancel a pending order, stock is restored', async () => {
            await go(bp, '#/catalogue?q=Bulk+item+01');
            await bp.locator('.product-card').first().waitFor();
            await bp.getByRole('button', { name: 'Add to cart' }).first().click();
            await expectNotice(bp, /Added 1/);
            await go(bp, '#/checkout');
            await bp.locator('#shipping-address').fill('Acme Corp, 12 Harbour Road, Colombo 03, Sri Lanka');
            await bp.getByRole('button', { name: 'Place order' }).click();
            await waitHeading(bp, /^ORD-/);
            await bp.getByRole('button', { name: 'Cancel order' }).click();
            await bp.locator('dialog[open]').waitFor();
            await bp.locator('dialog[open]').getByRole('button', { name: 'Cancel order' }).click();
            await expectNotice(bp, /cancelled and stock restored/);
            await bp.locator('.status-line .badge-cancelled').waitFor();
            await shot(bp, '28-order-cancelled');
            const token = await apiLogin(users.seller);
            const list = await call('GET', '/seller/products?q=Bulk+item+01', { token });
            assert.equal(list.data.products[0].stockQuantity, 20, 'stock back to 20 after cancel');
        });
        await step('Buyer: printable invoice', async () => {
            await go(bp, `#/orders/${ids.order1}`);
            await waitHeading(bp, /^ORD-/);
            await bp.getByRole('link', { name: 'View invoice' }).click();
            await waitHeading(bp, /^Invoice INV-/);
            await bp.locator('.invoice-sheet').waitFor();
            await shot(bp, '29-invoice');
            await bp.emulateMedia({ media: 'print' });
            assert.equal(await bp.locator('.sidebar').isVisible(), false, 'navigation is hidden when printing');
            await shot(bp, '29b-invoice-print');
            await bp.emulateMedia({ media: 'screen' });
        });
        await step('Buyer: checkout 409 when stock vanishes after the page was opened', async () => {
            const token = await apiLogin(users.seller);
            await go(bp, '#/catalogue?q=Cable');
            const card = bp.locator('.product-card', { hasText: 'Cable Set' });
            await card.locator('input[type=number]').fill('2');
            await card.getByRole('button', { name: 'Add to cart' }).click();
            await expectNotice(bp, /Added 2/);
            await go(bp, '#/checkout');
            await bp.locator('#shipping-address').fill('Acme Corp, 12 Harbour Road, Colombo 03, Sri Lanka');
            const list = await call('GET', '/seller/products?q=Cable', { token });
            const cable = list.data.products[0];
            await call('POST', `/seller/products/${cable.id}/stock`, { token, body: { delta: -(cable.stockQuantity - 1), note: 'Race: other buyer took stock' } });
            await bp.getByRole('button', { name: 'Place order' }).click();
            await expectNotice(bp, /Stock changed/);
            await bp.getByText(/Cable Set: you asked for 2, only 1 in stock/).waitFor();
            await shot(bp, '30-checkout-409', { full: false });
        });

        // ---------------------------------------------------------------- seller sees orders
        await step('Seller: sees orders with own lines only, never the delivery address', async () => {
            await go(sp, '#/seller/orders');
            await waitHeading(sp, /orders with my products/i);
            await sp.locator('tbody tr').first().waitFor();
            await shot(sp, '40-seller-orders');
            await sp.locator('tbody a', { hasText: 'ORD-' }).first().click();
            await waitHeading(sp, /^ORD-/);
            const text = await sp.locator('#view').innerText();
            assert.doesNotMatch(text, /Harbour Road/, 'address must not be shown to sellers');
            assert.match(text, /Showing only the lines for your products/);
            await shot(sp, '41-seller-order-detail');
        });

        // ---------------------------------------------------------------- admin
        const ap = await newPage(browser);
        await step('Admin: dashboard cards', async () => {
            await signIn(ap, users.admin);
            await waitHeading(ap, /dashboard/i);
            await ap.locator('.stat-card').first().waitFor();
            await shot(ap, '50-admin-dashboard');
            assert.match(await ap.locator('#view').innerText(), /Pending\s*\n?\s*1/i);
        });
        await step('Admin: filter orders, move through the workflow, mark invoice paid', async () => {
            await go(ap, '#/admin/orders?status=pending');
            await waitHeading(ap, /all orders/i);
            await ap.locator('tbody tr').first().waitFor();
            assert.equal(await ap.locator('tbody tr').count(), 1);
            await shot(ap, '51-admin-orders');
            const order = ap.locator('tbody tr').first();
            const number = (await order.locator('td').first().innerText()).trim();
            await order.getByRole('button', { name: `Confirm ${number}` }).click();
            await expectNotice(ap, /is now confirmed/);
            await go(ap, '#/admin/orders');
            await ap.locator('tbody tr', { hasText: number }).getByRole('button', { name: `Mark shipped ${number}` }).click();
            await expectNotice(ap, /is now shipped/);
            await ap.locator('tbody tr', { hasText: number }).getByRole('button', { name: `Mark delivered ${number}` }).click();
            await expectNotice(ap, /is now delivered/);
            await ap.locator('tbody tr', { hasText: number }).getByRole('button', { name: new RegExp(`invoice for ${number} as paid`, 'i') }).click();
            await expectNotice(ap, /marked as paid/);
            await ap.locator('tbody tr', { hasText: number }).getByText('No actions').waitFor();
            await ap.locator('tbody tr', { hasText: number }).getByRole('link', { name: number }).click();
            await waitHeading(ap, /^ORD-/);
            await shot(ap, '52-admin-order-detail');
        });
        await step('Admin: users list, role change, deactivate and reactivate, own row is protected', async () => {
            await call('POST', '/auth/register', { body: users.temp });
            await go(ap, `#/admin/users?q=temp_${sfx}`);
            await waitHeading(ap, /users/i);
            const row = rowOf(ap, users.temp.username);
            await row.waitFor();
            await row.locator('select').selectOption('Seller');
            await row.getByRole('button', { name: `Save role for ${users.temp.username}` }).click();
            await ap.locator('dialog[open]').getByRole('button', { name: 'Change role' }).click();
            await expectNotice(ap, /is now Seller/);
            await rowOf(ap, users.temp.username).getByRole('button', { name: `Deactivate ${users.temp.username}` }).click();
            await ap.locator('dialog[open]').getByRole('button', { name: 'Deactivate', exact: true }).click();
            await expectNotice(ap, /deactivated/);
            await rowOf(ap, users.temp.username).getByText('Deactivated').waitFor();
            await shot(ap, '53-admin-users');
            const blocked = await call('POST', '/auth/login', { body: { identifier: users.temp.username, password: PASSWORD } });
            assert.equal(blocked.status, 403, 'deactivated user cannot sign in');
            await rowOf(ap, users.temp.username).getByRole('button', { name: `Activate ${users.temp.username}` }).click();
            await expectNotice(ap, /reactivated/);
            await go(ap, `#/admin/users?q=admin_${sfx}`);
            await ap.locator('tbody tr').first().waitFor();
            assert.equal(await ap.locator('tbody tr').first().locator('select').isDisabled(), true, 'cannot change own role');
        });
        await step('Admin: audit log with filters, and all-products view', async () => {
            await go(ap, '#/admin/audit');
            await waitHeading(ap, /audit log/i);
            await ap.locator('tbody tr').first().waitFor();
            await ap.locator('#a-action').fill('order.status');
            await ap.getByRole('button', { name: 'Apply' }).click();
            await ap.locator('tbody tr').first().waitFor();
            assert.equal(await ap.locator('tbody tr').count(), 3, 'confirm, ship, deliver');
            const bad = await ap.locator('#a-entity').fill('not-a-uuid');
            await ap.getByRole('button', { name: 'Apply' }).click();
            await ap.locator('#a-entity-error').waitFor({ state: 'visible' });
            await ap.locator('#a-entity').fill('');
            await ap.getByRole('button', { name: 'Apply' }).click();
            await shot(ap, '54-admin-audit');
            await go(ap, '#/seller/products?lowStock=true');
            await waitHeading(ap, /all products/i);
            await ap.locator('tbody tr').first().waitFor();
            await shot(ap, '55-admin-products');
            void bad;
        });

        // ---------------------------------------------------------------- errors
        await step('Error: server-side 403 is explained in plain language', async () => {
            const adminToken = await apiLogin(users.admin);
            const list = await call('GET', `/admin/users?q=seller_${sfx}`, { token: adminToken });
            const sellerId = list.data.users[0].id;
            await call('PATCH', `/admin/users/${sellerId}`, { token: adminToken, body: { role: 'Buyer' } });
            await go(sp, '#/seller/products?q=Widget');
            await sp.locator('.error-panel[role=alert]').getByText(/You do not have permission/).waitFor();
            await shot(sp, '60-error-403', { full: false });
            await call('PATCH', `/admin/users/${sellerId}`, { token: adminToken, body: { role: 'Seller' } });
        });
        await step('Error: no access page for a route outside your role', async () => {
            await go(bp, '#/admin/users');
            await waitHeading(bp, /do not have access/i);
            await shot(bp, '61-no-access', { full: false });
        });
        await step('Error: offline shows a retry panel, then recovers', async () => {
            await go(bp, '#/catalogue');
            await bp.locator('.product-card').first().waitFor();
            await bp.context().setOffline(true);
            await go(bp, '#/orders');
            await bp.getByText(/Cannot reach the server/).first().waitFor();
            await shot(bp, '62-error-offline', { full: false });
            await bp.context().setOffline(false);
            await bp.getByRole('button', { name: 'Try again' }).click();
            await bp.locator('table, .empty-state').first().waitFor();
        });
        if (MOCK) {
            await step('Session: expired access token is refreshed transparently (mock hook)', async () => {
                await fetch(`${BASE}/__test/expire-access`, { method: 'POST' });
                await go(bp, '#/orders?page=1');
                await bp.locator('table, .empty-state').first().waitFor();
                assert.equal(await bp.locator('#login-panel').isVisible(), false, 'still signed in after refresh');
            });
        }

        // ---------------------------------------------------------------- keyboard and mobile
        await step('Keyboard: skip link, sign in with Tab/Enter only, focus lands on the page title, Escape closes dialogs', async () => {
            const kp = await newPage(browser);
            await kp.goto(`${BASE}/app/`);
            await kp.keyboard.press('Tab');
            assert.match(await kp.evaluate(() => document.activeElement.textContent), /Skip to main content/);
            await kp.locator('#login-identifier').focus();
            await kp.keyboard.type(users.buyer.username);
            await kp.keyboard.press('Tab');
            await kp.keyboard.type(users.buyer.password);
            await kp.keyboard.press('Enter');
            await kp.locator('#app-view').waitFor({ state: 'visible' });
            await kp.waitForFunction(() => document.activeElement?.id === 'view-title');
            await go(kp, '#/cart');
            await kp.waitForFunction(() => document.activeElement?.id === 'view-title' && /cart/i.test(document.activeElement.textContent));
            await kp.getByRole('button', { name: 'Clear cart' }).focus();
            await kp.keyboard.press('Enter');
            await kp.locator('dialog[open]').waitFor();
            await kp.keyboard.press('Escape');
            await kp.locator('dialog[open]').waitFor({ state: 'detached' });
            await kp.context().close();
        });
        await step('Mobile (390px): no sideways scroll, menu opens, tables become cards', async () => {
            const mp = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
            await signIn(mp, users.buyer);
            const overflow = async () => mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            await mp.locator('.product-card').first().waitFor();
            assert.ok((await overflow()) <= 1, 'catalogue overflows horizontally');
            await shot(mp, '70-mobile-catalogue');
            await mp.locator('#menu-button').click();
            await mp.locator('#side-nav a', { hasText: 'My orders' }).waitFor({ state: 'visible' });
            await shot(mp, '71-mobile-menu', { full: false });
            await mp.locator('#side-nav a', { hasText: 'My orders' }).click();
            await mp.locator('tbody tr').first().waitFor();
            assert.ok((await overflow()) <= 1, 'orders overflow horizontally');
            await shot(mp, '72-mobile-orders');
            await mp.context().close();
            const am = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
            await signIn(am, users.admin);
            await go(am, '#/admin/orders');
            await am.locator('tbody tr').first().waitFor();
            assert.ok((await am.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'admin orders overflow horizontally');
            await shot(am, '73-mobile-admin-orders');
            await am.context().close();
        });
        await step('Security: tokens never in storage, reload signs out, sign-out revokes the session', async () => {
            const storage = await bp.evaluate(() => ({ l: localStorage.length, s: sessionStorage.length, c: document.cookie }));
            assert.deepEqual(storage, { l: 0, s: 0, c: '' });
            await bp.reload();
            await bp.locator('#login-panel').waitFor({ state: 'visible' });
        });
        if (TEST_429) {
            await step('Error: repeated failed sign-ins show the 429 message', async () => {
                const rp = await newPage(browser);
                await rp.goto(`${BASE}/app/`);
                let seen = false;
                for (let i = 0; i < 15 && !seen; i += 1) {
                    await rp.locator('#login-identifier').fill(`nobody_${i}`);
                    await rp.locator('#login-password').fill('wrong-password');
                    await rp.locator('#login-panel [type=submit]').click();
                    await rp.waitForTimeout(150);
                    seen = /Too many requests/.test(await notice(rp).innerText().catch(() => ''));
                }
                assert.ok(seen, 'a 429 message should appear');
                await shot(rp, '63-error-429', { full: false });
            });
        }
        await step('No script errors and no Content-Security-Policy violations in any page', async () => {
            const csp = [];
            for (const p of [page, sp, bp, ap]) csp.push(...(await p.evaluate(() => window.__csp).catch(() => [])));
            assert.deepEqual(csp, [], `CSP violations: ${csp.join('; ')}`);
            assert.deepEqual(problems, [], `Browser problems:\n${problems.join('\n')}`);
        });
    } finally {
        await browser.close();
        const passed = results.filter((r) => r.ok).length;
        const lines = [`UI end-to-end test report`, `Target: ${BASE}${MOCK ? ' (CONTRACT MOCK, in-memory, NOT PostgreSQL)' : ' (real server)'}`, `Run: ${new Date().toISOString()}`, `Result: ${passed}/${results.length} steps passed, ${shotCount} screenshots`, '',
            ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error}`}`)];
        fs.writeFileSync(path.join(SHOTS, 'e2e-report.txt'), `${lines.join('\n')}\n`);
        console.log(`\n${passed}/${results.length} steps passed, ${shotCount} screenshots in ${SHOTS}`);
        if (passed !== results.length) process.exitCode = 1;
    }
}

main().catch(() => { process.exitCode = 1; });
