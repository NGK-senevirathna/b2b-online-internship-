'use strict';

const jwt = require('jsonwebtoken');
const { getJwtConfig } = require('../config/jwtConfig');

/**
 * Verifies a signed JWT from the Authorization: Bearer header.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express middleware callback.
 * @returns {void} Continues on success or sends a standardized authentication error.
 */
function authenticateToken(req, res, next) {
    const authorization = req.get('authorization');
    const match = typeof authorization === 'string'
        ? authorization.match(/^Bearer ([^\s]+)$/i)
        : null;

    if (!match) {
        return res.status(401).json({
            success: false,
            error: 'A valid Bearer token is required.',
            statusCode: 401
        });
    }

    try {
        const jwtConfig = getJwtConfig();
        req.user = jwt.verify(match[1], jwtConfig.secret, {
            algorithms: ['HS256'],
            issuer: jwtConfig.issuer,
            audience: jwtConfig.audience
        });
        return next();
    } catch (_error) {
        return res.status(401).json({
            success: false,
            error: 'Invalid or expired token.',
            statusCode: 401
        });
    }
}

module.exports = { authenticateToken };