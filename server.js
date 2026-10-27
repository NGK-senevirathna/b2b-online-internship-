'use strict';

require('dotenv').config();

const express = require('express');
const path = require('node:path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const sellerRoutes = require('./routes/sellerRoutes');
const cartRoutes = require('./routes/cartRoutes');
const orderRoutes = require('./routes/orderRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { createRateLimiters } = require('./middleware/rateLimiter');
const { requestContext, noStore } = require('./middleware/requestContext');
const { getAppConfig } = require('./config/appConfig');
const { getJwtConfig } = require('./config/jwtConfig');
const { notFoundHandler, errorHandler } = require('./middleware/errorMiddleware');
const { checkConnection, closePool } = require('./config/database');

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

    if (process.env.NODE_ENV === 'production' && allowedOrigins.includes('*')) {
        throw new Error('CORS_ORIGIN must list explicit trusted origins in production.');
    }

    app.disable('x-powered-by');
    if (process.env.TRUST_PROXY) {
        const trustProxy = /^\d+$/.test(process.env.TRUST_PROXY)
            ? Number(process.env.TRUST_PROXY)
            : process.env.TRUST_PROXY.split(',').map((value) => value.trim());
        app.set('trust proxy', trustProxy);
    }
    const limiters = createRateLimiters(getAppConfig().rateLimits, {
        usePostgres: process.env.NODE_ENV !== 'test'
    });
    app.locals.shutdown = () => limiters.shutdown();

    app.use(requestContext);
    app.use(helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                ...(process.env.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {})
            }
        },
        referrerPolicy: { policy: 'no-referrer' },
        crossOriginResourcePolicy: { policy: 'same-origin' }
    }));
    app.use(cors({
        origin(origin, callback) {
            if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(null, false);
        }
    }));
    app.use(express.json({ limit: '10kb' }));
    morgan.token('id', (req) => req.id);
    app.use(morgan(process.env.NODE_ENV === 'production'
        ? ':remote-addr :id ":method :url" :status :res[content-length] :response-time ms'
        : 'dev'));
    app.use('/app', express.static(path.join(__dirname, 'frontend'), {
        index: 'index.html',
        maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
    }));

    /** Returns service liveness using the standard success response shape. */
    app.get('/', (req, res) => {
        return res.status(200).json({
            success: true,
            message: 'B2B Order Management Platform is running.',
            data: { status: 'ok' }
        });
    });

    /** Returns liveness for container and load-balancer health checks. */
    app.get('/health/live', (req, res) => {
        return res.status(200).json({
            success: true,
            message: 'Service is live.',
            data: { status: 'ok' }
        });
    });

    /** Verifies PostgreSQL connectivity before reporting readiness. */
    app.get('/health/ready', async (req, res, next) => {
        try {
            await checkConnection();
            return res.status(200).json({
                success: true,
                message: 'Service is ready.',
                data: { status: 'ready', database: 'connected' }
            });
        } catch (error) {
            return next(error);
        }
    });

    app.use('/api', noStore, limiters.api);
    app.post('/api/auth/login', limiters.login);
    app.post('/api/auth/register', limiters.register);
    app.use('/api/auth', authRoutes);
    app.use('/api/products', productRoutes);
    app.use('/api/seller', sellerRoutes);
    app.use('/api/cart', cartRoutes);
    app.use('/api/orders', orderRoutes);
    app.use('/api/admin', adminRoutes);
    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

/**
 * Validates configuration and starts the HTTP server.
 * @returns {Promise<import('node:http').Server>} Listening HTTP server.
 * @throws {Error} If the required JWT configuration is invalid.
 */
async function startServer() {
    getJwtConfig();
    if (
        process.env.NODE_ENV === 'production' &&
        (typeof process.env.ROLE_PROVISIONING_KEY !== 'string' ||
            process.env.ROLE_PROVISIONING_KEY.length < 32 ||
            process.env.ROLE_PROVISIONING_KEY.toLowerCase().includes('replace-this'))
    ) {
        throw new Error('ROLE_PROVISIONING_KEY must be configured with at least 32 non-placeholder characters in production.');
    }
    await checkConnection();

    const app = createApp();
    const port = Number(process.env.PORT || '5000');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be a valid TCP port between 1 and 65535.');
    }

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            console.info(`B2B Order Management Platform listening on port ${port}.`);
            // Stop background limiter work whenever the server closes (shutdown or tests).
            server.once('close', () => app.locals.shutdown());
            resolve(server);
        });
        server.once('error', reject);
    });
}

if (require.main === module) {
    startServer()
        .then((server) => {
            let shuttingDown = false;
            const shutdown = (signal) => {
                if (shuttingDown) return;
                shuttingDown = true;
                console.info(`${signal} received; closing HTTP server.`);
                server.close(async (error) => {
                    try {
                        await closePool();
                    } catch (closeError) {
                        console.error('Failed to close PostgreSQL pool cleanly.', closeError);
                        process.exitCode = 1;
                    }
                    if (error) {
                        console.error('Failed to close HTTP server cleanly.', error);
                        process.exitCode = 1;
                    }
                });
            };

            process.once('SIGINT', () => shutdown('SIGINT'));
            process.once('SIGTERM', () => shutdown('SIGTERM'));
        })
        .catch((error) => {
            console.error('Service startup failed.', error);
            closePool().catch((closeError) => {
                console.error('Failed to close PostgreSQL pool after startup failure.', closeError);
            });
            process.exitCode = 1;
        });
}

module.exports = { createApp, startServer };
