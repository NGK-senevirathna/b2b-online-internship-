'use strict';

/**
 * Wraps an async Express handler so rejected promises reach the error middleware.
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<unknown>} handler Async route handler.
 * @returns {import('express').RequestHandler} Express-compatible handler.
 */
function asyncHandler(handler) {
    return function wrapped(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

module.exports = { asyncHandler };
