'use strict';

const productModel = require('../models/productModel');
const auditService = require('./auditService');
const { getPool, withTransaction } = require('../config/database');
const { conflict, notFound } = require('../utils/httpError');

/**
 * Loads a product the actor is allowed to manage (its seller, or an Admin).
 * Other sellers receive 404 so product identifiers cannot be probed.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {{id: string, role: string}} user Authenticated user.
 * @param {string} productId Product id.
 * @param {{forUpdate?: boolean}} [options] Locking behaviour.
 * @returns {Promise<object>} The product.
 */
async function loadManagedProduct(db, user, productId, options) {
    const product = await productModel.findById(db, productId, options);
    if (!product || (user.role !== 'Admin' && product.sellerId !== user.id)) {
        throw notFound('Product not found.');
    }
    return product;
}

/**
 * Creates a product and records its opening stock.
 * @param {import('express').Request} req Authenticated request (Seller).
 * @param {{sku: string, name: string, description: string, priceCents: number, stockQuantity: number}} input Validated input.
 * @returns {Promise<object>} The created product.
 */
async function createProduct(req, input) {
    return withTransaction(async (db) => {
        let productId;
        try {
            productId = await productModel.create(db, { ...input, sellerId: req.user.id, stockQuantity: 0 });
        } catch (error) {
            if (error.code === 'DUPLICATE_SKU') throw conflict(error.message);
            throw error;
        }
        if (input.stockQuantity > 0) {
            await productModel.applyStockChange(db, {
                productId,
                delta: input.stockQuantity,
                reason: 'initial',
                actorId: req.user.id
            });
        }
        await auditService.record(db, req, {
            action: 'product.create',
            entityType: 'product',
            entityId: productId,
            details: { sku: input.sku, name: input.name, priceCents: input.priceCents, stockQuantity: input.stockQuantity }
        });
        return productModel.findById(db, productId);
    });
}

/**
 * Updates catalogue fields of a managed product.
 * @param {import('express').Request} req Authenticated request.
 * @param {string} productId Product id.
 * @param {{name?: string, description?: string, priceCents?: number, status?: string}} changes Validated changes.
 * @returns {Promise<object>} The updated product.
 */
async function updateProduct(req, productId, changes) {
    return withTransaction(async (db) => {
        const before = await loadManagedProduct(db, req.user, productId, { forUpdate: true });
        await productModel.update(db, productId, changes);

        const changed = {};
        for (const key of Object.keys(changes)) {
            if (changes[key] !== undefined && changes[key] !== before[key]) {
                changed[key] = { from: before[key], to: changes[key] };
            }
        }
        if (Object.keys(changed).length > 0) {
            await auditService.record(db, req, {
                action: changes.status === 'archived' && before.status !== 'archived' ? 'product.archive' : 'product.update',
                entityType: 'product',
                entityId: productId,
                details: { sku: before.sku, changed }
            });
        }
        return productModel.findById(db, productId);
    });
}

/**
 * Applies a manual stock adjustment.
 * @param {import('express').Request} req Authenticated request.
 * @param {string} productId Product id.
 * @param {{delta: number, note: string}} input Validated adjustment.
 * @returns {Promise<object>} The updated product.
 */
async function adjustStock(req, productId, input) {
    return withTransaction(async (db) => {
        const product = await loadManagedProduct(db, req.user, productId, { forUpdate: true });
        const quantityAfter = await productModel.applyStockChange(db, {
            productId,
            delta: input.delta,
            reason: 'adjustment',
            note: input.note,
            actorId: req.user.id
        });
        if (quantityAfter === null) {
            throw conflict('Stock cannot go below zero.', {
                code: 'STOCK_BELOW_ZERO',
                details: { available: product.stockQuantity, requestedChange: input.delta }
            });
        }
        await auditService.record(db, req, {
            action: 'stock.adjust',
            entityType: 'product',
            entityId: productId,
            details: { sku: product.sku, delta: input.delta, quantityAfter, note: input.note }
        });
        return productModel.findById(db, productId);
    });
}

/**
 * Returns a product to a viewer, hiding archived products from non-managers.
 * @param {{id: string, role: string}} user Authenticated user.
 * @param {string} productId Product id.
 * @returns {Promise<object>} The product.
 */
async function getVisibleProduct(user, productId) {
    const product = await productModel.findById(getPool(), productId);
    const canSeeArchived = user.role === 'Admin' || product?.sellerId === user.id;
    if (!product || (product.status === 'archived' && !canSeeArchived)) {
        throw notFound('Product not found.');
    }
    return product;
}

/**
 * Returns recent stock movements for a managed product.
 * @param {{id: string, role: string}} user Authenticated user.
 * @param {string} productId Product id.
 * @returns {Promise<object[]>} Movements, newest first.
 */
async function getStockHistory(user, productId) {
    await loadManagedProduct(getPool(), user, productId);
    return productModel.listMovements(getPool(), productId, 50);
}

module.exports = { createProduct, updateProduct, adjustStock, getVisibleProduct, getStockHistory };
