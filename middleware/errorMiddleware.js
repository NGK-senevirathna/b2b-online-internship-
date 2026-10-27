'use strict';

/**
 * Maps selected PostgreSQL error codes to safe client responses.
 * Anything not listed is treated as an internal error and never exposed.
 */
const DATABASE_ERRORS = {
    '22P02': { statusCode: 400, message: 'A value in the request has an invalid format.' },
    '23503': { statusCode: 409, message: 'The request conflicts with related records.' },
    '23505': { statusCode: 409, message: 'A record with these values already exists.' },
    '23514': { statusCode: 400, message: 'A value in the request is outside the allowed range.' },
    '40001': { statusCode: 503, message: 'The service is busy. Please retry.' },
    '40P01': { statusCode: 503, message: 'The service is busy. Please retry.' },
    '57014': { statusCode: 503, message: 'The request took too long. Please retry.' }
};

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
 * Converts application, parser and database errors into a uniform JSON response.
 * Unexpected errors are logged with the request id, but their details are not exposed.
 * @param {Error & {statusCode?: number, expose?: boolean, code?: string, type?: string, details?: object}} error Error to handle.
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
    let code;
    let details;

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
        code = error.code;
        details = error.details;
    } else if (typeof error.code === 'string' && DATABASE_ERRORS[error.code]) {
        ({ statusCode, message } = DATABASE_ERRORS[error.code]);
    }

    if (statusCode >= 500) {
        console.error(`[${req.id ?? 'no-request-id'}]`, error);
    }

    return res.status(statusCode).json({
        success: false,
        error: message,
        statusCode,
        ...(code ? { code } : {}),
        ...(details ? { details } : {})
    });
}

module.exports = { notFoundHandler, errorHandler };
