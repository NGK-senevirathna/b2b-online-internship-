'use strict';

const auditModel = require('../models/auditModel');
const { getPool } = require('../config/database');

/**
 * Builds the actor/ip portion of an audit entry from an authenticated request.
 * @param {import('express').Request} req Express request.
 * @returns {{actorId: string|null, actorRole: string|null, ipAddress: string|null}} Actor context.
 */
function actorFrom(req) {
    return {
        actorId: req.user?.id ?? null,
        actorRole: req.user?.role ?? null,
        ipAddress: req.ip ?? null
    };
}

/**
 * Writes an audit record inside the caller's transaction so the business change
 * and its audit trail commit or roll back together.
 * @param {{query: Function}} db Transaction client.
 * @param {import('express').Request} req Express request supplying actor and IP.
 * @param {{action: string, entityType: string, entityId?: string, details?: object}} entry Event description.
 * @returns {Promise<void>} Resolves after insertion.
 */
async function record(db, req, entry) {
    await auditModel.insert(db, { ...actorFrom(req), ...entry });
}

/**
 * Best-effort audit write for events outside a business transaction (for example
 * failed logins). A logging failure must never break the user's request.
 * @param {import('express').Request} req Express request.
 * @param {{actorId?: string, actorRole?: string, action: string, entityType: string, entityId?: string, details?: object}} entry Event description.
 * @returns {Promise<void>} Always resolves.
 */
async function recordSafe(req, entry) {
    try {
        await auditModel.insert(getPool(), { ...actorFrom(req), ...entry });
    } catch (error) {
        console.error('Audit log write failed.', error);
    }
}

module.exports = { record, recordSafe };
