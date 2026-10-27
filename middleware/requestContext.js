'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Assigns a correlation id to each request and exposes it as X-Request-Id.
 * Client-supplied ids are ignored so log lines cannot be forged.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express middleware callback.
 * @returns {void} Continues the request.
 */
function requestContext(req, res, next) {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
}

/**
 * Prevents browsers and proxies from caching API responses (they contain personal and order data).
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express middleware callback.
 * @returns {void} Continues the request.
 */
function noStore(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    next();
}

module.exports = { requestContext, noStore };
