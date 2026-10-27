'use strict';

const jwt = require('jsonwebtoken');
const { getJwtConfig } = require('../config/jwtConfig');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');

/**
 * Verifies a signed JWT from the Authorization: Bearer header.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express middleware callback.
 * @returns {void} Continues on success or sends a standardized authentication error.
 */
async function authenticateToken(req, res, next) {
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

    let claims;
    try {
        const jwtConfig = getJwtConfig();
        claims = jwt.verify(match[1], jwtConfig.secret, {
            algorithms: ['HS256'],
            issuer: jwtConfig.issuer,
            audience: jwtConfig.audience
        });
    } catch (_error) {
        return res.status(401).json({
            success: false,
            error: 'Invalid or expired token.',
            statusCode: 401
        });
    }

    if (
        typeof claims !== 'object' ||
        typeof claims.sid !== 'string' ||
        typeof claims.id !== 'string' ||
        claims.sub !== claims.id
    ) {
        return res.status(401).json({
            success: false,
            error: 'Invalid or expired token.',
            statusCode: 401
        });
    }

    try {
        const active = await sessionModel.isSessionActive(claims.sid);
        if (!active) {
            return res.status(401).json({
                success: false,
                error: 'Invalid or expired token.',
                statusCode: 401
            });
        }

        const user = await userModel.findById(claims.id);
        if (!user || user.isActive === false) {
            return res.status(401).json({
                success: false,
                error: 'Invalid or expired token.',
                statusCode: 401
            });
        }

        req.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            sid: claims.sid
        };
        return next();
    } catch (error) {
        return next(error);
    }
}

module.exports = { authenticateToken };