'use strict';

const { badRequest } = require('./httpError');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Control characters other than tab and newline are never legitimate in business text.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Ensures a request body is a plain JSON object and contains only allowed keys.
 * Rejecting unknown keys prevents mass-assignment of fields such as role or price.
 * @param {unknown} body Parsed request body.
 * @param {string[]} allowedKeys Accepted property names.
 * @returns {Record<string, unknown>} The validated body.
 */
function exactObject(body, allowedKeys) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw badRequest('A JSON object request body is required.');
    }
    const unknown = Object.keys(body).filter((key) => !allowedKeys.includes(key));
    if (unknown.length > 0) {
        throw badRequest(`Unknown field(s): ${unknown.slice(0, 5).join(', ')}.`);
    }
    return body;
}

/**
 * Validates a text value and returns it trimmed and Unicode-normalized.
 * @param {unknown} value Candidate value.
 * @param {string} field Field name used in error messages.
 * @param {{min?: number, max: number, pattern?: RegExp, patternMessage?: string, allowEmpty?: boolean}} rules Constraints.
 * @returns {string} Cleaned string.
 */
function text(value, field, rules) {
    if (typeof value !== 'string') {
        throw badRequest(`${field} must be a string.`);
    }
    const cleaned = value.normalize('NFC').trim();
    const min = rules.allowEmpty ? 0 : (rules.min ?? 1);
    if (cleaned.length < min || cleaned.length > rules.max) {
        throw badRequest(`${field} must be ${min === rules.max ? `exactly ${min}` : `${min}-${rules.max}`} characters.`);
    }
    if (CONTROL_CHARACTERS.test(cleaned)) {
        throw badRequest(`${field} contains invalid characters.`);
    }
    if (rules.pattern && !rules.pattern.test(cleaned)) {
        throw badRequest(rules.patternMessage || `${field} has an invalid format.`);
    }
    return cleaned;
}

/**
 * Validates a whole number (JSON numbers only; numeric strings are rejected).
 * @param {unknown} value Candidate value.
 * @param {string} field Field name used in error messages.
 * @param {{min: number, max: number, nonZero?: boolean}} rules Inclusive bounds.
 * @returns {number} Safe integer.
 */
function integer(value, field, rules) {
    if (!Number.isSafeInteger(value) || value < rules.min || value > rules.max || (rules.nonZero && value === 0)) {
        throw badRequest(`${field} must be a whole number between ${rules.min} and ${rules.max}${rules.nonZero ? ' (not zero)' : ''}.`);
    }
    return value;
}

/**
 * Validates an RFC 4122 UUID, typically from a route parameter.
 * @param {unknown} value Candidate value.
 * @param {string} field Field name used in error messages.
 * @returns {string} Lower-cased UUID.
 */
function uuid(value, field) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw badRequest(`${field} must be a valid identifier.`);
    }
    return value.toLowerCase();
}

/**
 * Validates that a value is one of a fixed set.
 * @param {unknown} value Candidate value.
 * @param {string} field Field name used in error messages.
 * @param {readonly string[]} allowed Allowed values.
 * @returns {string} The matching value.
 */
function oneOf(value, field, allowed) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`);
    }
    return value;
}

/**
 * Reads an optional single-valued query parameter (rejects repeated or nested values).
 * @param {unknown} value Raw query value.
 * @param {string} field Field name used in error messages.
 * @param {number} maxLength Maximum accepted length.
 * @returns {string|undefined} Trimmed value, or undefined when absent or blank.
 */
function optionalQueryText(value, field, maxLength = 100) {
    if (value === undefined || value === '') return undefined;
    return text(value, field, { max: maxLength });
}

/**
 * Parses bounded pagination parameters.
 * @param {Record<string, unknown>} query Express query object.
 * @param {{defaultLimit?: number, maxLimit?: number}} [options] Page size policy.
 * @returns {{page: number, limit: number, offset: number}} Normalized pagination.
 */
function pagination(query, options = {}) {
    const { defaultLimit = 20, maxLimit = 100 } = options;
    const page = query.page === undefined ? 1 : parseQueryInteger(query.page, 'page', 1, 100000);
    const limit = query.limit === undefined ? defaultLimit : parseQueryInteger(query.limit, 'limit', 1, maxLimit);
    return { page, limit, offset: (page - 1) * limit };
}

/**
 * Builds the pagination block returned with list responses.
 * @param {{page: number, limit: number}} paging Requested page.
 * @param {number} total Total matching rows.
 * @returns {{page: number, limit: number, total: number, totalPages: number}} Pagination metadata.
 */
function pageInfo(paging, total) {
    return {
        page: paging.page,
        limit: paging.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / paging.limit))
    };
}

/**
 * Parses an integer from a query string value.
 * @param {unknown} value Raw query value.
 * @param {string} field Field name used in error messages.
 * @param {number} min Inclusive minimum.
 * @param {number} max Inclusive maximum.
 * @returns {number} Parsed integer.
 */
function parseQueryInteger(value, field, min, max) {
    if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) {
        throw badRequest(`${field} must be a whole number.`);
    }
    return integer(Number(value), field, { min, max });
}

/**
 * Escapes LIKE/ILIKE wildcards so user input is matched literally.
 * @param {string} value Raw search text.
 * @returns {string} Escaped text for use with ESCAPE '\'.
 */
function escapeLike(value) {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

module.exports = {
    exactObject,
    text,
    integer,
    uuid,
    oneOf,
    optionalQueryText,
    pagination,
    pageInfo,
    parseQueryInteger,
    escapeLike
};
