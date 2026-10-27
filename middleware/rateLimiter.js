'use strict';

const rateLimit = require('express-rate-limit');
const { getPool } = require('../config/database');

/**
 * Implements express-rate-limit's store contract with shared PostgreSQL counters.
 * Keys are namespaced by a prefix so several limiters can share one table.
 */
class PostgresRateLimitStore {
    /**
     * @param {string} [prefix] Namespace for this limiter's keys.
     * @param {{cleanup?: boolean}} [options] Whether this store also purges expired data periodically.
     */
    constructor(prefix = '', options = {}) {
        this.prefix = prefix ? `${prefix}:` : '';
        this.cleanup = Boolean(options.cleanup);
    }

    /**
     * Initializes the configured window and, when enabled, starts periodic expired-data cleanup.
     * @param {object} options Rate limiter options.
     * @returns {void} Initializes the store.
     */
    init(options) {
        this.windowMs = options.windowMs;
        if (!this.cleanup) return;
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
            [this.prefix + key]
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
            [this.prefix + key, this.windowMs]
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
            [this.prefix + key]
        );
    }

    /**
     * Removes a key's counter.
     * @param {string} key Rate-limit key.
     * @returns {Promise<void>} Resolves when the counter is removed.
     */
    async resetKey(key) {
        await getPool().query('DELETE FROM rate_limit_hits WHERE key = $1', [this.prefix + key]);
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
 * Creates one rate limiter with a consistent JSON error body.
 * @param {{name: string, windowMs: number, limit: number, store?: object, skipSuccessfulRequests?: boolean}} options Limiter options.
 * @returns {import('express').RequestHandler} Limiter middleware.
 */
function buildLimiter(options) {
    return rateLimit({
        windowMs: options.windowMs,
        limit: options.limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
        message: {
            success: false,
            error: 'Too many requests. Please try again later.',
            statusCode: 429
        },
        ...(options.store ? { store: options.store } : {})
    });
}

/**
 * Creates the application's rate limiters.
 * - api: general ceiling for every /api request per IP.
 * - login: failed sign-ins only (successful logins are not counted), to slow password guessing.
 * - register: account-creation attempts, to slow mass sign-up.
 * Counters live in PostgreSQL so they are shared by all service instances; tests use memory.
 * @param {{apiMax: number, loginMax: number, registerMax: number}} limits Per-window maximums.
 * @param {{usePostgres: boolean}} options Storage selection.
 * @returns {{api: Function, login: Function, register: Function, shutdown: () => void}} Limiters.
 */
function createRateLimiters(limits, options) {
    const stores = options.usePostgres
        ? {
            api: new PostgresRateLimitStore('api', { cleanup: true }),
            login: new PostgresRateLimitStore('login'),
            register: new PostgresRateLimitStore('register')
        }
        : {};

    return {
        api: buildLimiter({ name: 'api', windowMs: 15 * 60 * 1000, limit: limits.apiMax, store: stores.api }),
        login: buildLimiter({
            name: 'login',
            windowMs: 15 * 60 * 1000,
            limit: limits.loginMax,
            store: stores.login,
            skipSuccessfulRequests: true
        }),
        register: buildLimiter({ name: 'register', windowMs: 60 * 60 * 1000, limit: limits.registerMax, store: stores.register }),
        shutdown() {
            Object.values(stores).forEach((store) => store.shutdown());
        }
    };
}

module.exports = { createRateLimiters, PostgresRateLimitStore };
