'use strict';

const orderModel = require('../models/orderModel');
const userModel = require('../models/userModel');
const orderService = require('../services/orderService');
const { getPool } = require('../config/database');
const { badRequest, forbidden } = require('../utils/httpError');
const v = require('../utils/validation');

const ORDER_STATUSES = Object.keys(orderService.TRANSITIONS);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Places an order from the buyer's cart. Safe to retry with the same Idempotency-Key header. */
async function checkout(req, res) {
    const body = v.exactObject(req.body, ['shippingAddress']);
    const shippingAddress = v.text(body.shippingAddress, 'shippingAddress', { min: 10, max: 500 });

    const idempotencyKey = req.get('idempotency-key');
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw badRequest('Idempotency-Key must be 8-64 characters: letters, numbers, hyphens or underscores.');
    }

    const { orderId, replayed } = await orderService.checkout(req, { shippingAddress, idempotencyKey });
    const { order, items } = await orderService.loadVisibleOrder(req.user, orderId);
    return res.status(replayed ? 200 : 201).json({
        success: true,
        message: replayed ? 'Order already placed with this Idempotency-Key.' : 'Order placed.',
        data: { order: orderService.presentOrder(order, items, req.user.role), replayed }
    });
}

/** Lists orders visible to the caller: own (Buyer), containing their products (Seller), or all (Admin). */
async function list(req, res) {
    const paging = v.pagination(req.query);
    const { role, id } = req.user;
    const { rows, total } = await orderModel.search(getPool(), {
        buyerId: role === 'Buyer' ? id : undefined,
        sellerId: role === 'Seller' ? id : undefined,
        status: req.query.status === undefined ? undefined : v.oneOf(req.query.status, 'status', ORDER_STATUSES),
        ...paging
    });

    const orders = [];
    for (const row of rows) {
        const items = role === 'Seller' ? await orderModel.listItems(getPool(), row.id, id) : undefined;
        orders.push(orderService.presentOrder(row, items, role));
    }
    return res.status(200).json({
        success: true,
        message: 'Orders retrieved.',
        data: {
            orders,
            pagination: v.pageInfo(paging, total)
        }
    });
}

/** Returns one order with its lines. */
async function get(req, res) {
    const { order, items } = await orderService.loadVisibleOrder(req.user, v.uuid(req.params.id, 'id'));
    return res.status(200).json({
        success: true,
        message: 'Order retrieved.',
        data: { order: orderService.presentOrder(order, items, req.user.role) }
    });
}

/** Cancels the buyer's own pending order. */
async function cancel(req, res) {
    const orderId = v.uuid(req.params.id, 'id');
    await orderService.cancelOwnOrder(req, orderId);
    const { order, items } = await orderService.loadVisibleOrder(req.user, orderId);
    return res.status(200).json({
        success: true,
        message: 'Order cancelled and stock restored.',
        data: { order: orderService.presentOrder(order, items, req.user.role) }
    });
}

/** Returns a printable invoice for the buyer (or an Admin). */
async function invoice(req, res) {
    if (req.user.role === 'Seller') throw forbidden();
    const { order, items } = await orderService.loadVisibleOrder(req.user, v.uuid(req.params.id, 'id'));
    const buyer = await userModel.findById(order.buyerId);
    const presented = orderService.presentOrder(order, items, req.user.role);
    return res.status(200).json({
        success: true,
        message: 'Invoice retrieved.',
        data: {
            invoice: {
                ...presented.invoice,
                orderNumber: presented.orderNumber,
                orderStatus: presented.status,
                billTo: { username: buyer.username, email: buyer.email, shippingAddress: presented.shippingAddress },
                items: presented.items,
                subtotalCents: presented.subtotalCents,
                taxCents: presented.taxCents,
                totalCents: presented.totalCents
            }
        }
    });
}

module.exports = { checkout, list, get, cancel, invoice };
