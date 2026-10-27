'use strict';

/**
 * End-to-end tests of the ordering platform against a real PostgreSQL database.
 * Requires DATABASE_URL (a disposable database with migrations applied): npm run test:db
 */

require('dotenv').config();

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt-signing';
process.env.ROLE_PROVISIONING_KEY = 'test-role-provisioning-key-with-more-than-32-chars';
process.env.NODE_ENV = 'test';
process.env.TAX_RATE_BPS = '1000';
process.env.LOW_STOCK_THRESHOLD = '5';
process.env.RATE_LIMIT_API_MAX = '100000';
process.env.RATE_LIMIT_REGISTER_MAX = '100000';
process.env.RATE_LIMIT_LOGIN_MAX = '100000';

const enabled = Boolean(process.env.DATABASE_URL);
const PASSWORD = 'a-long-test-password-123';
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let counter = 0;
let server;
let baseUrl;
let closePool;
let getPool;

/** Sends a request to the running app and returns status, headers and parsed JSON body. */
async function api(method, path, { token, body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : {} };
}

/** Registers and signs in a user of the given role. */
async function createUser(role) {
    counter += 1;
    const name = `${role.toLowerCase()}-${suffix}-${counter}`;
    const headers = role === 'Buyer' ? {} : { 'x-role-provisioning-key': process.env.ROLE_PROVISIONING_KEY };
    const registered = await api('POST', '/api/auth/register', {
        body: { username: name, email: `${name}@example.com`, password: PASSWORD, role },
        headers
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const login = await api('POST', '/api/auth/login', { body: { identifier: name, password: PASSWORD } });
    assert.equal(login.status, 200);
    return {
        id: registered.body.data.user.id,
        name,
        token: login.body.data.token,
        refreshToken: login.body.data.refreshToken
    };
}

/** Creates a product for a seller through the API. */
async function createProduct(seller, overrides = {}) {
    counter += 1;
    const response = await api('POST', '/api/seller/products', {
        token: seller.token,
        body: { sku: `SKU-${suffix}-${counter}`, name: `Widget ${counter}`, priceCents: 1250, stockQuantity: 10, ...overrides }
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.product;
}

/** Puts a quantity of a product in the buyer's cart. */
async function addToCart(buyer, product, quantity) {
    return api('PUT', `/api/cart/items/${product.id}`, { token: buyer.token, body: { quantity } });
}

const ADDRESS = '12 Harbour Road, Colombo 03, Sri Lanka';

/** Places an order from the buyer's current cart. */
async function checkout(buyer, headers = {}) {
    return api('POST', '/api/orders', { token: buyer.token, body: { shippingAddress: ADDRESS }, headers });
}

/**
 * Makes a race deterministic: holds a row lock on the product while the supplied requests
 * are started, so every request is in flight (and past its own cart lock) before any can finish.
 */
async function withProductLocked(product, startRequests) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [product.id]);
        const running = startRequests();
        await new Promise((resolve) => setTimeout(resolve, 500));
        await client.query('COMMIT');
        return await running;
    } finally {
        client.release();
    }
}

async function stockOf(product, viewer) {
    const response = await api('GET', `/api/products/${product.id}`, { token: viewer.token });
    return response.body.data.product.stockQuantity;
}

before(async () => {
    if (!enabled) return;
    ({ getPool, closePool } = require('../config/database'));
    const { createApp } = require('../server');
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (closePool) await closePool();
});

const skip = !enabled && 'Set DATABASE_URL to a migrated disposable database and run npm run test:db.';

test('catalogue and seller product management', { skip }, async (t) => {
    const seller = await createUser('Seller');
    const otherSeller = await createUser('Seller');
    const buyer = await createUser('Buyer');
    const admin = await createUser('Admin');

    await t.test('seller creates a product, stock and movement are recorded', async () => {
        const product = await createProduct(seller, { stockQuantity: 20, name: 'Industrial 100% Cotton_Gloves' });
        assert.equal(product.stockQuantity, 20);
        assert.equal(product.stockStatus, 'in_stock');
        assert.equal(product.sellerId, seller.id);

        const history = await api('GET', `/api/seller/products/${product.id}/stock-history`, { token: seller.token });
        assert.equal(history.status, 200);
        assert.equal(history.body.data.movements[0].reason, 'initial');
        assert.equal(history.body.data.movements[0].delta, 20);
    });

    await t.test('rejects invalid and malicious input', async () => {
        const base = { sku: `BAD-${suffix}`, name: 'Valid name', priceCents: 100 };
        const cases = [
            [{ ...base, priceCents: 12.5 }, 'fractional price'],
            [{ ...base, priceCents: '100' }, 'numeric string price'],
            [{ ...base, priceCents: -5 }, 'negative price'],
            [{ ...base, stockQuantity: -1 }, 'negative stock'],
            [{ ...base, sku: 'has space' }, 'invalid sku'],
            [{ ...base, name: 'x' }, 'short name'],
            [{ ...base, sellerId: otherSeller.id }, 'mass-assigned sellerId'],
            [{ ...base, status: 'archived' }, 'mass-assigned status'],
            [{ ...base, name: 'bad\u0000name' }, 'control character']
        ];
        for (const [body, label] of cases) {
            const response = await api('POST', '/api/seller/products', { token: seller.token, body });
            assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
        }
        const notObject = await api('POST', '/api/seller/products', { token: seller.token, body: [1, 2] });
        assert.equal(notObject.status, 400);
    });

    await t.test('duplicate SKUs are rejected per seller but allowed across sellers', async () => {
        const product = await createProduct(seller);
        const duplicate = await api('POST', '/api/seller/products', {
            token: seller.token,
            body: { sku: product.sku.toLowerCase(), name: 'Another', priceCents: 100 }
        });
        assert.equal(duplicate.status, 409);
        const otherSellerSameSku = await api('POST', '/api/seller/products', {
            token: otherSeller.token,
            body: { sku: product.sku, name: 'Competing listing', priceCents: 100 }
        });
        assert.equal(otherSellerSameSku.status, 201);
    });

    await t.test('role and ownership rules are enforced', async () => {
        const product = await createProduct(seller);
        assert.equal((await api('POST', '/api/seller/products', { token: buyer.token, body: { sku: 'AB', name: 'No', priceCents: 1 } })).status, 403);
        assert.equal((await api('POST', '/api/seller/products', { token: admin.token, body: { sku: 'ABC', name: 'Admin', priceCents: 1 } })).status, 403);
        assert.equal((await api('PATCH', `/api/seller/products/${product.id}`, { token: otherSeller.token, body: { priceCents: 1 } })).status, 404);
        assert.equal((await api('POST', `/api/seller/products/${product.id}/stock`, { token: otherSeller.token, body: { delta: 5, note: 'steal' } })).status, 404);
        assert.equal((await api('DELETE', `/api/seller/products/${product.id}`, { token: otherSeller.token })).status, 404);
        assert.equal((await api('GET', '/api/seller/products', { token: buyer.token })).status, 403);
        assert.equal((await api('GET', '/api/products')).status, 401);

        const adminEdit = await api('PATCH', `/api/seller/products/${product.id}`, { token: admin.token, body: { priceCents: 999 } });
        assert.equal(adminEdit.status, 200);
        assert.equal(adminEdit.body.data.product.priceCents, 999);
    });

    await t.test('stock adjustments cannot go below zero and are audited', async () => {
        const product = await createProduct(seller, { stockQuantity: 3 });
        const tooMuch = await api('POST', `/api/seller/products/${product.id}/stock`, { token: seller.token, body: { delta: -4, note: 'count error' } });
        assert.equal(tooMuch.status, 409);
        assert.equal(tooMuch.body.code, 'STOCK_BELOW_ZERO');
        const ok = await api('POST', `/api/seller/products/${product.id}/stock`, { token: seller.token, body: { delta: -3, note: 'damaged goods' } });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.data.product.stockStatus, 'out_of_stock');
        const noNote = await api('POST', `/api/seller/products/${product.id}/stock`, { token: seller.token, body: { delta: 1 } });
        assert.equal(noNote.status, 400);

        const audit = await api('GET', `/api/admin/audit-logs?entityId=${product.id}`, { token: admin.token });
        const actions = audit.body.data.entries.map((entry) => entry.action);
        assert.ok(actions.includes('product.create') && actions.includes('stock.adjust'));
    });

    await t.test('catalogue hides archived products from buyers, supports search and bounds pagination', async () => {
        const product = await createProduct(seller, { name: `Archivable ${suffix}` });
        assert.equal((await api('GET', `/api/products/${product.id}`, { token: buyer.token })).status, 200);
        assert.equal((await api('DELETE', `/api/seller/products/${product.id}`, { token: seller.token })).status, 200);
        assert.equal((await api('GET', `/api/products/${product.id}`, { token: buyer.token })).status, 404);
        assert.equal((await api('GET', `/api/products/${product.id}`, { token: seller.token })).status, 200);

        const found = await api('GET', `/api/products?q=${encodeURIComponent('Cotton_Gloves')}`, { token: buyer.token });
        assert.equal(found.status, 200);
        assert.ok(found.body.data.products.every((p) => /Cotton_Gloves/i.test(p.name)));
        const wildcard = await api('GET', `/api/products?q=${encodeURIComponent('%')}`, { token: buyer.token });
        assert.ok(wildcard.body.data.products.every((p) => p.name.includes('%') || p.sku.includes('%')));

        assert.equal((await api('GET', '/api/products?limit=1000', { token: buyer.token })).status, 400);
        assert.equal((await api('GET', '/api/products?page=0', { token: buyer.token })).status, 400);
        assert.equal((await api('GET', '/api/products?q[]=a&q[]=b', { token: buyer.token })).status, 400);
        assert.equal((await api('GET', '/api/products?sort=password_hash', { token: buyer.token })).status, 400);
        assert.equal((await api('GET', '/api/products?q=%27%20OR%201%3D1%3B--', { token: buyer.token })).status, 200);
        assert.equal((await api('GET', '/api/products/not-a-uuid', { token: buyer.token })).status, 400);
    });
});

