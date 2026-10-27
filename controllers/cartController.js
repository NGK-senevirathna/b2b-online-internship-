'use strict';

const cartModel = require('../models/cartModel');
const productModel = require('../models/productModel');
const { getPool } = require('../config/database');
const { getAppConfig } = require('../config/appConfig');
const { calculateTax } = require('../utils/money');
const { conflict, notFound } = require('../utils/httpError');
const v = require('../utils/validation');

/**
 * Builds the cart response with live prices, totals and per-line availability issues.
 * @param {string} userId Buyer id.
 * @returns {Promise<object>} Cart representation.
 */
async function buildCart(userId) {
    const lines = await cartModel.listItems(getPool(), userId);
    const items = lines.map((line) => {
        let issue = null;
        if (line.status !== 'active') issue = 'unavailable';
        else if (line.quantity > line.stockQuantity) issue = 'insufficient_stock';
        return {
            productId: line.productId,
            sku: line.sku,
            name: line.name,
            unitPriceCents: line.unitPriceCents,
            quantity: line.quantity,
            lineTotalCents: line.unitPriceCents * line.quantity,
            availableQuantity: line.stockQuantity,
            issue
        };
    });
    const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
    const taxCents = calculateTax(subtotalCents, getAppConfig().taxRateBps);
    return {
        items,
        subtotalCents,
        taxCents,
        totalCents: subtotalCents + taxCents,
        canCheckout: items.length > 0 && items.every((item) => item.issue === null)
    };
}

/** Returns the buyer's cart. */
async function getCart(req, res) {
    return res.status(200).json({ success: true, message: 'Cart retrieved.', data: { cart: await buildCart(req.user.id) } });
}

/** Sets the quantity of one product in the cart. */
async function setItem(req, res) {
    const productId = v.uuid(req.params.productId, 'productId');
    const body = v.exactObject(req.body, ['quantity']);
    const quantity = v.integer(body.quantity, 'quantity', { min: 1, max: 10000 });

    const product = await productModel.findById(getPool(), productId);
    if (!product || product.status !== 'active') throw notFound('Product not found.');
    if (quantity > product.stockQuantity) {
        throw conflict(`Only ${product.stockQuantity} unit(s) of this product are available.`, {
            code: 'INSUFFICIENT_STOCK',
            details: { available: product.stockQuantity }
        });
    }

    const cartId = await cartModel.ensureCart(getPool(), req.user.id);
    const { maxCartLines } = getAppConfig();
    if (!await cartModel.hasItem(getPool(), cartId, productId) && await cartModel.countLines(getPool(), cartId) >= maxCartLines) {
        throw conflict(`A cart can hold at most ${maxCartLines} different products.`, { code: 'CART_FULL' });
    }
    await cartModel.setItem(getPool(), cartId, productId, quantity);
    return res.status(200).json({ success: true, message: 'Cart updated.', data: { cart: await buildCart(req.user.id) } });
}

/** Removes one product from the cart. */
async function removeItem(req, res) {
    const productId = v.uuid(req.params.productId, 'productId');
    const cartId = await cartModel.ensureCart(getPool(), req.user.id);
    await cartModel.removeItem(getPool(), cartId, productId);
    return res.status(200).json({ success: true, message: 'Item removed.', data: { cart: await buildCart(req.user.id) } });
}

/** Empties the cart. */
async function clearCart(req, res) {
    const cartId = await cartModel.ensureCart(getPool(), req.user.id);
    await cartModel.clear(getPool(), cartId);
    return res.status(200).json({ success: true, message: 'Cart cleared.', data: { cart: await buildCart(req.user.id) } });
}

module.exports = { getCart, setItem, removeItem, clearCart };
