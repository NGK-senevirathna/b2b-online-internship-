'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { getPool, closePool } = require('../config/database');

/**
 * Applies pending SQL migrations in filename order under a PostgreSQL advisory lock.
 * @returns {Promise<void>} Resolves after all pending migrations are committed.
 */
async function migrate() {
    const client = await getPool().connect();
    const migrationDirectory = path.join(__dirname, '..', 'migrations');

    try {
        await client.query('SELECT pg_advisory_lock($1)', [728194205]);
        await client.query(
            `CREATE TABLE IF NOT EXISTS schema_migrations (
                name text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )`
        );

        const migrations = (await fs.readdir(migrationDirectory))
            .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))
            .sort();

        for (const name of migrations) {
            const exists = await client.query(
                'SELECT 1 FROM schema_migrations WHERE name = $1',
                [name]
            );
            if (exists.rowCount > 0) {
                continue;
            }

            const sql = await fs.readFile(path.join(migrationDirectory, name), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
                await client.query('COMMIT');
                console.info(`Applied database migration ${name}.`);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [728194205]);
        client.release();
        await closePool();
    }
}

if (require.main === module) {
    migrate().catch((error) => {
        console.error('Database migration failed.', error);
        process.exitCode = 1;
    });
}

module.exports = { migrate };