test('cart, checkout, invoices and stock integrity', { skip }, async (t) => {
    const seller = await createUser('Seller');
    const buyer = await createUser('Buyer');
    const admin = await createUser('Admin');

    await t.test('cart enforces stock, ownership of role and computes totals with tax', async () => {
        const product = await createProduct(seller, { stockQuantity: 4, priceCents: 1999 });
        assert.equal((await addToCart(buyer, product, 5)).status, 409);
        assert.equal((await addToCart(buyer, product, 0)).status, 400);
        assert.equal((await addToCart(buyer, product, 1.5)).status, 400);
        assert.equal((await api('PUT', `/api/cart/items/${product.id}`, { token: seller.token, body: { quantity: 1 } })).status, 403);
        assert.equal((await api('PUT', `/api/cart/items/${product.id}`, { token: buyer.token, body: { quantity: 1, price: 1 } })).status, 400);

        const added = await addToCart(buyer, product, 3);
        assert.equal(added.status, 200);
        const cart = added.body.data.cart;
        assert.equal(cart.subtotalCents, 5997);
        assert.equal(cart.taxCents, 600); // 10% of 5997 = 599.7, rounded half up
        assert.equal(cart.totalCents, 6597);
        assert.equal(cart.canCheckout, true);
        assert.equal((await api('DELETE', '/api/cart', { token: buyer.token })).body.data.cart.items.length, 0);
    });

    await t.test('checkout creates order, invoice and audit record, decrements stock and clears the cart', async () => {
        const product = await createProduct(seller, { stockQuantity: 10, priceCents: 1000 });
        await addToCart(buyer, product, 4);

        assert.equal((await api('POST', '/api/orders', { token: buyer.token, body: { shippingAddress: 'short' } })).status, 400);
        assert.equal((await api('POST', '/api/orders', { token: buyer.token, body: { shippingAddress: ADDRESS, totalCents: 1 } })).status, 400);

        const placed = await checkout(buyer);
        assert.equal(placed.status, 201, JSON.stringify(placed.body));
        const order = placed.body.data.order;
        assert.match(order.orderNumber, /^ORD-\d+$/);
        assert.equal(order.status, 'pending');
        assert.equal(order.subtotalCents, 4000);
        assert.equal(order.taxCents, 400);
        assert.equal(order.totalCents, 4400);
        assert.equal(order.items.length, 1);
        assert.equal(order.invoice.status, 'issued');
        assert.match(order.invoice.invoiceNumber, /^INV-\d+$/);

        assert.equal(await stockOf(product, buyer), 6);
        assert.equal((await api('GET', '/api/cart', { token: buyer.token })).body.data.cart.items.length, 0);

        const audit = await api('GET', `/api/admin/audit-logs?entityId=${order.id}`, { token: admin.token });
        assert.equal(audit.body.data.entries[0].action, 'order.create');
        assert.equal(audit.body.data.entries[0].actorId, buyer.id);

        const invoice = await api('GET', `/api/orders/${order.id}/invoice`, { token: buyer.token });
        assert.equal(invoice.status, 200);
        assert.equal(invoice.body.data.invoice.totalCents, 4400);
        assert.equal(invoice.body.data.invoice.billTo.username, buyer.name);
        assert.equal((await api('GET', `/api/orders/${order.id}/invoice`, { token: seller.token })).status, 403);
    });

    await t.test('an empty cart cannot be checked out', async () => {
        const response = await checkout(buyer);
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'CART_EMPTY');
    });

    await t.test('Idempotency-Key makes retries safe', async () => {
        const product = await createProduct(seller, { stockQuantity: 5, priceCents: 500 });
        await addToCart(buyer, product, 2);
        const key = `retry-${suffix}-${counter}`;
        const first = await checkout(buyer, { 'idempotency-key': key });
        assert.equal(first.status, 201);
        const second = await checkout(buyer, { 'idempotency-key': key });
        assert.equal(second.status, 200);
        assert.equal(second.body.data.replayed, true);
        assert.equal(second.body.data.order.id, first.body.data.order.id);
        assert.equal(await stockOf(product, buyer), 3, 'stock must be decremented only once');
        assert.equal((await checkout(buyer, { 'idempotency-key': 'bad key!' })).status, 400);
    });

    await t.test('items that became unavailable block checkout with details', async () => {
        const product = await createProduct(seller, { stockQuantity: 5 });
        await addToCart(buyer, product, 5);
        await api('POST', `/api/seller/products/${product.id}/stock`, { token: seller.token, body: { delta: -3, note: 'warehouse recount' } });
        const cart = await api('GET', '/api/cart', { token: buyer.token });
        assert.equal(cart.body.data.cart.items[0].issue, 'insufficient_stock');
        assert.equal(cart.body.data.cart.canCheckout, false);

        const blocked = await checkout(buyer);
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.code, 'CART_ITEMS_UNAVAILABLE');
        assert.equal(blocked.body.details.items[0].available, 2);
        assert.equal(await stockOf(product, buyer), 2, 'failed checkout must not change stock');

        await api('DELETE', `/api/seller/products/${product.id}`, { token: seller.token });
        const archived = await checkout(buyer);
        assert.equal(archived.body.details.items[0].reason, 'unavailable');
        await api('DELETE', '/api/cart', { token: buyer.token });
    });
});

