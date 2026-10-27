'use strict';

/**
 * Reads and validates a whole-number environment variable.
 * @param {string} name Variable name.
 * @param {number} fallback Value used when the variable is unset.
 * @param {number} min Inclusive minimum.
 * @param {number} max Inclusive maximum.
 * @returns {number} Validated number.
 */
function readInteger(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
    }
    return value;
}

/**
 * Returns business and rate-limit settings validated at call time.
 * @returns {{taxRateBps: number, lowStockThreshold: number, maxCartLines: number, rateLimits: {apiMax: number, loginMax: number, registerMax: number}}} Settings.
 */
function getAppConfig() {
    return {
        taxRateBps: readInteger('TAX_RATE_BPS', 0, 0, 10000),
        lowStockThreshold: readInteger('LOW_STOCK_THRESHOLD', 5, 0, 100000),
        maxCartLines: 50,
        rateLimits: {
            apiMax: readInteger('RATE_LIMIT_API_MAX', 300, 1, 1000000),
            loginMax: readInteger('RATE_LIMIT_LOGIN_MAX', 10, 1, 1000000),
            registerMax: readInteger('RATE_LIMIT_REGISTER_MAX', 10, 1, 1000000)
        }
    };
}

module.exports = { getAppConfig };
