'use strict';

const { Pool } = require('pg');

let pool;

/**
 * Returns the shared PostgreSQL connection pool.
 * @returns {import('pg').Pool} Configured PostgreSQL pool.
 * @throws {Error} If DATABASE_URL is missing.
 */
function getPool() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL must be configured.');
    }

    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: Number.parseInt(process.env.DB_POOL_MAX || '10', 10),
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
            ssl: process.env.DATABASE_SSL === 'true'
                ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
                : undefined
        });
        pool.on('error', (error) => {
            console.error('Unexpected idle PostgreSQL client error.', error);
        });
    }

    return pool;
}

/**
 * Verifies that the PostgreSQL service is reachable.
 * @returns {Promise<void>} Resolves after a successful SELECT 1 query.
 */
async function checkConnection() {
    const result = await getPool().query(
        `SELECT
            to_regclass('public.users') IS NOT NULL AS users,
            to_regclass('public.auth_sessions') IS NOT NULL AS sessions,
            to_regclass('public.refresh_tokens') IS NOT NULL AS refresh_tokens,
            to_regclass('public.rate_limit_hits') IS NOT NULL AS rate_limit_hits`
    );
    if (Object.values(result.rows[0]).some((tableExists) => !tableExists)) {
        throw new Error('Database schema is not initialized. Run npm run db:migrate.');
    }
}

/**
 * Closes the shared PostgreSQL connection pool.
 * @returns {Promise<void>} Resolves after all pool connections close.
 */
async function closePool() {
    if (pool) {
        const activePool = pool;
        pool = undefined;
        await activePool.end();
    }
}

module.exports = { getPool, checkConnection, closePool };