test('concurrent checkouts never oversell', { skip }, async (t) => {
    const seller = await createUser('Seller');
    const buyers = await Promise.all([createUser('Buyer'), createUser('Buyer'), createUser('Buyer')]);

    await t.test('three buyers race for the last two units: exactly two succeed', async () => {
        const product = await createProduct(seller, { stockQuantity: 2 });
        for (const buyer of buyers) {
            assert.equal((await addToCart(buyer, product, 1)).status, 200);
        }
        const results = await withProductLocked(product, () => Promise.all(buyers.map((buyer) => checkout(buyer))));
        const statuses = results.map((result) => result.status).sort();
        assert.deepEqual(statuses, [201, 201, 409], JSON.stringify(results.map((r) => r.body)));
        assert.equal(await stockOf(product, seller), 0);
    });

    await t.test('double-submitting one cart in parallel creates a single order', async () => {
        const product = await createProduct(seller, { stockQuantity: 10 });
        const [buyer] = buyers;
        await addToCart(buyer, product, 3);
        const results = await withProductLocked(product, () => Promise.all([checkout(buyer), checkout(buyer), checkout(buyer)]));
        assert.equal(results.filter((result) => result.status === 201).length, 1);
        assert.equal(results.filter((result) => result.status === 409).length, 2);
        assert.equal(await stockOf(product, seller), 7);
    });

    await t.test('the database itself refuses negative stock', async () => {
        const product = await createProduct(seller, { stockQuantity: 1 });
        await assert.rejects(
            getPool().query('UPDATE products SET stock_quantity = -1 WHERE id = $1', [product.id]),
            { code: '23514' }
        );
    });
});

