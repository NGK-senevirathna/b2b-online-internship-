'use strict';

const express = require('express');
const adminController = require('../controllers/adminController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.use(authenticateToken, requireRoles('Admin'));

router.get('/summary', asyncHandler(adminController.summary));
router.get('/users', asyncHandler(adminController.listUsers));
router.patch('/users/:id', asyncHandler(adminController.updateUser));
router.patch('/orders/:id/status', asyncHandler(adminController.updateOrderStatus));
router.post('/orders/:id/invoice/pay', asyncHandler(adminController.markInvoicePaid));
router.get('/audit-logs', asyncHandler(adminController.auditLogs));

module.exports = router;
