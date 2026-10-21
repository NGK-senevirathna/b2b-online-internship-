'use strict';

const rateLimit = require('express-rate-limit');
const { getPool } = require('../config/database');

/**
 * Implements express-rate-limit's store contract with shared PostgreSQL counters.
 */
class PostgresRateLimitStore {
    /**
     * Initializes the configured window and starts periodic expired-key cleanup.
     * @param {object} options Rate limiter options.
     * @returns {void} Initializes the store.
     */
    init(options) {
        this.windowMs = options.windowMs;
        this.cleanupTimer = setInterval(() => {
            Promise.all([
                getPool().query('DELETE FROM rate_limit_hits WHERE reset_at <= now()'),
                getPool().query('DELETE FROM auth_sessions WHERE expires_at <= now()')
            ]).catch((error) => console.error('Expired authentication data cleanup failed.', error));
        }, this.windowMs);
        this.cleanupTimer.unref();
    }

    /**
     * Returns a key's current hit count and reset timestamp.
     * @param {string} key Rate-limit key.
     * @returns {Promise<{totalHits: number, resetTime: Date}|undefined>} Current counter state.
     */
    async get(key) {
        const result = await getPool().query(
            'SELECT total_hits AS "totalHits", reset_at AS "resetTime" FROM rate_limit_hits WHERE key = $1 AND reset_at > now()',
            [key]
        );
        return result.rows[0];
    }

    /**
     * Atomically increments a fixed-window counter across service instances.
     * @param {string} key Rate-limit key.
     * @returns {Promise<{totalHits: number, resetTime: Date}>} Updated counter state.
     */
    async increment(key) {
        const result = await getPool().query(
            `INSERT INTO rate_limit_hits (key, total_hits, reset_at)
             VALUES ($1, 1, now() + ($2 * interval '1 millisecond'))
             ON CONFLICT (key) DO UPDATE
             SET total_hits = CASE
                     WHEN rate_limit_hits.reset_at <= now() THEN 1
                     ELSE rate_limit_hits.total_hits + 1
                 END,
                 reset_at = CASE
                     WHEN rate_limit_hits.reset_at <= now() THEN now() + ($2 * interval '1 millisecond')
                     ELSE rate_limit_hits.reset_at
                 END
             RETURNING total_hits AS "totalHits", reset_at AS "resetTime"`,
            [key, this.windowMs]
        );
        return result.rows[0];
    }

    /**
     * Decrements the current counter without allowing a negative value.
     * @param {string} key Rate-limit key.
     * @returns {Promise<void>} Resolves when the counter is decremented.
     */
    async decrement(key) {
        await getPool().query(
            'UPDATE rate_limit_hits SET total_hits = GREATEST(total_hits - 1, 0) WHERE key = $1',
            [key]
        );
    }

    /**
     * Removes a key's counter.
     * @param {string} key Rate-limit key.
     * @returns {Promise<void>} Resolves when the counter is removed.
     */
    async resetKey(key) {
        await getPool().query('DELETE FROM rate_limit_hits WHERE key = $1', [key]);
    }

    /**
     * Stops periodic cleanup and allows the store to release resources.
     * @returns {void} Stops the cleanup timer.
     */
    shutdown() {
        clearInterval(this.cleanupTimer);
    }
}

/**
 * Limits each IP address to 100 requests per 15-minute window.
 * @type {import('express').RequestHandler}
 */
const postgresStore = process.env.NODE_ENV === 'test' ? undefined : new PostgresRateLimitStore();
const rateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many requests. Please try again later.',
        statusCode: 429
    },
    ...(postgresStore ? { store: postgresStore } : {})
});

/**
 * Stops the shared store's background cleanup work during graceful shutdown.
 * @returns {void} Stops store cleanup when PostgreSQL storage is enabled.
 */
rateLimiter.shutdown = function shutdownRateLimiter() {
    postgresStore?.shutdown();
};

module.exports = rateLimiter;
module.exports.PostgresRateLimitStore = PostgresRateLimitStore;
