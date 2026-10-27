'use strict';

const cartModel = require('../models/cartModel');
const productModel = require('../models/productModel');
const orderModel = require('../models/orderModel');
const invoiceModel = require('../models/invoiceModel');
const auditService = require('./auditService');
const { getPool, withTransaction } = require('../config/database');
const { getAppConfig } = require('../config/appConfig');
const { calculateTax } = require('../utils/money');
const { conflict, notFound, forbidden } = require('../utils/httpError');

/** Allowed order status changes. A status absent from a list cannot be reached from the key. */
const TRANSITIONS = Object.freeze({
    pending: ['confirmed', 'cancelled'],
    confirmed: ['shipped', 'cancelled'],
    shipped: ['delivered'],
    delivered: [],
    cancelled: []
});

/**
 * Converts a checkout into an order, atomically.
 * Steps: lock the buyer's cart (serializes double submits), replay an earlier order for the
 * same idempotency key, lock products in id order (no deadlocks, no overselling), validate
 * availability, decrement stock, then create order, lines, invoice and audit record.
 * @param {import('express').Request} req Authenticated Buyer request.
 * @param {{shippingAddress: string, idempotencyKey?: string}} input Validated input.
 * @returns {Promise<{orderId: string, replayed: boolean}>} The order id and whether it already existed.
 */
async function checkout(req, input) {
    const buyerId = req.user.id;

    return withTransaction(async (db) => {
        const cartId = await cartModel.lockCart(db, buyerId);

        if (input.idempotencyKey) {
            const existingId = await orderModel.findIdByIdempotencyKey(db, buyerId, input.idempotencyKey);
            if (existingId) return { orderId: existingId, replayed: true };
        }

        const cartLines = await cartModel.listItems(db, buyerId);
        if (cartLines.length === 0) {
            throw conflict('Your cart is empty.', { code: 'CART_EMPTY' });
        }

        const products = await productModel.lockMany(db, cartLines.map((line) => line.productId));
        const byId = new Map(products.map((product) => [product.id, product]));

        const problems = [];
        const orderLines = [];
        for (const line of cartLines) {
            const product = byId.get(line.productId);
            if (!product || product.status !== 'active') {
                problems.push({ productId: line.productId, name: line.name, reason: 'unavailable' });
            } else if (line.quantity > product.stockQuantity) {
                problems.push({
                    productId: product.id,
                    name: product.name,
                    reason: 'insufficient_stock',
                    requested: line.quantity,
                    available: product.stockQuantity
                });
            } else {
                orderLines.push({
                    productId: product.id,
                    sellerId: product.sellerId,
                    sku: product.sku,
                    name: product.name,
                    unitPriceCents: product.priceCents,
                    quantity: line.quantity
                });
            }
        }
        if (problems.length > 0) {
            throw conflict('Some items in your cart can no longer be ordered.', {
                code: 'CART_ITEMS_UNAVAILABLE',
                details: { items: problems }
            });
        }

        const subtotalCents = orderLines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
        const taxCents = calculateTax(subtotalCents, getAppConfig().taxRateBps);
        const totalCents = subtotalCents + taxCents;

        const orderId = await orderModel.insertOrder(db, {
            buyerId,
            shippingAddress: input.shippingAddress,
            subtotalCents,
            taxCents,
            totalCents,
            idempotencyKey: input.idempotencyKey
        });
        await orderModel.insertItems(db, orderId, orderLines);

        for (const line of orderLines) {
            const remaining = await productModel.applyStockChange(db, {
                productId: line.productId,
                delta: -line.quantity,
                reason: 'order',
                orderId,
                actorId: buyerId
            });
            if (remaining === null) {
                // Unreachable while rows are locked, but fail closed rather than oversell.
                throw conflict('Stock changed while ordering. Please review your cart.', { code: 'STOCK_CHANGED' });
            }
        }

        await invoiceModel.create(db, { orderId, buyerId, subtotalCents, taxCents, totalCents });
        await cartModel.clear(db, cartId);
        await auditService.record(db, req, {
            action: 'order.create',
            entityType: 'order',
            entityId: orderId,
            details: { itemCount: orderLines.length, subtotalCents, taxCents, totalCents }
        });
        return { orderId, replayed: false };
    });
}

/**
 * Cancels an order inside an open transaction: restores stock, voids the invoice, records audit.
 * @param {{query: Function}} db Transaction client.
 * @param {import('express').Request} req Request supplying actor context.
 * @param {object} order Locked order row.
 * @returns {Promise<void>} Resolves when the order is cancelled.
 */
async function cancelWithinTransaction(db, req, order) {
    const items = await orderModel.listItems(db, order.id);
    const productIds = [...new Set(items.map((item) => item.productId))];
    await productModel.lockMany(db, productIds);

    for (const item of items) {
        await productModel.applyStockChange(db, {
            productId: item.productId,
            delta: item.quantity,
            reason: 'cancellation',
            orderId: order.id,
            actorId: req.user.id
        });
    }
    await orderModel.updateStatus(db, order.id, 'cancelled');
    await invoiceModel.voidForOrder(db, order.id);
    await auditService.record(db, req, {
        action: 'order.cancel',
        entityType: 'order',
        entityId: order.id,
        details: { orderNumber: order.orderNumber, previousStatus: order.status }
    });
}

/**
 * Cancels the buyer's own order while it is still pending.
 * @param {import('express').Request} req Authenticated Buyer request.
 * @param {string} orderId Order id.
 * @returns {Promise<void>} Resolves after cancellation.
 */
