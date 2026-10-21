'use strict';

const { randomUUID } = require('node:crypto');

const users = [];

/**
 * Finds a user by username without regard to case.
 * @param {string} username Username to look up.
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findByUsername(username) {
    const normalized = username.toLowerCase();
    return cloneUser(users.find((user) => user.username.toLowerCase() === normalized));
}

/**
 * Finds a user by email without regard to case.
 * @param {string} email Email address to look up.
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findByEmail(email) {
    const normalized = email.toLowerCase();
    return cloneUser(users.find((user) => user.email.toLowerCase() === normalized));
}

/**
 * Looks up a user using either its username or email address.
 * @param {string} identifier Username or email address.
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findByIdentifier(identifier) {
    return identifier.includes('@')
        ? findByEmail(identifier)
        : findByUsername(identifier);
}

/**
 * Finds a user by its unique identifier.
 * @param {string} id User identifier.
 * @returns {Promise<object|undefined>} A user record, or undefined when absent.
 */
async function findById(id) {
    return cloneUser(users.find((user) => user.id === id));
}

/**
 * Stores a user record while enforcing unique usernames and emails.
 * The synchronous uniqueness check is atomic for this single-process adapter.
 * @param {{username: string, email: string, passwordHash: string, role: string}} user New user data.
 * @returns {Promise<object>} A copy of the created user record.
 * @throws {Error} With code DUPLICATE_USER when an identity already exists.
 */
async function createUser(user) {
    const normalizedUsername = user.username.toLowerCase();
    const normalizedEmail = user.email.toLowerCase();
    const duplicate = users.some(
        (existing) =>
            existing.username.toLowerCase() === normalizedUsername ||
            existing.email.toLowerCase() === normalizedEmail
    );

    if (duplicate) {
        const error = new Error('A user with that username or email already exists.');
        error.code = 'DUPLICATE_USER';
        throw error;
    }

    const createdUser = {
        id: randomUUID(),
        username: user.username,
        email: user.email,
        passwordHash: user.passwordHash,
        role: user.role,
        createdAt: new Date().toISOString()
    };

    users.push(createdUser);
    return cloneUser(createdUser);
}

/**
 * Returns a shallow copy so callers cannot mutate stored records by reference.
 * @param {object|undefined} user User record to copy.
 * @returns {object|undefined} Copied user record, if present.
 */
function cloneUser(user) {
    return user ? { ...user } : undefined;
}

module.exports = {
    createUser,
    findByUsername,
    findByEmail,
    findByIdentifier,
    findById
};
