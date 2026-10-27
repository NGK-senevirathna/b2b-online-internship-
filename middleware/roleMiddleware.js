'use strict';

/**
 * Creates middleware that permits only users with one of the supplied roles.
 * @param {...string} allowedRoles Roles allowed to access the route.
 * @returns {import('express').RequestHandler} Role authorization middleware.
 */
function requireRoles(...allowedRoles) {
    /**
     * Enforces role-based access for an authenticated request.
     * @param {import('express').Request} req Authenticated Express request.
     * @param {import('express').Response} res Express response.
     * @param {import('express').NextFunction} next Express middleware callback.
     * @returns {void} Continues when authorized, otherwise sends a 403 response.
     */
    return function roleAuthorization(req, res, next) {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Access forbidden: insufficient permissions.',
                statusCode: 403
            });
        }

        return next();
    };
}

module.exports = { requireRoles };
