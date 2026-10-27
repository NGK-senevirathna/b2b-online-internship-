'use strict';

/**
 * CONTRACT MOCK of the Section 1 API, held in memory.
 *
 * This is NOT the real backend and NOT PostgreSQL. It exists only so the browser UI can be
 * exercised on a machine that has no database (for example a sandbox). It copies the real
 * routes, response shapes, role rules, status codes and error codes from the controllers.
 * It serves the real frontend/ folder with the same Content-Security-Policy as server.js,
 * so inline script/style mistakes are caught here too.
 *
 * Real evidence = `npm run e2e` against the real server + PostgreSQL (see docs/TEST_EVIDENCE.md).
 */

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('./mini-express');

const ROLE_KEY = process.env.ROLE_PROVISIONING_KEY || 'mock-role-key-0123456789-0123456789-0123456789';
const LOGIN_MAX = Number(process.env.RATE_LIMIT_LOGIN_MAX || 5);
const LOW_STOCK = 5;
const TAX_BPS = Number(process.env.TAX_RATE_BPS || 800);

const db = { users: [], products: [], carts: new Map(), orders: [], invoices: [], movements: [], audit: [], seq: { order: 1000, invoice: 5000, move: 1 } };
const access = new Map(); // token -> userId
const refresh = new Map(); // token -> userId
let failedLogins = 0;

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const err = (status, message, code, details) => Object.assign(new Error(message), { status, code, details });
const ok = (res, message, data, status = 200) => res.status(status).json({ success: true, message, data });

function audit(req, action, entityType, entityId, details = {}) {
    const actor = req.user;
    db.audit.unshift({ id: db.audit.length + 1, action, entityType, entityId: entityId || null, actorId: actor?.id || null,
        actorUsername: actor?.username || null, actorRole: actor?.role || null, details, ipAddress: '127.0.0.1', createdAt: now() });
}
function exact(body, keys) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw err(400, 'A JSON object request body is required.');
    const unknown = Object.keys(body).filter((k) => !keys.includes(k));
    if (unknown.length) throw err(400, `Unknown field(s): ${unknown.join(', ')}.`);
    return body;
}
function paging(query, def = 20, max = 100) {
    const page = Number(query.page || 1); const limit = Number(query.limit || def);
    if (!Number.isInteger(page) || page < 1) throw err(400, 'page must be a whole number of 1 or more.');
    if (!Number.isInteger(limit) || limit < 1 || limit > max) throw err(400, `limit must be between 1 and ${max}.`);
    return { page, limit };
}
function slice(rows, p) {
    return { rows: rows.slice((p.page - 1) * p.limit, p.page * p.limit), pagination: { page: p.page, limit: p.limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / p.limit)) } };
}
const publicUser = (u) => ({ id: u.id, username: u.username, email: u.email, role: u.role });
const sellerName = (p) => db.users.find((u) => u.id === p.sellerId)?.username;
function presentProduct(p) {
    const stockStatus = p.stockQuantity === 0 ? 'out_of_stock' : p.stockQuantity <= LOW_STOCK ? 'low_stock' : 'in_stock';
    return { ...p, sellerName: sellerName(p), stockStatus };
}
const SORTS = { name: (a, b) => a.name.localeCompare(b.name), newest: (a, b) => b.createdAt.localeCompare(a.createdAt), price_asc: (a, b) => a.priceCents - b.priceCents, price_desc: (a, b) => b.priceCents - a.priceCents };
function tax(subtotal) { return Number((BigInt(subtotal) * BigInt(TAX_BPS) + 5000n) / 10000n); }

