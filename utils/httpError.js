'use strict';

/**
 * Error that is safe to show to API clients.
 * The central error handler serializes it using the standard failure shape.
 */
class HttpError extends Error {
    /**
     * @param {number} statusCode HTTP status code.
     * @param {string} message Client-safe message.
     * @param {{code?: string, details?: object}} [options] Machine-readable code and extra detail.
     */
    constructor(statusCode, message, options = {}) {
        super(message);
        this.name = 'HttpError';
        this.statusCode = statusCode;
        this.expose = true;
        this.code = options.code;
        this.details = options.details;
    }
}

const badRequest = (message, options) => new HttpError(400, message, options);
const forbidden = (message = 'Access forbidden: insufficient permissions.') => new HttpError(403, message);
const notFound = (message = 'Resource not found.') => new HttpError(404, message);
const conflict = (message, options) => new HttpError(409, message, options);

module.exports = { HttpError, badRequest, forbidden, notFound, conflict };
