'use strict';

const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');
const auditService = require('./auditService');
const { withTransaction } = require('../config/database');
const { conflict, notFound } = require('../utils/httpError');

/**
 * Changes a user's role or active state with safety rules:
 * administrators cannot lock themselves out, and the last active Admin cannot be removed.
 * Deactivating an account revokes all of its sessions immediately.
 * @param {import('express').Request} req Authenticated Admin request.
 * @param {string} userId Target user id.
 * @param {{role?: string, isActive?: boolean}} changes Validated changes.
 * @returns {Promise<object>} Updated public user.
 */
async function updateUser(req, userId, changes) {
    return withTransaction(async (db) => {
        const activeAdmins = await userModel.lockActiveAdminCount(db);
        const target = await userModel.findById(userId, db);
        if (!target) throw notFound('User not found.');

        const nextRole = changes.role ?? target.role;
        const nextActive = changes.isActive ?? target.isActive;
        const losesAdminAccess = target.role === 'Admin' && target.isActive && (nextRole !== 'Admin' || !nextActive);

        if (losesAdminAccess && target.id === req.user.id) {
            throw conflict('You cannot demote or deactivate your own account.', { code: 'SELF_LOCKOUT' });
        }
        if (losesAdminAccess && activeAdmins <= 1) {
            throw conflict('At least one active Admin must remain.', { code: 'LAST_ADMIN' });
        }

        await userModel.updateAdminFields(db, userId, changes);
        if (target.isActive && !nextActive) {
            await sessionModel.revokeAllForUser(db, userId);
        }
        await auditService.record(db, req, {
            action: 'user.update',
            entityType: 'user',
            entityId: userId,
            details: {
                username: target.username,
                from: { role: target.role, isActive: target.isActive },
                to: { role: nextRole, isActive: nextActive }
            }
        });
        const updated = await userModel.findById(userId, db);
        return { id: updated.id, username: updated.username, email: updated.email, role: updated.role, isActive: updated.isActive };
    });
}

module.exports = { updateUser };