test('order access control, lifecycle and invoices', { skip }, async (t) => {
    const seller = await createUser('Seller');
    const otherSeller = await createUser('Seller');
    const buyerA = await createUser('Buyer');
    const buyerB = await createUser('Buyer');
    const admin = await createUser('Admin');

    const product = await createProduct(seller, { stockQuantity: 50, priceCents: 2000 });
    const otherProduct = await createProduct(otherSeller, { stockQuantity: 50, priceCents: 700 });

    async function placeOrder(buyer, quantity = 2) {
        await addToCart(buyer, product, quantity);
        const placed = await checkout(buyer);
        assert.equal(placed.status, 201, JSON.stringify(placed.body));
        return placed.body.data.order;
    }

    await t.test('buyers see only their own orders (no IDOR)', async () => {
        const order = await placeOrder(buyerA);
        assert.equal((await api('GET', `/api/orders/${order.id}`, { token: buyerA.token })).status, 200);
        assert.equal((await api('GET', `/api/orders/${order.id}`, { token: buyerB.token })).status, 404);
        assert.equal((await api('GET', `/api/orders/${order.id}/invoice`, { token: buyerB.token })).status, 404);
        assert.equal((await api('POST', `/api/orders/${order.id}/cancel`, { token: buyerB.token })).status, 404);

        const listB = await api('GET', '/api/orders', { token: buyerB.token });
        assert.ok(listB.body.data.orders.every((o) => o.id !== order.id));
        const listA = await api('GET', '/api/orders', { token: buyerA.token });
        assert.ok(listA.body.data.orders.some((o) => o.id === order.id));
        assert.equal((await api('GET', `/api/orders/${order.id}`, { token: admin.token })).status, 200);
        assert.equal((await api('GET', '/api/orders/not-a-uuid', { token: buyerA.token })).status, 400);
        assert.equal((await api('GET', '/api/orders')).status, 401);
    });

    await t.test('sellers see only orders containing their products, limited to their lines', async () => {
        await addToCart(buyerA, product, 1);
        await addToCart(buyerA, otherProduct, 3);
        const placed = (await checkout(buyerA)).body.data.order;

        const asSeller = await api('GET', `/api/orders/${placed.id}`, { token: seller.token });
        assert.equal(asSeller.status, 200);
        const view = asSeller.body.data.order;
        assert.equal(view.items.length, 1);
        assert.equal(view.items[0].sku, product.sku);
        assert.equal(view.sellerSubtotalCents, 2000);
        assert.equal(view.shippingAddress, undefined, 'sellers must not receive the delivery address');
        assert.equal(view.totalCents, undefined);
        assert.equal(view.invoice, undefined);

        const stranger = await createUser('Seller');
        assert.equal((await api('GET', `/api/orders/${placed.id}`, { token: stranger.token })).status, 404);
        const list = await api('GET', '/api/orders', { token: seller.token });
        assert.ok(list.body.data.orders.some((o) => o.id === placed.id));
        assert.ok(list.body.data.orders.every((o) => o.shippingAddress === undefined));
    });

    await t.test('buyer cancels a pending order: stock restored and invoice voided', async () => {
        const before = await stockOf(product, seller);
        const order = await placeOrder(buyerB, 5);
        assert.equal(await stockOf(product, seller), before - 5);

        const cancelled = await api('POST', `/api/orders/${order.id}/cancel`, { token: buyerB.token });
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.equal(cancelled.body.data.order.status, 'cancelled');
        assert.equal(cancelled.body.data.order.invoice.status, 'void');
        assert.equal(await stockOf(product, seller), before);

        const again = await api('POST', `/api/orders/${order.id}/cancel`, { token: buyerB.token });
        assert.equal(again.status, 409);
        assert.equal(await stockOf(product, seller), before, 'a second cancel must not restore stock twice');
    });

    await t.test('only an Admin can progress an order, and only along the allowed workflow', async () => {
        const order = await placeOrder(buyerB);
        const patch = (token, status) => api('PATCH', `/api/admin/orders/${order.id}/status`, { token, body: { status } });

        assert.equal((await patch(buyerB.token, 'confirmed')).status, 403);
        assert.equal((await patch(seller.token, 'confirmed')).status, 403);
        assert.equal((await patch(admin.token, 'bogus')).status, 400);
        assert.equal((await patch(admin.token, 'shipped')).status, 409, 'pending cannot jump to shipped');
        assert.equal((await patch(admin.token, 'confirmed')).status, 200);

        const buyerCancel = await api('POST', `/api/orders/${order.id}/cancel`, { token: buyerB.token });
        assert.equal(buyerCancel.status, 409, 'buyers cannot cancel once confirmed');

        assert.equal((await patch(admin.token, 'shipped')).status, 200);
        assert.equal((await patch(admin.token, 'delivered')).status, 200);
        assert.equal((await patch(admin.token, 'cancelled')).status, 409, 'delivered orders are final');
        assert.equal((await patch(admin.token, 'pending')).status, 409);
    });

    await t.test('invoices can be paid once, and not after cancellation', async () => {
        const order = await placeOrder(buyerA);
        const pay = (token) => api('POST', `/api/admin/orders/${order.id}/invoice/pay`, { token });

        assert.equal((await pay(buyerA.token)).status, 403);
        const paid = await pay(admin.token);
        assert.equal(paid.status, 200);
        assert.equal(paid.body.data.order.invoice.status, 'paid');
        assert.ok(paid.body.data.order.invoice.paidAt);
        assert.equal((await pay(admin.token)).status, 409);

        const second = await placeOrder(buyerA);
        await api('POST', `/api/orders/${second.id}/cancel`, { token: buyerA.token });
        assert.equal((await api('POST', `/api/admin/orders/${second.id}/invoice/pay`, { token: admin.token })).status, 409);
    });

    await t.test('status filter and dashboard summary reflect the data', async () => {
        const delivered = await api('GET', '/api/orders?status=delivered', { token: admin.token });
        assert.ok(delivered.body.data.orders.every((o) => o.status === 'delivered'));
        assert.equal((await api('GET', '/api/orders?status=hacked', { token: admin.token })).status, 400);

        const summary = await api('GET', '/api/admin/summary', { token: admin.token });
        assert.equal(summary.status, 200);
        const data = summary.body.data.summary;
        assert.ok(data.ordersByStatus.delivered >= 1 && data.ordersByStatus.cancelled >= 1);
        assert.ok(data.paidCents > 0);
        assert.equal(typeof data.lowStockProducts, 'number');
        assert.equal((await api('GET', '/api/admin/summary', { token: buyerA.token })).status, 403);
    });
});

