'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const authRoutes = require('./routes/authRoutes');
const rateLimiter = require('./middleware/rateLimiter');
const { getJwtConfig } = require('./config/jwtConfig');
const { notFoundHandler, errorHandler } = require('./middleware/errorMiddleware');

/**
 * Creates the configured Express application.
 * @returns {import('express').Express} Configured application instance.
 */
function createApp() {
    const app = express();
    const allowedOrigins = (process.env.CORS_ORIGIN || '*')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    app.disable('x-powered-by');
    app.use(helmet());
    app.use(cors({
        origin(origin, callback) {
            if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(null, false);
        }
    }));
    app.use(express.json({ limit: '10kb' }));
    app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
    app.use(rateLimiter);

    /** Returns service readiness using the standard success response shape. */
    app.get('/', (req, res) => {
        return res.status(200).json({
            success: true,
            message: 'B2B Auth Microservice is running.',
            data: { status: 'ok' }
        });
    });

    app.use('/api/auth', authRoutes);
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

/**
 * Validates configuration and starts the HTTP server.
 * @returns {import('node:http').Server} Listening HTTP server.
 * @throws {Error} If the required JWT configuration is invalid.
 */
function startServer() {
    getJwtConfig();

    const app = createApp();
    const port = Number(process.env.PORT || '5000');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be a valid TCP port between 1 and 65535.');
    }

    return app.listen(port, () => {
        console.info(`B2B Auth Microservice listening on port ${port}.`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { createApp, startServer };
