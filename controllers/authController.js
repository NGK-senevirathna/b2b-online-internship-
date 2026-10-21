'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');
const { getJwtConfig } = require('../config/jwtConfig');

const SUPPORTED_ROLES = new Set(['Buyer', 'Seller', 'Admin']);
const BCRYPT_SALT_ROUNDS = 12;
const MAX_PASSWORD_BYTES = 72;

/**
 * Creates an account after validating its fields and hashing its password.
 * Public account creation defaults to Buyer; Seller and Admin creation
 * require the separately configured role-provisioning key.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express error callback.
 * @returns {Promise<void>} Resolves after the response or forwarded error.
 */
async function register(req, res, next) {
    try {
        const { username, email, password } = req.body || {};
        const requestedRole = req.body?.role ?? 'Buyer';

        if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,30}$/.test(username.trim())) {
            return res.status(400).json({
                success: false,
                error: 'Username must be 3-30 characters and contain only letters, numbers, dots, underscores, or hyphens.',
                statusCode: 400
            });
        }

        if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            return res.status(400).json({
                success: false,
                error: 'A valid email address is required.',
                statusCode: 400
            });
        }

        if (
            typeof password !== 'string' ||
            password.length < 8 ||
            Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
        ) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 8 characters and no more than 72 UTF-8 bytes.',
                statusCode: 400
            });
        }

        if (typeof requestedRole !== 'string' || !SUPPORTED_ROLES.has(requestedRole)) {
            return res.status(400).json({
                success: false,
                error: 'Role must be Buyer, Seller, or Admin.',
                statusCode: 400
            });
        }

        if (requestedRole !== 'Buyer' && !isValidRoleProvisioningKey(req)) {
            return res.status(403).json({
                success: false,
                error: 'Seller and Admin registration require a valid role-provisioning key.',
                statusCode: 403
            });
        }

        const normalizedUsername = username.trim();
        const normalizedEmail = email.trim().toLowerCase();
        const duplicateUsername = await userModel.findByUsername(normalizedUsername);
        const duplicateEmail = await userModel.findByEmail(normalizedEmail);

        if (duplicateUsername || duplicateEmail) {
            return res.status(409).json({
                success: false,
                error: 'A user with that username or email already exists.',
                statusCode: 409
            });
        }

        const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
        const user = await userModel.createUser({
            username: normalizedUsername,
            email: normalizedEmail,
            passwordHash,
            role: requestedRole
        });

        return res.status(201).json({
            success: true,
            message: 'User registered successfully.',
            data: { user: toPublicUser(user) }
        });
    } catch (error) {
        return next(error);
    }
}

/**
 * Authenticates a user by username, email, or identifier and issues a JWT.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express error callback.
 * @returns {Promise<void>} Resolves after the response or forwarded error.
 */
async function login(req, res, next) {
    try {
        const { username, email, identifier, password } = req.body || {};
        const loginIdentifier = identifier ?? username ?? email;

        if (
            typeof loginIdentifier !== 'string' ||
            loginIdentifier.trim().length === 0 ||
            typeof password !== 'string'
        ) {
            return res.status(400).json({
                success: false,
                error: 'A username or email and password are required.',
                statusCode: 400
            });
        }

        const user = await userModel.findByIdentifier(loginIdentifier.trim());
        const passwordMatches = user
            ? await bcrypt.compare(password, user.passwordHash)
            : false;

        if (!passwordMatches) {
            return res.status(401).json({
                success: false,
                error: 'Invalid username/email or password.',
                statusCode: 401
            });
        }

        const jwtConfig = getJwtConfig();
        const refreshToken = generateRefreshToken();
        const sessionExpiry = getRefreshTokenExpiry();
        const session = await sessionModel.createSession(user.id, hashRefreshToken(refreshToken), sessionExpiry);
        const token = issueAccessToken(user, session.id);

        return res.status(200).json({
            success: true,
            message: 'Login successful.',
            data: {
                token,
                tokenType: 'Bearer',
                expiresIn: jwtConfig.expiresIn,
                refreshToken,
                refreshTokenExpiresAt: sessionExpiry.toISOString(),
                user: toPublicUser(user)
            }
        });
    } catch (error) {
        return next(error);
    }
}

/**
 * Rotates a refresh token and issues a replacement access/refresh token pair.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express error callback.
 * @returns {Promise<void>} Resolves after the response or forwarded error.
 */
