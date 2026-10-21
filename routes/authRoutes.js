'use strict';

const express = require('express');
const {
    register,
    login,
    refresh,
    logout,
    getMe,
    getSellerPanel,
    getAdminDashboard
} = require('../controllers/authController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');

const router = express.Router();

/** Registers a user account. */
router.post('/register', register);

/** Authenticates a user and issues a signed JWT. */
router.post('/login', login);

/** Exchanges a valid refresh token for a rotated token pair. */
router.post('/refresh', refresh);

/** Revokes the current session and its refresh-token family. */
router.post('/logout', authenticateToken, logout);

/** Returns the current profile to any authenticated user. */
router.get('/me', authenticateToken, getMe);

/** Grants access to Seller and Admin users. */
router.get('/seller-panel', authenticateToken, requireRoles('Seller', 'Admin'), getSellerPanel);

/** Grants access exclusively to Admin users. */
router.get('/admin-dashboard', authenticateToken, requireRoles('Admin'), getAdminDashboard);

module.exports = router;