'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');

process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-jwt-signing';
process.env.JWT_EXPIRES_IN = '1h';
process.env.REFRESH_TOKEN_TTL_DAYS = '30';
process.env.ROLE_PROVISIONING_KEY = 'test-role-provisioning-key-with-more-than-32-chars';
process.env.NODE_ENV = 'test';

const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');
const { createApp } = require('../server');

let server;
let baseUrl;
const testUsers = [];
const testSessions = new Map();
const testRefreshTokens = new Map();

function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

before(async () => {
    userModel.findByUsername = async (username) =>
        testUsers.find((user) => user.username.toLowerCase() === username.toLowerCase());
    userModel.findByEmail = async (email) =>
        testUsers.find((user) => user.email.toLowerCase() === email.toLowerCase());
    userModel.findByIdentifier = async (identifier) =>
        testUsers.find((user) =>
            user.username.toLowerCase() === identifier.toLowerCase() ||
            user.email.toLowerCase() === identifier.toLowerCase()
        );
    userModel.findById = async (id) => testUsers.find((user) => user.id === id);
    userModel.createUser = async (data) => {
        if (await userModel.findByUsername(data.username) || await userModel.findByEmail(data.email)) {
            const error = new Error('Duplicate user');
            error.code = 'DUPLICATE_USER';
            throw error;
        }
        const user = { id: randomUUID(), ...data, createdAt: new Date().toISOString() };
        testUsers.push(user);
        return user;
    };
    sessionModel.createSession = async (userId, refreshTokenHash, expiresAt) => {
        const id = randomUUID();
        testSessions.set(id, { userId, expiresAt, revoked: false });
        testRefreshTokens.set(refreshTokenHash, { sessionId: id, consumed: false });
        return { id, userId };
    };
    sessionModel.rotateRefreshToken = async (oldHash, newHash, expiresAt) => {
        const token = testRefreshTokens.get(oldHash);
        if (!token) return { status: 'invalid' };
        const session = testSessions.get(token.sessionId);
        if (token.consumed) {
            session.revoked = true;
            return { status: 'reuse' };
        }
        if (!session || session.revoked || session.expiresAt <= new Date()) {
            return { status: 'invalid' };
        }
        token.consumed = true;
        session.expiresAt = expiresAt;
        testRefreshTokens.set(newHash, { sessionId: token.sessionId, consumed: false });
        return { status: 'rotated', sessionId: token.sessionId, userId: session.userId };
    };
    sessionModel.revokeSession = async (id) => {
        const session = testSessions.get(id);
        if (!session) return false;
        session.revoked = true;
        return true;
    };
    sessionModel.isSessionActive = async (id) => {
        const session = testSessions.get(id);
        return Boolean(session && !session.revoked && session.expiresAt > new Date());
    };

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
    await t.test('serves the frontend and its same-origin assets', async () => {
        const page = await fetch(`${baseUrl}/app/`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /text\/html/);
        assert.match(await page.text(), /Create your account/);

        const script = await fetch(`${baseUrl}/app/app.js`);
        assert.equal(script.status, 200);
        assert.match(await script.text(), /API_BASE/);

        const styles = await fetch(`${baseUrl}/app/styles.css`);
        assert.equal(styles.status, 200);
        assert.match(await styles.text(), /--purple:/);
    });

    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const buyer = {
        username: `buyer-${suffix}`,
        email: `buyer-${suffix}@example.com`,
        password: 'safe-test-password'
    };

    await t.test('rejects malformed registration data and invalid credentials', async () => {
        const invalidRegistration = await requestJson('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({
                username: 'no',
                email: 'not-an-email',
                password: 'short',
                role: 'Root'
            })
        });
        assert.equal(invalidRegistration.response.status, 400);
        assert.deepEqual(
            Object.keys(invalidRegistration.body).sort(),
            ['error', 'statusCode', 'success']
        );

        const invalidLogin = await requestJson('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username: 'missing-user', password: 'incorrect-password' })
        });
        assert.equal(invalidLogin.response.status, 401);
        assert.equal(invalidLogin.body.error, 'Invalid username/email or password.');
    });

    await t.test('registers with the default Buyer role and rejects duplicates', async () => {
        const created = await requestJson('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify(buyer)
        });
        assert.equal(created.response.status, 201);
        assert.equal(created.body.data.user.role, 'Buyer');
        assert.equal('passwordHash' in created.body.data.user, false);
        assert.equal('passwordHash' in testUsers[0], true);

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
    const buyerRefreshToken = login.body.data.refreshToken;
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

        const logout = await requestJson('/api/auth/logout', {
            method: 'POST',
            headers: adminAuthorization
        });
        assert.equal(logout.response.status, 200);
        const revokedAccess = await requestJson('/api/auth/me', { headers: adminAuthorization });
        assert.equal(revokedAccess.response.status, 401);
    });

    await t.test('rotates refresh tokens and revokes a family after token reuse', async () => {
        const refreshed = await requestJson('/api/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refreshToken: buyerRefreshToken })
        });
        assert.equal(refreshed.response.status, 200);
        assert.notEqual(refreshed.body.data.refreshToken, buyerRefreshToken);

        const refreshReplay = await requestJson('/api/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refreshToken: buyerRefreshToken })
        });
        assert.equal(refreshReplay.response.status, 401);

        const revokedAccess = await requestJson('/api/auth/me', {
            headers: { authorization: `Bearer ${refreshed.body.data.token}` }
        });
        assert.equal(revokedAccess.response.status, 401);
    });
});
