'use strict';

const DEFAULT_TOKEN_EXPIRY = '1h';
const JWT_ISSUER = 'b2b-auth-microservice';
const JWT_AUDIENCE = 'b2b-api';

/**
 * Returns validated JWT settings and fails closed when the signing secret is weak.
 * @returns {{secret: string, expiresIn: string, issuer: string, audience: string}} JWT settings.
 * @throws {Error} If JWT_SECRET is missing or shorter than 32 characters.
 */
function getJwtConfig() {
    const secret = process.env.JWT_SECRET;
    if (typeof secret !== 'string' || secret.length < 32) {
        throw new Error('JWT_SECRET must be configured with at least 32 characters.');
    }

    const expiresIn = process.env.JWT_EXPIRES_IN || DEFAULT_TOKEN_EXPIRY;
    if (typeof expiresIn !== 'string' || expiresIn.trim().length === 0) {
        throw new Error('JWT_EXPIRES_IN must be a non-empty duration string.');
    }

    return {
        secret,
        expiresIn,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE
    };
}

module.exports = { getJwtConfig };
