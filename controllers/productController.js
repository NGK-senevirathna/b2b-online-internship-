'use strict';

const productModel = require('../models/productModel');
const productService = require('../services/productService');
const { getPool } = require('../config/database');
const { getAppConfig } = require('../config/appConfig');
const { badRequest } = require('../utils/httpError');
const v = require('../utils/validation');

const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
const SORT_OPTIONS = ['name', 'newest', 'price_asc', 'price_desc'];
const MAX_PRICE_CENTS = 100000000;
const MAX_STOCK = 1000000;

/**
 * Formats a product for API responses, adding a derived stock status.
 * @param {object} product Product row.
 * @returns {object} API representation.
 */
function presentProduct(product) {
    const { lowStockThreshold } = getAppConfig();
    let stockStatus = 'in_stock';
    if (product.stockQuantity === 0) stockStatus = 'out_of_stock';
    else if (product.stockQuantity <= lowStockThreshold) stockStatus = 'low_stock';
    return { ...product, stockStatus };
}

/**
 * Parses an optional "true" query flag.
 * @param {unknown} value Raw query value.
 * @param {string} field Field name used in error messages.
 * @returns {boolean} Whether the flag was set.
 */
function booleanFlag(value, field) {
    if (value === undefined) return false;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw badRequest(`${field} must be true or false.`);
}

/** Lists active products for any signed-in user (the catalogue). */
async function listCatalog(req, res) {
    const paging = v.pagination(req.query);
    const { rows, total } = await productModel.search(getPool(), {
        status: 'active',
        search: v.optionalQueryText(req.query.q, 'q'),
        sort: req.query.sort === undefined ? 'name' : v.oneOf(req.query.sort, 'sort', SORT_OPTIONS),
        inStockOnly: booleanFlag(req.query.inStock, 'inStock'),
        ...paging
    });
    return res.status(200).json({
        success: true,
        message: 'Products retrieved.',
        data: { products: rows.map(presentProduct), pagination: v.pageInfo(paging, total) }
    });
}

/** Returns one product. */
async function getProduct(req, res) {
    const product = await productService.getVisibleProduct(req.user, v.uuid(req.params.id, 'id'));
    return res.status(200).json({ success: true, message: 'Product retrieved.', data: { product: presentProduct(product) } });
}

/** Lists the seller's own products (all products for Admin), including archived ones. */
async function listManaged(req, res) {
    const paging = v.pagination(req.query);
    const { rows, total } = await productModel.search(getPool(), {
        sellerId: req.user.role === 'Seller' ? req.user.id : undefined,
        status: req.query.status === undefined ? undefined : v.oneOf(req.query.status, 'status', ['active', 'archived']),
        search: v.optionalQueryText(req.query.q, 'q'),
        lowStockAt: booleanFlag(req.query.lowStock, 'lowStock') ? getAppConfig().lowStockThreshold : undefined,
        sort: req.query.sort === undefined ? 'name' : v.oneOf(req.query.sort, 'sort', SORT_OPTIONS),
        ...paging
    });
    return res.status(200).json({
        success: true,
        message: 'Products retrieved.',
        data: { products: rows.map(presentProduct), pagination: v.pageInfo(paging, total) }
    });
}

/** Creates a product owned by the signed-in Seller. */
async function create(req, res) {
    const body = v.exactObject(req.body, ['sku', 'name', 'description', 'priceCents', 'stockQuantity']);
    const input = {
        sku: v.text(body.sku, 'sku', { min: 2, max: 40, pattern: SKU_PATTERN, patternMessage: 'sku may contain letters, numbers, dots, underscores and hyphens.' }),
        name: v.text(body.name, 'name', { min: 2, max: 120 }),
        description: body.description === undefined ? '' : v.text(body.description, 'description', { max: 2000, allowEmpty: true }),
        priceCents: v.integer(body.priceCents, 'priceCents', { min: 1, max: MAX_PRICE_CENTS }),
        stockQuantity: body.stockQuantity === undefined ? 0 : v.integer(body.stockQuantity, 'stockQuantity', { min: 0, max: MAX_STOCK })
    };
    const product = await productService.createProduct(req, input);
    return res.status(201).json({ success: true, message: 'Product created.', data: { product: presentProduct(product) } });
}

/** Updates catalogue fields of a managed product. */
async function update(req, res) {
    const body = v.exactObject(req.body, ['name', 'description', 'priceCents', 'status']);
    const changes = {};
    if (body.name !== undefined) changes.name = v.text(body.name, 'name', { min: 2, max: 120 });
    if (body.description !== undefined) changes.description = v.text(body.description, 'description', { max: 2000, allowEmpty: true });
    if (body.priceCents !== undefined) changes.priceCents = v.integer(body.priceCents, 'priceCents', { min: 1, max: MAX_PRICE_CENTS });
    if (body.status !== undefined) changes.status = v.oneOf(body.status, 'status', ['active', 'archived']);
    if (Object.keys(changes).length === 0) throw badRequest('Provide at least one field to update.');

    const product = await productService.updateProduct(req, v.uuid(req.params.id, 'id'), changes);
    return res.status(200).json({ success: true, message: 'Product updated.', data: { product: presentProduct(product) } });
}

/** Archives a product (soft delete: history and past orders stay intact). */
async function archive(req, res) {
    const product = await productService.updateProduct(req, v.uuid(req.params.id, 'id'), { status: 'archived' });
    return res.status(200).json({ success: true, message: 'Product archived.', data: { product: presentProduct(product) } });
}

/** Adjusts stock by a positive or negative amount with a mandatory note. */
async function adjustStock(req, res) {
    const body = v.exactObject(req.body, ['delta', 'note']);
    const input = {
        delta: v.integer(body.delta, 'delta', { min: -MAX_STOCK, max: MAX_STOCK, nonZero: true }),
        note: v.text(body.note, 'note', { min: 3, max: 200 })
    };
    const product = await productService.adjustStock(req, v.uuid(req.params.id, 'id'), input);
    return res.status(200).json({ success: true, message: 'Stock updated.', data: { product: presentProduct(product) } });
}

/** Returns recent stock movements for a managed product. */
async function stockHistory(req, res) {
    const movements = await productService.getStockHistory(req.user, v.uuid(req.params.id, 'id'));
    return res.status(200).json({ success: true, message: 'Stock history retrieved.', data: { movements } });
}

module.exports = { listCatalog, getProduct, listManaged, create, update, archive, adjustStock, stockHistory };
