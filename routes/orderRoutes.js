'use strict';

const express = require('express');
const orderController = require('../controllers/orderController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.use(authenticateToken);

router.post('/', requireRoles('Buyer'), asyncHandler(orderController.checkout));
router.get('/', asyncHandler(orderController.list));
router.get('/:id', asyncHandler(orderController.get));
router.post('/:id/cancel', requireRoles('Buyer'), asyncHandler(orderController.cancel));
router.get('/:id/invoice', requireRoles('Buyer', 'Admin'), asyncHandler(orderController.invoice));

module.exports = router;
