'use strict';

const express = require('express');
const productController = require('../controllers/productController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.use(authenticateToken);

/** Catalogue of active products, with search, sort and pagination. */
router.get('/', asyncHandler(productController.listCatalog));

/** One product. */
router.get('/:id', asyncHandler(productController.getProduct));

module.exports = router;