function buildCart(userId) {
    const lines = db.carts.get(userId) || [];
    const items = lines.map((l) => {
        const p = db.products.find((x) => x.id === l.productId);
        const issue = p.status !== 'active' ? 'unavailable' : l.quantity > p.stockQuantity ? 'insufficient_stock' : null;
        return { productId: p.id, sku: p.sku, name: p.name, unitPriceCents: p.priceCents, quantity: l.quantity, lineTotalCents: p.priceCents * l.quantity, availableQuantity: p.stockQuantity, issue };
    });
    const subtotalCents = items.reduce((s, i) => s + i.lineTotalCents, 0);
    const taxCents = tax(subtotalCents);
    return { items, subtotalCents, taxCents, totalCents: subtotalCents + taxCents, canCheckout: items.length > 0 && items.every((i) => i.issue === null) };
}
function move(product, delta, reason, note, actor, orderId) {
    product.stockQuantity += delta;
    db.movements.unshift({ id: db.seq.move++, productId: product.id, delta, quantityAfter: product.stockQuantity, reason, note: note || null, orderId: orderId || null, actorUsername: actor?.username || null, createdAt: now() });
}
function presentOrder(o, role, sellerId) {
    const inv = db.invoices.find((i) => i.orderId === o.id);
    const allItems = o.items.map(({ sellerId: _s, ...rest }) => rest);
    const base = { id: o.id, orderNumber: o.orderNumber, status: o.status, buyerUsername: db.users.find((u) => u.id === o.buyerId).username, createdAt: o.createdAt, updatedAt: o.updatedAt };
    if (role === 'Seller') {
        const mine = o.items.filter((i) => i.sellerId === sellerId).map(({ sellerId: _s, ...rest }) => rest);
        return { ...base, sellerSubtotalCents: mine.reduce((s, i) => s + i.lineTotalCents, 0), items: mine };
    }
    return { ...base, buyerId: o.buyerId, shippingAddress: o.shippingAddress, subtotalCents: o.subtotalCents, taxCents: o.taxCents, totalCents: o.totalCents,
        invoice: inv ? { id: inv.id, invoiceNumber: inv.invoiceNumber, status: inv.status, issuedAt: inv.issuedAt, dueAt: inv.dueAt, paidAt: inv.paidAt } : null, items: allItems };
}
const TRANSITIONS = { pending: ['confirmed', 'cancelled'], confirmed: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] };
function visibleOrder(user, orderId) {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o) throw err(404, 'Order not found.');
    if (user.role === 'Buyer' && o.buyerId !== user.id) throw err(404, 'Order not found.');
    if (user.role === 'Seller' && !o.items.some((i) => i.sellerId === user.id)) throw err(404, 'Order not found.');
    return o;
}
function cancelOrder(req, o) {
    for (const item of o.items) move(db.products.find((p) => p.id === item.productId), item.quantity, 'order_cancelled', `Order ${o.orderNumber} cancelled`, req.user, o.id);
    const inv = db.invoices.find((i) => i.orderId === o.id); if (inv) inv.status = 'void';
    o.status = 'cancelled'; o.updatedAt = now();
}

