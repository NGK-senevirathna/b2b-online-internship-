'use strict';

const { getPool } = require('../config/database');
const { escapeLike } = require('../utils/validation');

const USER_COLUMNS = `id, username, email, password_hash AS "passwordHash", role,
    is_active AS "isActive", created_at AS "createdAt"`;

/**
 * Finds a user by username without regard to case.
 * @param {string} username Username to look up.
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findByUsername(username) {
    const result = await getPool().query(
        `SELECT ${USER_COLUMNS} FROM users WHERE username_normalized = lower($1)`,
        [username]
    );
    return result.rows[0];
}

/**
 * Finds a user by email without regard to case.
 * @param {string} email Email address to look up.
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findByEmail(email) {
    const result = await getPool().query(
        `SELECT ${USER_COLUMNS} FROM users WHERE email_normalized = lower($1)`,
        [email]
    );
    return result.rows[0];
}

/**
 * Looks up a user using either its username or email address.
 * @param {string} identifier Username or email address.
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findByIdentifier(identifier) {
    const result = await getPool().query(
        `SELECT ${USER_COLUMNS}
         FROM users
         WHERE username_normalized = lower($1) OR email_normalized = lower($1)
         LIMIT 1`,
        [identifier]
    );
    return result.rows[0];
}

/**
 * Finds a user by its unique identifier.
 * @param {string} id User identifier.
 * @param {{query: Function}} [db] Pool or transaction client.
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findById(id, db = getPool()) {
    const result = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return result.rows[0];
}

/**
 * Stores a user record and relies on database unique constraints for races.
 * @param {{username: string, email: string, passwordHash: string, role: string}} user New user data.
 * @returns {Promise<object>} Created user record.
 * @throws {Error} With code DUPLICATE_USER when username or email is taken.
 */
async function createUser(user) {
    try {
        const result = await getPool().query(
            `INSERT INTO users (username, email, password_hash, role)
             VALUES ($1, $2, $3, $4)
             RETURNING ${USER_COLUMNS}`,
            [user.username, user.email, user.passwordHash, user.role]
        );
        return result.rows[0];
    } catch (error) {
        if (error.code === '23505' && ['users_username_normalized_key', 'users_email_normalized_key'].includes(error.constraint)) {
            const duplicateError = new Error('A user with that username or email already exists.');
            duplicateError.code = 'DUPLICATE_USER';
            throw duplicateError;
        }
        throw error;
    }
}

/**
 * Lists users for administration (password hashes are never selected).
 * @param {{search?: string, role?: string, limit: number, offset: number}} filters Filters.
 * @returns {Promise<{rows: object[], total: number}>} Page and total match count.
 */
async function search(filters) {
    const conditions = [];
    const params = [];
    if (filters.role) {
        params.push(filters.role);
        conditions.push(`role = $${params.length}`);
    }
    if (filters.search) {
        params.push(`%${escapeLike(filters.search)}%`);
        const pattern = `$${params.length}`;
        conditions.push(`(username ILIKE ${pattern} ESCAPE '\\' OR email ILIKE ${pattern} ESCAPE '\\')`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = await getPool().query(`SELECT count(*) AS total FROM users ${where}`, params);
    const rows = await getPool().query(
        `SELECT id, username, email, role, is_active AS "isActive", created_at AS "createdAt"
         FROM users ${where}
         ORDER BY created_at DESC, id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.limit, filters.offset]
    );
    return { rows: rows.rows, total: total.rows[0].total };
}

/**
 * Changes administrator-controlled account fields.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} id User id.
 * @param {{role?: string, isActive?: boolean}} changes Fields to change.
 * @returns {Promise<void>} Resolves after the update.
 */
async function updateAdminFields(db, id, changes) {
    const assignments = [];
    const params = [id];
    if (changes.role !== undefined) {
        params.push(changes.role);
        assignments.push(`role = $${params.length}`);
    }
    if (changes.isActive !== undefined) {
        params.push(changes.isActive);
        assignments.push(`is_active = $${params.length}`);
    }
    if (assignments.length === 0) return;
    await db.query(`UPDATE users SET ${assignments.join(', ')} WHERE id = $1`, params);
}

/**
 * Locks all active administrators so concurrent changes cannot remove the last one.
 * @param {{query: Function}} db Transaction client.
 * @returns {Promise<number>} Number of active administrators.
 */
async function lockActiveAdminCount(db) {
    const result = await db.query(
        `SELECT id FROM users WHERE role = 'Admin' AND is_active = true FOR UPDATE`
    );
    return result.rowCount;
}

module.exports = {
    createUser,
    findByUsername,
    findByEmail,
    findByIdentifier,
    findById,
    search,
    updateAdminFields,
    lockActiveAdminCount
};
