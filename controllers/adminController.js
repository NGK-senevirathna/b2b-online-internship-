'use strict';

const userModel = require('../models/userModel');
const orderModel = require('../models/orderModel');
const auditModel = require('../models/auditModel');
const orderService = require('../services/orderService');
const adminService = require('../services/adminService');
const { getPool } = require('../config/database');
const { getAppConfig } = require('../config/appConfig');
const { badRequest } = require('../utils/httpError');
const v = require('../utils/validation');

const ROLES = ['Buyer', 'Seller', 'Admin'];
const AUDIT_ENTITY_TYPES = ['auth', 'user', 'product', 'order', 'invoice'];
const ACTION_PATTERN = /^[a-z_]+(\.[a-z_]+)?$/;

/** Returns headline figures for the administrator dashboard. */
async function summary(req, res) {
    const data = await orderModel.dashboardSummary(getPool(), getAppConfig().lowStockThreshold);
    return res.status(200).json({ success: true, message: 'Summary retrieved.', data: { summary: data } });
}

/** Lists user accounts. */
async function listUsers(req, res) {
    const paging = v.pagination(req.query);
    const { rows, total } = await userModel.search({
        search: v.optionalQueryText(req.query.q, 'q'),
        role: req.query.role === undefined ? undefined : v.oneOf(req.query.role, 'role', ROLES),
        ...paging
    });
    return res.status(200).json({
        success: true,
        message: 'Users retrieved.',
        data: {
            users: rows,
            pagination: v.pageInfo(paging, total)
        }
    });
}

/** Changes a user's role or active state. */
async function updateUser(req, res) {
    const body = v.exactObject(req.body, ['role', 'isActive']);
    const changes = {};
    if (body.role !== undefined) changes.role = v.oneOf(body.role, 'role', ROLES);
    if (body.isActive !== undefined) {
        if (typeof body.isActive !== 'boolean') throw badRequest('isActive must be true or false.');
        changes.isActive = body.isActive;
    }
    if (Object.keys(changes).length === 0) throw badRequest('Provide role or isActive.');

    const user = await adminService.updateUser(req, v.uuid(req.params.id, 'id'), changes);
    return res.status(200).json({ success: true, message: 'User updated.', data: { user } });
}

/** Moves an order through its workflow. */
async function updateOrderStatus(req, res) {
    const body = v.exactObject(req.body, ['status']);
    const status = v.oneOf(body.status, 'status', Object.keys(orderService.TRANSITIONS));
    const orderId = v.uuid(req.params.id, 'id');
    await orderService.transitionOrder(req, orderId, status);
    const { order, items } = await orderService.loadVisibleOrder(req.user, orderId);
    return res.status(200).json({
        success: true,
        message: 'Order status updated.',
        data: { order: orderService.presentOrder(order, items, req.user.role) }
    });
}

/** Records payment of an order's invoice. */
async function markInvoicePaid(req, res) {
    const orderId = v.uuid(req.params.id, 'id');
    await orderService.markInvoicePaid(req, orderId);
    const { order, items } = await orderService.loadVisibleOrder(req.user, orderId);
    return res.status(200).json({
        success: true,
        message: 'Invoice marked as paid.',
        data: { order: orderService.presentOrder(order, items, req.user.role) }
    });
}

/** Searches the append-only audit trail. */
async function auditLogs(req, res) {
    const paging = v.pagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const action = v.optionalQueryText(req.query.action, 'action', 60);
    if (action !== undefined && !ACTION_PATTERN.test(action)) throw badRequest('action has an invalid format.');

    const { rows, total } = await auditModel.list({
        action,
        entityType: req.query.entityType === undefined ? undefined : v.oneOf(req.query.entityType, 'entityType', AUDIT_ENTITY_TYPES),
        entityId: req.query.entityId === undefined ? undefined : v.uuid(req.query.entityId, 'entityId'),
        actorId: req.query.actorId === undefined ? undefined : v.uuid(req.query.actorId, 'actorId'),
        ...paging
    });
    return res.status(200).json({
        success: true,
        message: 'Audit log retrieved.',
        data: {
            entries: rows,
            pagination: v.pageInfo(paging, total)
        }
    });
}

module.exports = { summary, listUsers, updateUser, updateOrderStatus, markInvoicePaid, auditLogs };