function createApp() {
    const app = express();
    // Same Content-Security-Policy as server.js (helmet), so inline scripts/styles fail here too.
    app.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', "default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;connect-src 'self';font-src 'self';object-src 'none';base-uri 'self';form-action 'self';frame-ancestors 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });
    app.use(express.json({ limit: '10kb' }));
    app.use((req, res, next) => { res.setHeader('X-Request-Id', crypto.randomUUID()); if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store'); next(); });
    app.use('/app', express.static(path.join(__dirname, '..', 'frontend'), { index: 'index.html' }));
    app.get('/health/ready', (_req, res) => ok(res, 'Service is ready.', { status: 'ready', database: 'MOCK (in-memory, not PostgreSQL)' }));
    // Test-only hooks (do not exist in the real backend).
    app.post('/__test/expire-access', (_req, res) => { access.clear(); res.json({ ok: true }); });
    app.post('/__test/reset', (_req, res) => { db.users.length = 0; db.products.length = 0; db.carts.clear(); db.orders.length = 0; db.invoices.length = 0; db.movements.length = 0; db.audit.length = 0; failedLogins = 0; res.json({ ok: true }); });

    const wrap = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };
    const auth = (req, _res, next) => {
        try {
            const token = (req.get('authorization') || '').replace(/^Bearer /, '');
            const user = db.users.find((u) => u.id === access.get(token));
            if (!user) throw err(401, 'Invalid or expired access token.');
            if (!user.isActive) throw err(401, 'The account for this session is unavailable.');
            req.user = user;
            next();
        } catch (e) { next(e); }
    };
    const guard = (...roles) => (req, _res, next) => (roles.includes(req.user.role) ? next() : next(err(403, 'Access forbidden: insufficient permissions.')));
    const api = express.Router();
    app.use('/api', api);

    // ---- auth
    api.post('/auth/register', wrap((req, res) => {
        const b = req.body || {};
        if (!/^[A-Za-z0-9_.-]{3,30}$/.test(b.username || '')) throw err(400, 'Username must be 3-30 characters and contain only letters, numbers, dots, underscores, or hyphens.');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) throw err(400, 'A valid email address is required.');
        if (typeof b.password !== 'string' || b.password.length < 8) throw err(400, 'Password must be at least 8 characters and no more than 72 UTF-8 bytes.');
        const role = b.role ?? 'Buyer';
        if (!['Buyer', 'Seller', 'Admin'].includes(role)) throw err(400, 'Role must be Buyer, Seller, or Admin.');
        if (role !== 'Buyer' && req.get('x-role-provisioning-key') !== ROLE_KEY) throw err(403, 'Seller and Admin registration require a valid role-provisioning key.');
        if (db.users.some((u) => u.username.toLowerCase() === b.username.toLowerCase() || u.email.toLowerCase() === b.email.toLowerCase())) throw err(409, 'A user with that username or email already exists.');
        const user = { id: id(), username: b.username, email: b.email, password: b.password, role, isActive: true, createdAt: now() };
        db.users.push(user); req.user = user; audit(req, 'user.register', 'user', user.id, { role });
        ok(res, 'User registered successfully.', { user: publicUser(user) }, 201);
    }));
    api.post('/auth/login', wrap((req, res) => {
        if (failedLogins >= LOGIN_MAX) { res.setHeader('Retry-After', '900'); return res.status(429).json({ success: false, error: 'Too many requests. Please try again later.', statusCode: 429 }); }
        const { identifier, password } = req.body || {};
        if (!identifier || !password) throw err(400, 'A username or email and password are required.');
        const user = db.users.find((u) => u.username.toLowerCase() === String(identifier).toLowerCase() || u.email.toLowerCase() === String(identifier).toLowerCase());
        if (!user || user.password !== password) { failedLogins += 1; throw err(401, 'Invalid username/email or password.'); }
        if (!user.isActive) throw err(403, 'This account has been deactivated. Contact an administrator.');
        const token = crypto.randomBytes(24).toString('hex'); const rt = crypto.randomBytes(24).toString('hex');
        access.set(token, user.id); refresh.set(rt, user.id); req.user = user; audit(req, 'auth.login', 'auth', user.id);
        ok(res, 'Login successful.', { token, tokenType: 'Bearer', expiresIn: '1h', refreshToken: rt, refreshTokenExpiresAt: now(), user: publicUser(user) });
    }));
    api.post('/auth/refresh', wrap((req, res) => {
        const userId = refresh.get(req.body?.refreshToken); const user = db.users.find((u) => u.id === userId);
        if (!user || !user.isActive) throw err(401, 'Invalid or expired refresh token.');
        refresh.delete(req.body.refreshToken);
        const token = crypto.randomBytes(24).toString('hex'); const rt = crypto.randomBytes(24).toString('hex');
        access.set(token, user.id); refresh.set(rt, user.id);
        ok(res, 'Token refreshed successfully.', { token, tokenType: 'Bearer', expiresIn: '1h', refreshToken: rt, refreshTokenExpiresAt: now(), user: publicUser(user) });
    }));
    api.post('/auth/logout', auth, wrap((req, res) => { access.delete((req.get('authorization') || '').replace(/^Bearer /, '')); audit(req, 'auth.logout', 'auth', req.user.id); ok(res, 'Session logged out successfully.', { loggedOut: true }); }));
    api.get('/auth/me', auth, wrap((req, res) => ok(res, 'Authenticated user profile.', { user: publicUser(req.user) })));

    // ---- catalogue
    api.get('/products', auth, wrap((req, res) => {
        const p = paging(req.query); const q = String(req.query.q || '').toLowerCase();
        const sort = req.query.sort || 'name'; if (!SORTS[sort]) throw err(400, 'sort must be one of: name, newest, price_asc, price_desc.');
        let rows = db.products.filter((x) => x.status === 'active' && (!q || x.name.toLowerCase().includes(q) || x.sku.toLowerCase().includes(q)) && (req.query.inStock !== 'true' || x.stockQuantity > 0));
        rows = rows.sort(SORTS[sort]); const s = slice(rows, p);
        ok(res, 'Products retrieved.', { products: s.rows.map(presentProduct), pagination: s.pagination });
    }));
    api.get('/products/:id', auth, wrap((req, res) => {
        const p = db.products.find((x) => x.id === req.params.id);
        if (!p || (p.status === 'archived' && !(req.user.role === 'Admin' || p.sellerId === req.user.id))) throw err(404, 'Product not found.');
        ok(res, 'Product retrieved.', { product: presentProduct(p) });
    }));

    // ---- seller / admin product management
    const seller = express.Router(); api.use('/seller', auth, guard('Seller', 'Admin'), seller);
    const managed = (user, pid) => { const p = db.products.find((x) => x.id === pid); if (!p || (user.role === 'Seller' && p.sellerId !== user.id)) throw err(404, 'Product not found.'); return p; };
    seller.get('/products', wrap((req, res) => {
        const p = paging(req.query); const q = String(req.query.q || '').toLowerCase(); const sort = req.query.sort || 'name';
        let rows = db.products.filter((x) => (req.user.role === 'Admin' || x.sellerId === req.user.id) && (!req.query.status || x.status === req.query.status)
            && (!q || x.name.toLowerCase().includes(q) || x.sku.toLowerCase().includes(q)) && (req.query.lowStock !== 'true' || x.stockQuantity <= LOW_STOCK));
        rows = rows.sort(SORTS[sort] || SORTS.name); const s = slice(rows, p);
        ok(res, 'Products retrieved.', { products: s.rows.map(presentProduct), pagination: s.pagination });
    }));
    seller.post('/products', guard('Seller'), wrap((req, res) => {
        const b = exact(req.body, ['sku', 'name', 'description', 'priceCents', 'stockQuantity']);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/.test(b.sku || '')) throw err(400, 'sku may contain letters, numbers, dots, underscores and hyphens.');
        if (typeof b.name !== 'string' || b.name.trim().length < 2 || b.name.length > 120) throw err(400, 'name must be between 2 and 120 characters.');
        if (!Number.isInteger(b.priceCents) || b.priceCents < 1 || b.priceCents > 100000000) throw err(400, 'priceCents must be a whole number between 1 and 100000000.');
        const stock = b.stockQuantity ?? 0; if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) throw err(400, 'stockQuantity must be a whole number between 0 and 1000000.');
        if (db.products.some((x) => x.sellerId === req.user.id && x.sku.toUpperCase() === b.sku.toUpperCase())) throw err(409, 'You already have a product with this SKU.');
        const p = { id: id(), sellerId: req.user.id, sku: b.sku, name: b.name.trim(), description: b.description || '', priceCents: b.priceCents, stockQuantity: 0, status: 'active', createdAt: now(), updatedAt: now() };
        db.products.push(p); if (stock > 0) move(p, stock, 'initial', 'Opening stock', req.user); audit(req, 'product.create', 'product', p.id, { sku: p.sku });
        ok(res, 'Product created.', { product: presentProduct(p) }, 201);
    }));
    const patch = (req, res, changes) => {
        const p = managed(req.user, req.params.id); const before = p.status; Object.assign(p, changes, { updatedAt: now() });
        audit(req, changes.status === 'archived' && before !== 'archived' ? 'product.archive' : 'product.update', 'product', p.id, changes);
        ok(res, changes.status === 'archived' && !req.body ? 'Product archived.' : 'Product updated.', { product: presentProduct(p) });
    };
    seller.patch('/products/:id', wrap((req, res) => {
        const b = exact(req.body, ['name', 'description', 'priceCents', 'status']); const c = {};
        if (b.name !== undefined) { if (typeof b.name !== 'string' || b.name.trim().length < 2) throw err(400, 'name must be between 2 and 120 characters.'); c.name = b.name.trim(); }
        if (b.description !== undefined) c.description = String(b.description);
        if (b.priceCents !== undefined) { if (!Number.isInteger(b.priceCents) || b.priceCents < 1) throw err(400, 'priceCents must be a whole number of 1 or more.'); c.priceCents = b.priceCents; }
        if (b.status !== undefined) { if (!['active', 'archived'].includes(b.status)) throw err(400, 'status must be one of: active, archived.'); c.status = b.status; }
        if (!Object.keys(c).length) throw err(400, 'Provide at least one field to update.');
        patch(req, res, c);
    }));
    seller.delete('/products/:id', wrap((req, res) => { const p = managed(req.user, req.params.id); p.status = 'archived'; audit(req, 'product.archive', 'product', p.id); ok(res, 'Product archived.', { product: presentProduct(p) }); }));
    seller.post('/products/:id/stock', wrap((req, res) => {
        const p = managed(req.user, req.params.id); const b = exact(req.body, ['delta', 'note']);
        if (!Number.isInteger(b.delta) || b.delta === 0) throw err(400, 'delta must be a non-zero whole number.');
        if (typeof b.note !== 'string' || b.note.trim().length < 3) throw err(400, 'note must be between 3 and 200 characters.');
        if (p.stockQuantity + b.delta < 0) throw err(409, 'Stock cannot go below zero.', 'STOCK_BELOW_ZERO', { available: p.stockQuantity, requestedChange: b.delta });
        move(p, b.delta, 'adjustment', b.note.trim(), req.user); audit(req, 'stock.adjust', 'product', p.id, { delta: b.delta });
        ok(res, 'Stock updated.', { product: presentProduct(p) });
    }));
    seller.get('/products/:id/stock-history', wrap((req, res) => { const p = managed(req.user, req.params.id); ok(res, 'Stock history retrieved.', { movements: db.movements.filter((m) => m.productId === p.id).slice(0, 50).map(({ productId: _p, ...m }) => m) }); }));

    // ---- cart
    const cart = express.Router(); api.use('/cart', auth, guard('Buyer'), cart);
    cart.get('/', wrap((req, res) => ok(res, 'Cart retrieved.', { cart: buildCart(req.user.id) })));
    cart.delete('/', wrap((req, res) => { db.carts.set(req.user.id, []); ok(res, 'Cart cleared.', { cart: buildCart(req.user.id) }); }));
    cart.put('/items/:productId', wrap((req, res) => {
        const b = exact(req.body, ['quantity']);
        if (!Number.isInteger(b.quantity) || b.quantity < 1 || b.quantity > 10000) throw err(400, 'quantity must be a whole number between 1 and 10000.');
        const p = db.products.find((x) => x.id === req.params.productId); if (!p || p.status !== 'active') throw err(404, 'Product not found.');
        if (b.quantity > p.stockQuantity) throw err(409, `Only ${p.stockQuantity} unit(s) of this product are available.`, 'INSUFFICIENT_STOCK', { available: p.stockQuantity });
        const lines = db.carts.get(req.user.id) || []; const line = lines.find((l) => l.productId === p.id);
        if (line) line.quantity = b.quantity; else lines.push({ productId: p.id, quantity: b.quantity }); db.carts.set(req.user.id, lines);
        ok(res, 'Cart updated.', { cart: buildCart(req.user.id) });
    }));
    cart.delete('/items/:productId', wrap((req, res) => { db.carts.set(req.user.id, (db.carts.get(req.user.id) || []).filter((l) => l.productId !== req.params.productId)); ok(res, 'Item removed.', { cart: buildCart(req.user.id) }); }));

    // ---- orders
    const orders = express.Router(); api.use('/orders', auth, orders);
    orders.post('/', guard('Buyer'), wrap((req, res) => {
        const b = exact(req.body, ['shippingAddress']);
        if (typeof b.shippingAddress !== 'string' || b.shippingAddress.trim().length < 10 || b.shippingAddress.length > 500) throw err(400, 'shippingAddress must be between 10 and 500 characters.');
        const key = req.get('idempotency-key');
        if (key !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw err(400, 'Idempotency-Key must be 8-64 characters: letters, numbers, hyphens or underscores.');
        if (key) { const prior = db.orders.find((o) => o.buyerId === req.user.id && o.idempotencyKey === key); if (prior) return ok(res, 'Order already placed with this Idempotency-Key.', { order: presentOrder(prior, 'Buyer'), replayed: true }); }
        const lines = db.carts.get(req.user.id) || []; if (!lines.length) throw err(409, 'Your cart is empty.', 'CART_EMPTY');
        const problems = []; const items = [];
        for (const l of lines) {
            const p = db.products.find((x) => x.id === l.productId);
            if (!p || p.status !== 'active') problems.push({ productId: l.productId, name: p?.name, reason: 'unavailable' });
            else if (l.quantity > p.stockQuantity) problems.push({ productId: p.id, name: p.name, reason: 'insufficient_stock', requested: l.quantity, available: p.stockQuantity });
            else items.push({ productId: p.id, sellerId: p.sellerId, sku: p.sku, name: p.name, unitPriceCents: p.priceCents, quantity: l.quantity, lineTotalCents: p.priceCents * l.quantity });
        }
        if (problems.length) throw err(409, 'Some items in your cart can no longer be ordered.', 'CART_ITEMS_UNAVAILABLE', { items: problems });
        const subtotalCents = items.reduce((s, i) => s + i.lineTotalCents, 0); const taxCents = tax(subtotalCents);
        const o = { id: id(), orderNumber: `ORD-${db.seq.order++}`, buyerId: req.user.id, status: 'pending', shippingAddress: b.shippingAddress.trim(), subtotalCents, taxCents, totalCents: subtotalCents + taxCents, idempotencyKey: key, items, createdAt: now(), updatedAt: now() };
        db.orders.unshift(o);
        for (const i of items) move(db.products.find((p) => p.id === i.productId), -i.quantity, 'order', `Order ${o.orderNumber}`, req.user, o.id);
        const inv = { id: id(), invoiceNumber: `INV-${db.seq.invoice++}`, orderId: o.id, status: 'issued', issuedAt: now(), dueAt: new Date(Date.now() + 30 * 864e5).toISOString(), paidAt: null };
        db.invoices.push(inv); db.carts.set(req.user.id, []); audit(req, 'order.create', 'order', o.id, { orderNumber: o.orderNumber, totalCents: o.totalCents });
        ok(res, 'Order placed.', { order: presentOrder(o, 'Buyer'), replayed: false }, 201);
    }));
    orders.get('/', wrap((req, res) => {
        const p = paging(req.query);
        if (req.query.status && !TRANSITIONS[req.query.status]) throw err(400, 'status must be one of: pending, confirmed, shipped, delivered, cancelled.');
        let rows = db.orders.filter((o) => (!req.query.status || o.status === req.query.status) && (req.user.role === 'Admin' || (req.user.role === 'Buyer' && o.buyerId === req.user.id) || (req.user.role === 'Seller' && o.items.some((i) => i.sellerId === req.user.id))));
        const s = slice(rows, p); ok(res, 'Orders retrieved.', { orders: s.rows.map((o) => presentOrder(o, req.user.role, req.user.id)), pagination: s.pagination });
    }));
    orders.get('/:id', wrap((req, res) => ok(res, 'Order retrieved.', { order: presentOrder(visibleOrder(req.user, req.params.id), req.user.role, req.user.id) })));
    orders.post('/:id/cancel', guard('Buyer'), wrap((req, res) => {
        const o = db.orders.find((x) => x.id === req.params.id); if (!o || o.buyerId !== req.user.id) throw err(404, 'Order not found.');
        if (o.status !== 'pending') throw err(409, 'Only pending orders can be cancelled. Contact an administrator for later stages.', 'NOT_CANCELLABLE');
        cancelOrder(req, o); audit(req, 'order.cancel', 'order', o.id); ok(res, 'Order cancelled and stock restored.', { order: presentOrder(o, 'Buyer') });
    }));
    orders.get('/:id/invoice', wrap((req, res) => {
        if (req.user.role === 'Seller') throw err(403, 'Access forbidden: insufficient permissions.');
        const o = visibleOrder(req.user, req.params.id); const pres = presentOrder(o, req.user.role); const buyer = db.users.find((u) => u.id === o.buyerId);
        ok(res, 'Invoice retrieved.', { invoice: { ...pres.invoice, orderNumber: pres.orderNumber, orderStatus: pres.status, billTo: { username: buyer.username, email: buyer.email, shippingAddress: pres.shippingAddress }, items: pres.items, subtotalCents: pres.subtotalCents, taxCents: pres.taxCents, totalCents: pres.totalCents } });
    }));

    // ---- admin
    const admin = express.Router(); api.use('/admin', auth, guard('Admin'), admin);
    admin.patch('/orders/:id/status', wrap((req, res) => {
        const b = exact(req.body, ['status']); if (!TRANSITIONS[b.status]) throw err(400, 'status must be one of: pending, confirmed, shipped, delivered, cancelled.');
        const o = db.orders.find((x) => x.id === req.params.id); if (!o) throw err(404, 'Order not found.');
        if (!TRANSITIONS[o.status].includes(b.status)) throw err(409, `An order that is ${o.status} cannot become ${b.status}.`, 'INVALID_TRANSITION', { from: o.status, to: b.status, allowed: TRANSITIONS[o.status] });
        const from = o.status; if (b.status === 'cancelled') cancelOrder(req, o); else { o.status = b.status; o.updatedAt = now(); }
        audit(req, 'order.status', 'order', o.id, { from, to: b.status }); ok(res, 'Order status updated.', { order: presentOrder(o, 'Admin') });
    }));
    admin.post('/orders/:id/invoice/pay', wrap((req, res) => {
        const o = db.orders.find((x) => x.id === req.params.id); if (!o) throw err(404, 'Order not found.');
        const inv = db.invoices.find((i) => i.orderId === o.id); if (!inv || inv.status !== 'issued') throw err(409, 'This invoice cannot be marked as paid.', 'INVOICE_NOT_PAYABLE');
        inv.status = 'paid'; inv.paidAt = now(); audit(req, 'invoice.paid', 'invoice', inv.id, { orderNumber: o.orderNumber }); ok(res, 'Invoice marked as paid.', { order: presentOrder(o, 'Admin') });
    }));
    admin.get('/summary', wrap((req, res) => {
        const byStatus = { pending: 0, confirmed: 0, shipped: 0, delivered: 0, cancelled: 0 }; for (const o of db.orders) byStatus[o.status] += 1;
        const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0); const active = db.products.filter((p) => p.status === 'active');
        const usersByRole = { Buyer: 0, Seller: 0, Admin: 0 }; for (const u of db.users.filter((x) => x.isActive)) usersByRole[u.role] += 1;
        ok(res, 'Summary retrieved.', { summary: { ordersByStatus: byStatus, orderedCents: sum(db.orders.filter((o) => o.status !== 'cancelled'), (o) => o.totalCents),
            paidCents: sum(db.invoices.filter((i) => i.status === 'paid'), (i) => db.orders.find((o) => o.id === i.orderId).totalCents),
            outstandingCents: sum(db.invoices.filter((i) => i.status === 'issued'), (i) => db.orders.find((o) => o.id === i.orderId).totalCents),
            activeProducts: active.length, lowStockProducts: active.filter((p) => p.stockQuantity <= LOW_STOCK).length, outOfStockProducts: active.filter((p) => p.stockQuantity === 0).length, usersByRole } });
    }));
    admin.get('/users', wrap((req, res) => {
        const p = paging(req.query); const q = String(req.query.q || '').toLowerCase();
        const rows = db.users.filter((u) => (!req.query.role || u.role === req.query.role) && (!q || u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))).slice().reverse();
        const s = slice(rows, p); ok(res, 'Users retrieved.', { users: s.rows.map((u) => ({ id: u.id, username: u.username, email: u.email, role: u.role, isActive: u.isActive, createdAt: u.createdAt })), pagination: s.pagination });
    }));
    admin.patch('/users/:id', wrap((req, res) => {
        const b = exact(req.body, ['role', 'isActive']); const u = db.users.find((x) => x.id === req.params.id); if (!u) throw err(404, 'User not found.');
        if (b.role !== undefined && !['Buyer', 'Seller', 'Admin'].includes(b.role)) throw err(400, 'role must be one of: Buyer, Seller, Admin.');
        if (b.isActive !== undefined && typeof b.isActive !== 'boolean') throw err(400, 'isActive must be true or false.');
        const demote = (b.role && b.role !== u.role && u.role === 'Admin') || b.isActive === false;
        if (u.id === req.user.id && demote) throw err(409, 'You cannot demote or deactivate your own account.', 'SELF_LOCKOUT');
        if (u.role === 'Admin' && demote && db.users.filter((x) => x.role === 'Admin' && x.isActive).length <= 1) throw err(409, 'At least one active Admin must remain.', 'LAST_ADMIN');
        if (b.role) u.role = b.role; if (b.isActive !== undefined) u.isActive = b.isActive;
        if (!u.isActive) { for (const [t, uid] of [...access]) if (uid === u.id) access.delete(t); for (const [t, uid] of [...refresh]) if (uid === u.id) refresh.delete(t); }
        audit(req, 'user.update', 'user', u.id, b); ok(res, 'User updated.', { user: { id: u.id, username: u.username, email: u.email, role: u.role, isActive: u.isActive, createdAt: u.createdAt } });
    }));
    admin.get('/audit-logs', wrap((req, res) => {
        const p = paging(req.query, 50, 200); const { action, entityType, entityId, actorId } = req.query;
        const rows = db.audit.filter((a) => (!action || a.action === action) && (!entityType || a.entityType === entityType) && (!entityId || a.entityId === entityId) && (!actorId || a.actorId === actorId));
        const s = slice(rows, p); ok(res, 'Audit log retrieved.', { entries: s.rows, pagination: s.pagination });
    }));

    app.use((req, _res, next) => next(err(404, 'Route not found.')));
    // eslint-disable-next-line no-unused-vars
    app.use((e, _req, res, _next) => res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'An unexpected error occurred.', statusCode: e.status || 500, ...(e.code ? { code: e.code } : {}), ...(e.details ? { details: e.details } : {}) }));
    return app;
}

if (require.main === module) {
    const port = Number(process.env.PORT || 5055);
    createApp().listen(port, () => console.info(`MOCK API (in-memory, not PostgreSQL) on http://localhost:${port}/app/`));
}
module.exports = { createApp };