async function refresh(req, res, next) {
    try {
        const presentedToken = req.body?.refreshToken;
        if (typeof presentedToken !== 'string' || presentedToken.length < 40 || presentedToken.length > 128) {
            return res.status(400).json({
                success: false,
                error: 'A valid refreshToken is required.',
                statusCode: 400
            });
        }

        const replacementToken = generateRefreshToken();
        const expiresAt = getRefreshTokenExpiry();
        const result = await sessionModel.rotateRefreshToken(
            hashRefreshToken(presentedToken),
            hashRefreshToken(replacementToken),
            expiresAt
        );

        if (result.status !== 'rotated') {
            return res.status(401).json({
                success: false,
                error: result.status === 'reuse'
                    ? 'Refresh token reuse detected. The session has been revoked.'
                    : 'Invalid or expired refresh token.',
                statusCode: 401
            });
        }

        const user = await userModel.findById(result.userId);
        if (!user) {
            await sessionModel.revokeSession(result.sessionId);
            return res.status(401).json({
                success: false,
                error: 'The account for this session is unavailable.',
                statusCode: 401
            });
        }

        const jwtConfig = getJwtConfig();
        return res.status(200).json({
            success: true,
            message: 'Token refreshed successfully.',
            data: {
                token: issueAccessToken(user, result.sessionId),
                tokenType: 'Bearer',
                expiresIn: jwtConfig.expiresIn,
                refreshToken: replacementToken,
                refreshTokenExpiresAt: expiresAt.toISOString(),
                user: toPublicUser(user)
            }
        });
    } catch (error) {
        return next(error);
    }
}

/**
 * Revokes the current authenticated session and all refresh tokens in its family.
 * @param {import('express').Request} req Authenticated Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express error callback.
 * @returns {Promise<void>} Resolves after the response or forwarded error.
 */
async function logout(req, res, next) {
    try {
        await sessionModel.revokeSession(req.user.sid);
        return res.status(200).json({
            success: true,
            message: 'Session logged out successfully.',
            data: { loggedOut: true }
        });
    } catch (error) {
        return next(error);
    }
}

/**
 * Returns the authenticated user's public profile.
 * @param {import('express').Request} req Authenticated Express request.
 * @param {import('express').Response} res Express response.
 * @returns {void} Sends the profile response.
 */
function getMe(req, res) {
    return res.status(200).json({
        success: true,
        message: 'Authenticated user profile.',
        data: { user: toPublicUser(req.user) }
    });
}

/**
 * Returns the Seller workspace for authorized Seller and Admin users.
 * @param {import('express').Request} req Authenticated Express request.
 * @param {import('express').Response} res Express response.
 * @returns {void} Sends the Seller workspace response.
 */
function getSellerPanel(req, res) {
    return res.status(200).json({
        success: true,
        message: 'Seller panel access granted.',
        data: { user: toPublicUser(req.user), panel: 'seller' }
    });
}

/**
 * Returns the Admin dashboard for authorized Admin users.
 * @param {import('express').Request} req Authenticated Express request.
 * @param {import('express').Response} res Express response.
 * @returns {void} Sends the Admin dashboard response.
 */
function getAdminDashboard(req, res) {
    return res.status(200).json({
        success: true,
        message: 'Admin dashboard access granted.',
        data: { user: toPublicUser(req.user), dashboard: 'admin' }
    });
}

/**
 * Compares the supplied role-provisioning key with the configured key.
 * @param {import('express').Request} req Express request.
 * @returns {boolean} Whether the request presents the configured key.
 */
function isValidRoleProvisioningKey(req) {
    const configuredKey = process.env.ROLE_PROVISIONING_KEY;
    const providedKey = req.get('x-role-provisioning-key');

    if (typeof configuredKey !== 'string' || configuredKey.length < 32 || !providedKey) {
        return false;
    }

    const expected = Buffer.from(configuredKey, 'utf8');
    const provided = Buffer.from(providedKey, 'utf8');
    return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/**
 * Removes password hashes and internal persistence fields from a user record.
 * @param {object} user Stored user record.
 * @returns {{id: string, username: string, email: string, role: string}} Public profile.
 */
function toPublicUser(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
    };
}

/**
 * Issues a short-lived access JWT tied to a revocable server-side session.
 * @param {object} user Persisted user record.
 * @param {string} sessionId Authentication session identifier.
 * @returns {string} Signed access token.
 */
function issueAccessToken(user, sessionId) {
    const jwtConfig = getJwtConfig();
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            sid: sessionId
        },
        jwtConfig.secret,
        {
            algorithm: 'HS256',
            expiresIn: jwtConfig.expiresIn,
            issuer: jwtConfig.issuer,
            audience: jwtConfig.audience,
            subject: user.id
        }
    );
}

/**
 * Generates a high-entropy opaque refresh token.
 * @returns {string} Base64url-encoded random token.
 */
function generateRefreshToken() {
    return randomBytes(48).toString('base64url');
}

/**
 * Hashes a refresh token before it is stored in persistent storage.
 * @param {string} token Opaque refresh token.
 * @returns {string} SHA-256 hex digest.
 */
function hashRefreshToken(token) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Calculates the absolute refresh session expiry from validated configuration.
 * @returns {Date} Expiration timestamp.
 */
function getRefreshTokenExpiry() {
    const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS || '30');
    if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new Error('REFRESH_TOKEN_TTL_DAYS must be a whole number from 1 to 365.');
    }
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

module.exports = {
    register,
    login,
    refresh,
    logout,
    getMe,
    getSellerPanel,
    getAdminDashboard
};
