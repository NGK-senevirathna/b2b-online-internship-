'use strict';

require('dotenv').config();

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { closePool } = require('../config/database');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');
const { PostgresRateLimitStore } = require('../middleware/rateLimiter');

const enabled = Boolean(process.env.DATABASE_URL);
let createdUserId;

function hash(token) {
    return createHash('sha256').update(token).digest('hex');
}

test('PostgreSQL persists unique users, rotates refresh tokens, and shares rate-limit counters', {
    skip: !enabled && 'Set DATABASE_URL and run npm run test:db to exercise PostgreSQL.'
}, async (t) => {
    const suffix = randomUUID();
    const user = await userModel.createUser({
        username: `db-${suffix.slice(0, 8)}`,
        email: `${suffix}@example.com`,
        passwordHash: 'integration-test-hash',
        role: 'Buyer'
    });
    createdUserId = user.id;

    await t.test('looks up normalized identities and rejects duplicates', async () => {
        assert.equal((await userModel.findByEmail(user.email.toUpperCase())).id, user.id);
        await assert.rejects(
            userModel.createUser({
                username: user.username.toUpperCase(),
                email: `different-${suffix}@example.com`,
                passwordHash: 'another-hash',
                role: 'Buyer'
            }),
            { code: 'DUPLICATE_USER' }
        );
    });

    const originalToken = `original-${randomUUID()}-${randomUUID()}`;
    const replacementToken = `replacement-${randomUUID()}-${randomUUID()}`;
    const originalHash = hash(originalToken);
    const replacementHash = hash(replacementToken);
    const expiresAt = new Date(Date.now() + 60_000);
    const session = await sessionModel.createSession(user.id, originalHash, expiresAt);

    await t.test('rotates once and revokes the session when the old token is reused', async () => {
        assert.equal(await sessionModel.isSessionActive(session.id), true);
        const rotated = await sessionModel.rotateRefreshToken(originalHash, replacementHash, expiresAt);
        assert.equal(rotated.status, 'rotated');
        assert.equal(rotated.userId, user.id);
        assert.equal(await sessionModel.isSessionActive(session.id), true);

        const replay = await sessionModel.rotateRefreshToken(
            originalHash,
            hash(`replay-${randomUUID()}-${randomUUID()}`),
            expiresAt
        );
        assert.equal(replay.status, 'reuse');
        assert.equal(await sessionModel.isSessionActive(session.id), false);
    });

    await t.test('uses atomic PostgreSQL rate-limit counters', async () => {
        const store = new PostgresRateLimitStore();
        store.init({ windowMs: 60_000 });
        const key = `integration-${suffix}`;
        try {
            const first = await store.increment(key);
            const second = await store.increment(key);
            assert.equal(first.totalHits, 1);
            assert.equal(second.totalHits, 2);
            assert.equal((await store.get(key)).totalHits, 2);
            await store.resetKey(key);
            assert.equal(await store.get(key), undefined);
        } finally {
            store.shutdown();
        }
    });
});

after(async () => {
    if (createdUserId) {
        const { getPool } = require('../config/database');
        await getPool().query('DELETE FROM users WHERE id = $1', [createdUserId]);
    }
    await closePool();
});
