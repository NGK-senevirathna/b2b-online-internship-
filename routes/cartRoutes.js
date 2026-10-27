'use strict';

const express = require('express');
const cartController = require('../controllers/cartController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.use(authenticateToken, requireRoles('Buyer'));

router.get('/', asyncHandler(cartController.getCart));
router.delete('/', asyncHandler(cartController.clearCart));
router.put('/items/:productId', asyncHandler(cartController.setItem));
router.delete('/items/:productId', asyncHandler(cartController.removeItem));

module.exports = router;