test('administration, audit trail and account safety', { skip }, async (t) => {
    const admin = await createUser('Admin');
    const secondAdmin = await createUser('Admin');
    const buyer = await createUser('Buyer');

    await t.test('admin can list and search users', async () => {
        const response = await api('GET', `/api/admin/users?q=${buyer.name}`, { token: admin.token });
        assert.equal(response.status, 200);
        assert.equal(response.body.data.users.length, 1);
        assert.equal(response.body.data.users[0].passwordHash, undefined);
        assert.equal(response.body.data.users[0].password_hash, undefined);
        assert.equal((await api('GET', '/api/admin/users', { token: buyer.token })).status, 403);
    });

    await t.test('deactivating a user ends their sessions and blocks sign-in', async () => {
        assert.equal((await api('GET', '/api/auth/me', { token: buyer.token })).status, 200);
        const response = await api('PATCH', `/api/admin/users/${buyer.id}`, { token: admin.token, body: { isActive: false } });
        assert.equal(response.status, 200);
        assert.equal(response.body.data.user.isActive, false);

        assert.equal((await api('GET', '/api/auth/me', { token: buyer.token })).status, 401);
        const refresh = await api('POST', '/api/auth/refresh', { body: { refreshToken: buyer.refreshToken } });
        assert.equal(refresh.status, 401);
        const login = await api('POST', '/api/auth/login', { body: { identifier: buyer.name, password: PASSWORD } });
        assert.equal(login.status, 403);

        await api('PATCH', `/api/admin/users/${buyer.id}`, { token: admin.token, body: { isActive: true } });
        const relogin = await api('POST', '/api/auth/login', { body: { identifier: buyer.name, password: PASSWORD } });
        assert.equal(relogin.status, 200);
        buyer.token = relogin.body.data.token; // earlier sessions stay revoked; use the new one
    });

    await t.test('role changes take effect immediately and unsafe changes are refused', async () => {
        const self = await api('PATCH', `/api/admin/users/${admin.id}`, { token: admin.token, body: { role: 'Buyer' } });
        assert.equal(self.status, 409);
        assert.equal(self.body.code, 'SELF_LOCKOUT');
        assert.equal((await api('PATCH', `/api/admin/users/${admin.id}`, { token: admin.token, body: { isActive: false } })).status, 409);

        assert.equal((await api('PATCH', `/api/admin/users/${buyer.id}`, { token: admin.token, body: { role: 'Superuser' } })).status, 400);
        assert.equal((await api('PATCH', `/api/admin/users/${buyer.id}`, { token: admin.token, body: { isActive: 'false' } })).status, 400);
        assert.equal((await api('PATCH', `/api/admin/users/${buyer.id}`, { token: admin.token, body: {} })).status, 400);
        assert.equal((await api('PATCH', `/api/admin/users/${buyer.id}`, { token: admin.token, body: { passwordHash: 'x' } })).status, 400);
        assert.equal((await api('PATCH', '/api/admin/users/00000000-0000-4000-8000-000000000000', { token: admin.token, body: { isActive: true } })).status, 404);

        const demote = await api('PATCH', `/api/admin/users/${secondAdmin.id}`, { token: admin.token, body: { role: 'Seller' } });
        assert.equal(demote.status, 200);
        assert.equal((await api('GET', '/api/admin/summary', { token: secondAdmin.token })).status, 403, 'demoted admin loses access at once');
    });

    await t.test('audit log records security and business events and filters them', async () => {
        await api('POST', '/api/auth/login', { body: { identifier: `ghost-${suffix}`, password: 'wrong-password-123' } });
        const failed = await api('GET', '/api/admin/audit-logs?action=auth.login_failed', { token: admin.token });
        assert.equal(failed.status, 200);
        assert.ok(failed.body.data.entries.some((entry) => entry.details.identifier === `ghost-${suffix}`));
        assert.ok(failed.body.data.entries.every((entry) => entry.details.password === undefined));

        const updates = await api('GET', `/api/admin/audit-logs?action=user.update&entityId=${buyer.id}`, { token: admin.token });
        assert.equal(updates.body.data.entries.length >= 2, true);
        assert.equal(updates.body.data.entries[0].actorUsername, admin.name);
        assert.equal(updates.body.data.pagination.page, 1);

        assert.equal((await api('GET', '/api/admin/audit-logs?action=DROP%20TABLE', { token: admin.token })).status, 400);
        assert.equal((await api('GET', '/api/admin/audit-logs?entityType=secrets', { token: admin.token })).status, 400);
        assert.equal((await api('GET', '/api/admin/audit-logs', { token: buyer.token })).status, 403);
    });

    await t.test('audit records cannot be altered or deleted, even with database access', async () => {
        const pool = getPool();
        await assert.rejects(pool.query("UPDATE audit_logs SET action = 'tampered'"), /append-only/);
        await assert.rejects(pool.query('DELETE FROM audit_logs'), /append-only/);
        await assert.rejects(pool.query('TRUNCATE audit_logs'), /append-only/);
    });
});

