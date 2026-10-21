'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt-signing';
process.env.JWT_EXPIRES_IN = '1h';
process.env.ROLE_PROVISIONING_KEY = 'test-role-provisioning-key-with-more-than-32-chars';
process.env.NODE_ENV = 'test';

const { createApp } = require('../server');

let server;
let baseUrl;

before(async () => {
    const app = createApp();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});

/**
 * Sends a JSON request to the running test server.
 * @param {string} path Request path.
 * @param {object} options Fetch options.
 * @returns {Promise<{response: Response, body: object}>} HTTP response and parsed body.
 */
async function requestJson(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...options.headers
        }
    });
    return { response, body: await response.json() };
}

test('registration, login, and role-protected routes follow the authorization policy', async (t) => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const buyer = {
        username: `buyer-${suffix}`,
        email: `buyer-${suffix}@example.com`,
        password: 'safe-test-password'
    };

    await t.test('registers with the default Buyer role and rejects duplicates', async () => {
        const created = await requestJson('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify(buyer)
        });
        assert.equal(created.response.status, 201);
        assert.equal(created.body.data.user.role, 'Buyer');
        assert.equal('passwordHash' in created.body.data.user, false);

        const duplicate = await requestJson('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify(buyer)
        });
        assert.equal(duplicate.response.status, 409);
        assert.deepEqual(
            Object.keys(duplicate.body).sort(),
            ['error', 'statusCode', 'success']
        );
    });

    const login = await requestJson('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: buyer.username, password: buyer.password })
    });
    assert.equal(login.response.status, 200);
    const buyerToken = login.body.data.token;
    const authorization = { authorization: `Bearer ${buyerToken}` };

    await t.test('allows authenticated profile access and denies unauthorized roles', async () => {
        const profile = await requestJson('/api/auth/me', { headers: authorization });
        assert.equal(profile.response.status, 200);
        assert.equal(profile.body.data.user.username, buyer.username);
        assert.equal(profile.body.success, true);

        const sellerPanel = await requestJson('/api/auth/seller-panel', { headers: authorization });
        assert.equal(sellerPanel.response.status, 403);

        const adminDashboard = await requestJson('/api/auth/admin-dashboard', { headers: authorization });
        assert.equal(adminDashboard.response.status, 403);
    });

    await t.test('permits Seller users to access the Seller panel', async () => {
        const sellerData = {
            username: `seller-${suffix}`,
            email: `seller-${suffix}@example.com`,
            password: 'safe-test-password',
            role: 'Seller'
        };
        const deniedRegistration = await requestJson('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify(sellerData)
        });
        assert.equal(deniedRegistration.response.status, 403);

        const registration = await requestJson('/api/auth/register', {
            method: 'POST',
            headers: { 'x-role-provisioning-key': process.env.ROLE_PROVISIONING_KEY },
            body: JSON.stringify(sellerData)
        });
        assert.equal(registration.response.status, 201);

        const sellerLogin = await requestJson('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({
                identifier: sellerData.email,
                password: sellerData.password
            })
        });
        const sellerAuthorization = { authorization: `Bearer ${sellerLogin.body.data.token}` };
        const sellerPanel = await requestJson('/api/auth/seller-panel', {
            headers: sellerAuthorization
        });
        const adminDashboard = await requestJson('/api/auth/admin-dashboard', {
            headers: sellerAuthorization
        });
        assert.equal(sellerPanel.response.status, 200);
        assert.equal(adminDashboard.response.status, 403);
    });

    await t.test('requires Bearer authentication and protects Admin registration', async () => {
        const unauthenticated = await requestJson('/api/auth/me');
        assert.equal(unauthenticated.response.status, 401);

        const adminData = {
            username: `admin-${suffix}`,
            email: `admin-${suffix}@example.com`,
            password: 'safe-test-password',
            role: 'Admin'
        };
        const denied = await requestJson('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify(adminData)
        });
        assert.equal(denied.response.status, 403);

        const createdAdmin = await requestJson('/api/auth/register', {
            method: 'POST',
            headers: { 'x-role-provisioning-key': process.env.ROLE_PROVISIONING_KEY },
            body: JSON.stringify(adminData)
        });
        assert.equal(createdAdmin.response.status, 201);

        const adminLogin = await requestJson('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: adminData.email, password: adminData.password })
        });
        const adminAuthorization = { authorization: `Bearer ${adminLogin.body.data.token}` };
        const sellerPanel = await requestJson('/api/auth/seller-panel', { headers: adminAuthorization });
        const adminDashboard = await requestJson('/api/auth/admin-dashboard', { headers: adminAuthorization });
        assert.equal(sellerPanel.response.status, 200);
        assert.equal(adminDashboard.response.status, 200);
    });
});
