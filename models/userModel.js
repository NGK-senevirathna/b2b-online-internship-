'use strict';

const { getPool } = require('../config/database');

/**
 * Finds a user by username without regard to case.
 * @param {string} username Username to look up.
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findByUsername(username) {
    const result = await getPool().query(
        'SELECT id, username, email, password_hash AS "passwordHash", role, created_at AS "createdAt" FROM users WHERE username_normalized = lower($1)',
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
        'SELECT id, username, email, password_hash AS "passwordHash", role, created_at AS "createdAt" FROM users WHERE email_normalized = lower($1)',
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
        `SELECT id, username, email, password_hash AS "passwordHash", role, created_at AS "createdAt"
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
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findById(id) {
    const result = await getPool().query(
        'SELECT id, username, email, password_hash AS "passwordHash", role, created_at AS "createdAt" FROM users WHERE id = $1',
        [id]
    );
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
             RETURNING id, username, email, password_hash AS "passwordHash", role, created_at AS "createdAt"`,
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

module.exports = {
    createUser,
    findByUsername,
    findByEmail,
    findByIdentifier,
    findById
};
