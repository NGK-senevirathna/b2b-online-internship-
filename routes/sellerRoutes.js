'use strict';

const express = require('express');
const productController = require('../controllers/productController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.use(authenticateToken, requireRoles('Seller', 'Admin'));

/** Lists managed products (own for Seller, all for Admin), including archived ones. */
router.get('/products', asyncHandler(productController.listManaged));

/** Only Sellers own products, so only Sellers create them. */
router.post('/products', requireRoles('Seller'), asyncHandler(productController.create));

router.patch('/products/:id', asyncHandler(productController.update));
router.delete('/products/:id', asyncHandler(productController.archive));
router.post('/products/:id/stock', asyncHandler(productController.adjustStock));
router.get('/products/:id/stock-history', asyncHandler(productController.stockHistory));

module.exports = router;