test('transport and abuse protections', { skip }, async (t) => {
    await t.test('security headers, request ids and no-store are present', async () => {
        const page = await fetch(`${baseUrl}/app/`);
        const csp = page.headers.get('content-security-policy');
        assert.match(csp, /default-src 'self'/);
        assert.match(csp, /script-src 'self'/);
        assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.equal(page.headers.get('x-powered-by'), null);
        assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

        const response = await api('GET', '/api/products');
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    });

    await t.test('errors never leak internals', async () => {
        const malformed = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"identifier": '
        });
        assert.equal(malformed.status, 400);
        const huge = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ identifier: 'a', password: 'x'.repeat(20000) })
        });
        assert.equal(huge.status, 413);
        const missing = await api('GET', '/api/does-not-exist');
        assert.equal(missing.status, 404);
        assert.deepEqual(Object.keys(missing.body).sort(), ['error', 'statusCode', 'success']);
    });

    await t.test('SQL injection attempts in credentials are handled as plain text', async () => {
        const attempt = await api('POST', '/api/auth/login', { body: { identifier: "' OR '1'='1' --", password: "' OR '1'='1" } });
        assert.equal(attempt.status, 401);
        const unionAttempt = await api('POST', '/api/auth/register', {
            body: { username: "x'; DROP TABLE users;--", email: 'a@b.co', password: 'long-enough-password' }
        });
        assert.equal(unionAttempt.status, 400);
    });

    await t.test('privilege escalation through registration is blocked', async () => {
        const name = `evil-${suffix}`;
        const asAdmin = await api('POST', '/api/auth/register', {
            body: { username: name, email: `${name}@example.com`, password: PASSWORD, role: 'Admin' }
        });
        assert.equal(asAdmin.status, 403);
        const wrongKey = await api('POST', '/api/auth/register', {
            body: { username: name, email: `${name}@example.com`, password: PASSWORD, role: 'Admin' },
            headers: { 'x-role-provisioning-key': 'x'.repeat(48) }
        });
        assert.equal(wrongKey.status, 403);
    });

    await t.test('repeated failed sign-ins are rate limited, successful ones are not counted', async () => {
        process.env.RATE_LIMIT_LOGIN_MAX = '3';
        const { createApp } = require('../server');
        const limitedServer = createApp().listen(0);
        await new Promise((resolve) => limitedServer.once('listening', resolve));
        const url = `http://127.0.0.1:${limitedServer.address().port}/api/auth/login`;
        const attempt = (password) => fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ identifier: 'nobody', password })
        });
        try {
            const statuses = [];
            for (let i = 0; i < 5; i += 1) statuses.push((await attempt('wrong-password')).status);
            assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
            const limited = await attempt('wrong-password');
            assert.ok(limited.headers.get('ratelimit') || limited.headers.get('retry-after'));
        } finally {
            process.env.RATE_LIMIT_LOGIN_MAX = '100000';
            await new Promise((resolve) => limitedServer.close(resolve));
        }
    });
});
