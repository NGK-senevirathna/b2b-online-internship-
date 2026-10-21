'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Limits each IP address to 100 requests per 15-minute window.
 * @type {import('express').RequestHandler}
 */
const rateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many requests. Please try again later.',
        statusCode: 429
    }
});

module.exports = rateLimiter;
