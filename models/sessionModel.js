'use strict';

const { randomUUID } = require('node:crypto');
const { getPool } = require('../config/database');

/**
 * Creates an authentication session and its first hashed refresh token.
 * @param {string} userId Owning user identifier.
 * @param {string} refreshTokenHash SHA-256 digest of the opaque refresh token.
 * @param {Date} expiresAt Absolute session and refresh-token expiry.
 * @returns {Promise<{id: string, userId: string}>} Created session identifiers.
 */
async function createSession(userId, refreshTokenHash, expiresAt) {
    const pool = getPool();
    const client = await pool.connect();
    const sessionId = randomUUID();

    try {
        await client.query('BEGIN');
        await client.query(
            'INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
            [sessionId, userId, expiresAt]
        );
        await client.query(
            'INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [sessionId, refreshTokenHash, expiresAt]
        );
        await client.query('COMMIT');
        return { id: sessionId, userId };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Atomically rotates a refresh token and detects reuse of consumed tokens.
 * A replay revokes the entire session family, including the newly issued token.
 * @param {string} refreshTokenHash SHA-256 digest of the presented token.
 * @param {string} replacementHash SHA-256 digest of the replacement token.
 * @param {Date} expiresAt Expiry for the replacement session/token.
 * @returns {Promise<{status: string, sessionId?: string, userId?: string}>} Rotation outcome.
 */
async function rotateRefreshToken(refreshTokenHash, replacementHash, expiresAt) {
    const pool = getPool();
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const found = await client.query(
            `SELECT s.id AS "sessionId", s.user_id AS "userId", s.expires_at AS "sessionExpiresAt",
                    s.revoked_at AS "sessionRevokedAt", rt.id AS "refreshTokenId",
                    rt.expires_at AS "tokenExpiresAt", rt.consumed_at AS "consumedAt"
             FROM refresh_tokens rt
             JOIN auth_sessions s ON s.id = rt.session_id
             WHERE rt.token_hash = $1
             FOR UPDATE OF s, rt`,
            [refreshTokenHash]
        );

        const current = found.rows[0];
        if (!current) {
            await client.query('COMMIT');
            return { status: 'invalid' };
        }

        if (current.consumedAt) {
            await client.query(
                'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1',
                [current.sessionId]
            );
            await client.query(
                'UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE session_id = $1',
                [current.sessionId]
            );
            await client.query('COMMIT');
            return { status: 'reuse', sessionId: current.sessionId, userId: current.userId };
        }

        if (
            current.sessionRevokedAt ||
            new Date(current.sessionExpiresAt).getTime() <= Date.now() ||
            new Date(current.tokenExpiresAt).getTime() <= Date.now()
        ) {
            await client.query('COMMIT');
            return { status: 'invalid' };
        }

        await client.query(
            'UPDATE refresh_tokens SET consumed_at = now(), replaced_by_hash = $2 WHERE id = $1',
            [current.refreshTokenId, replacementHash]
        );
        await client.query(
            'UPDATE auth_sessions SET expires_at = $2 WHERE id = $1',
            [current.sessionId, expiresAt]
        );
        await client.query(
            'INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [current.sessionId, replacementHash, expiresAt]
        );
        await client.query('COMMIT');
        return { status: 'rotated', sessionId: current.sessionId, userId: current.userId };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Revokes a session and every refresh token associated with it.
 * @param {string} sessionId Session identifier from a verified access token.
 * @returns {Promise<boolean>} Whether an active session was revoked.
 */
async function revokeSession(sessionId) {
    const result = await getPool().query(
        `WITH revoked AS (
             UPDATE auth_sessions SET revoked_at = now()
             WHERE id = $1 AND revoked_at IS NULL
             RETURNING id
         ),
         tokens AS (
             UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
             WHERE session_id = $1
         )
         SELECT id FROM revoked`,
        [sessionId]
    );
    return result.rows.length > 0;
}

/**
 * Checks whether a session remains active and within its expiration.
 * @param {string} sessionId Session identifier.
 * @returns {Promise<boolean>} Whether the session is active.
 */
async function isSessionActive(sessionId) {
    const result = await getPool().query(
        `SELECT 1 FROM auth_sessions
         WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [sessionId]
    );
    return result.rowCount === 1;
}

/**
 * Revokes every active session (and refresh token) belonging to a user.
 * Used when an administrator deactivates an account.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} userId User identifier.
 * @returns {Promise<void>} Resolves after revocation.
 */
async function revokeAllForUser(db, userId) {
    await db.query(
        `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
         WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = $1)`,
        [userId]
    );
    await db.query(
        'UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId]
    );
}

module.exports = {
    createSession,
    rotateRefreshToken,
    revokeSession,
    revokeAllForUser,
    isSessionActive
};