async function cancelOwnOrder(req, orderId) {
    await withTransaction(async (db) => {
        const order = await orderModel.findById(db, orderId, { forUpdate: true });
        if (!order || order.buyerId !== req.user.id) throw notFound('Order not found.');
        if (order.status !== 'pending') {
            throw conflict('Only pending orders can be cancelled. Contact an administrator for later stages.', {
                code: 'ORDER_NOT_CANCELLABLE'
            });
        }
        await cancelWithinTransaction(db, req, order);
    });
}

/**
 * Moves an order to a new status following the allowed workflow (Admin).
 * @param {import('express').Request} req Authenticated Admin request.
 * @param {string} orderId Order id.
 * @param {string} nextStatus Target status.
 * @returns {Promise<void>} Resolves after the transition.
 */
async function transitionOrder(req, orderId, nextStatus) {
    await withTransaction(async (db) => {
        const order = await orderModel.findById(db, orderId, { forUpdate: true });
        if (!order) throw notFound('Order not found.');
        if (!TRANSITIONS[order.status].includes(nextStatus)) {
            throw conflict(`An order that is ${order.status} cannot become ${nextStatus}.`, {
                code: 'INVALID_TRANSITION',
                details: { from: order.status, to: nextStatus, allowed: TRANSITIONS[order.status] }
            });
        }
        if (nextStatus === 'cancelled') {
            await cancelWithinTransaction(db, req, order);
            return;
        }
        await orderModel.updateStatus(db, orderId, nextStatus);
        await auditService.record(db, req, {
            action: 'order.status',
            entityType: 'order',
            entityId: orderId,
            details: { orderNumber: order.orderNumber, from: order.status, to: nextStatus }
        });
    });
}

/**
 * Marks an order's invoice as paid (Admin).
 * @param {import('express').Request} req Authenticated Admin request.
 * @param {string} orderId Order id.
 * @returns {Promise<void>} Resolves after payment is recorded.
 */
async function markInvoicePaid(req, orderId) {
    await withTransaction(async (db) => {
        const order = await orderModel.findById(db, orderId, { forUpdate: true });
        if (!order) throw notFound('Order not found.');
        const updated = order.status !== 'cancelled' && await invoiceModel.markPaid(db, orderId);
        if (!updated) {
            throw conflict('This invoice cannot be marked as paid.', { code: 'INVOICE_NOT_PAYABLE' });
        }
        await auditService.record(db, req, {
            action: 'invoice.paid',
            entityType: 'invoice',
            entityId: order.invoiceId,
            details: { invoiceNumber: order.invoiceNumber, orderNumber: order.orderNumber, totalCents: order.totalCents }
        });
    });
}

/**
 * Loads an order together with the lines the viewer may see.
 * Buyers see only their own orders; Sellers see only orders containing their products
 * (restricted to their lines, without address or totals); Admins see everything.
 * Anything else is reported as not found so identifiers cannot be probed.
 * @param {{id: string, role: string}} user Authenticated user.
 * @param {string} orderId Order id.
 * @returns {Promise<{order: object, items: object[]}>} Order and visible lines.
 */
async function loadVisibleOrder(user, orderId) {
    const db = getPool();
    const order = await orderModel.findById(db, orderId);
    if (!order) throw notFound('Order not found.');

    if (user.role === 'Admin') {
        return { order, items: await orderModel.listItems(db, orderId) };
    }
    if (user.role === 'Buyer') {
        if (order.buyerId !== user.id) throw notFound('Order not found.');
        return { order, items: await orderModel.listItems(db, orderId) };
    }
    if (user.role === 'Seller') {
        const items = await orderModel.listItems(db, orderId, user.id);
        if (items.length === 0) throw notFound('Order not found.');
        return { order, items };
    }
    throw forbidden();
}

/**
 * Formats an order for the API according to the viewer's role.
 * @param {object} order Order row.
 * @param {object[]|undefined} items Visible order lines.
 * @param {string} role Viewer role.
 * @returns {object} API representation.
 */
function presentOrder(order, items, role) {
    const base = {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        buyerUsername: order.buyerUsername,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt
    };
    if (role === 'Seller') {
        const sellerSubtotalCents = items
            ? items.reduce((sum, item) => sum + item.lineTotalCents, 0)
            : undefined;
        return { ...base, sellerSubtotalCents, items: items?.map(presentItem) };
    }
    return {
        ...base,
        buyerId: order.buyerId,
        shippingAddress: order.shippingAddress,
        subtotalCents: order.subtotalCents,
        taxCents: order.taxCents,
        totalCents: order.totalCents,
        invoice: order.invoiceId ? {
            id: order.invoiceId,
            invoiceNumber: order.invoiceNumber,
            status: order.invoiceStatus,
            issuedAt: order.invoiceIssuedAt,
            dueAt: order.invoiceDueAt,
            paidAt: order.invoicePaidAt
        } : null,
        items: items?.map(presentItem)
    };
}

/**
 * Formats an order line (internal seller ids are not exposed to buyers).
 * @param {object} item Order line row.
 * @returns {object} API representation.
 */
function presentItem(item) {
    return {
        productId: item.productId,
        sku: item.sku,
        name: item.name,
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
        lineTotalCents: item.lineTotalCents
    };
}

module.exports = {
    TRANSITIONS,
    checkout,
    cancelOwnOrder,
    transitionOrder,
    markInvoicePaid,
    loadVisibleOrder,
    presentOrder
};
