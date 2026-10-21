'use strict';

/**
 * Forwards a standardized not-found error to the global error handler.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express middleware callback.
 * @returns {void} Passes a 404 error to the next middleware.
 */
function notFoundHandler(req, res, next) {
    const error = new Error('Route not found.');
    error.statusCode = 404;
    error.expose = true;
    return next(error);
}

/**
 * Converts application and parser errors into a uniform JSON response.
 * Unexpected errors are logged but their details are not exposed.
 * @param {Error & {statusCode?: number, expose?: boolean, code?: string, type?: string}} error Error to handle.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Express middleware callback.
 * @returns {void} Sends a standardized failure response.
 */
function errorHandler(error, req, res, next) {
    if (res.headersSent) {
        return next(error);
    }

    let statusCode = 500;
    let message = 'An unexpected error occurred.';

    if (error.code === 'DUPLICATE_USER') {
        statusCode = 409;
        message = 'A user with that username or email already exists.';
    } else if (error.type === 'entity.parse.failed') {
        statusCode = 400;
        message = 'Request body contains invalid JSON.';
    } else if (error.type === 'entity.too.large') {
        statusCode = 413;
        message = 'Request body is too large.';
    } else if (error.expose === true && Number.isInteger(error.statusCode)) {
        statusCode = error.statusCode;
        message = error.message;
    }

    if (statusCode >= 500) {
        console.error(error);
    }

    return res.status(statusCode).json({
        success: false,
        error: message,
        statusCode
    });
}

module.exports = { notFoundHandler, errorHandler };
