'use strict';

const { Pool, types } = require('pg');

// BIGINT columns hold money in cents and counters; every value stays far below 2^53,
// so returning JavaScript numbers (instead of strings) is safe and keeps the API clean.
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

const REQUIRED_TABLES = [
    'users', 'auth_sessions', 'refresh_tokens', 'rate_limit_hits',
    'products', 'carts', 'cart_items', 'orders', 'order_items',
    'invoices', 'stock_movements', 'audit_logs'
];

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
            // Abort runaway statements instead of letting them hold locks or connections.
            statement_timeout: 15_000,
            idle_in_transaction_session_timeout: 15_000,
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
 * Runs a callback inside a database transaction on a dedicated connection.
 * The transaction commits when the callback resolves and rolls back when it throws.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} callback Work to perform.
 * @returns {Promise<T>} The callback result.
 */
async function withTransaction(callback) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Transaction rollback failed.', rollbackError);
        }
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Verifies that PostgreSQL is reachable and every migrated table exists.
 * @returns {Promise<void>} Resolves when the schema is ready.
 * @throws {Error} If PostgreSQL is unreachable or migrations have not been applied.
 */
async function checkConnection() {
    const result = await getPool().query(
        `SELECT t.name
         FROM unnest($1::text[]) AS t(name)
         WHERE to_regclass('public.' || t.name) IS NULL`,
        [REQUIRED_TABLES]
    );
    if (result.rowCount > 0) {
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

module.exports = { getPool, withTransaction, checkConnection, closePool };
