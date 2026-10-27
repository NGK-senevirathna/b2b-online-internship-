'use strict';

const { getPool } = require('../config/database');

/**
 * Appends an immutable audit record.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {{actorId?: string|null, actorRole?: string|null, action: string, entityType: string, entityId?: string|null, details?: object, ipAddress?: string|null}} entry Audit entry.
 * @returns {Promise<void>} Resolves after insertion.
 */
async function insert(db, entry) {
    await db.query(
        `INSERT INTO audit_logs (actor_id, actor_role, action, entity_type, entity_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
            entry.actorId ?? null,
            entry.actorRole ?? null,
            entry.action,
            entry.entityType,
            entry.entityId ?? null,
            JSON.stringify(entry.details ?? {}),
            entry.ipAddress ?? null
        ]
    );
}

/**
 * Lists audit records, newest first, with optional filters.
 * @param {{action?: string, entityType?: string, entityId?: string, actorId?: string, limit: number, offset: number}} filters Query filters.
 * @returns {Promise<{rows: object[], total: number}>} Page of records and the total match count.
 */
async function list(filters) {
    const conditions = [];
    const params = [];
    const add = (sql, value) => {
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
    };

    if (filters.action) add('a.action = ?', filters.action);
    if (filters.entityType) add('a.entity_type = ?', filters.entityType);
    if (filters.entityId) add('a.entity_id = ?', filters.entityId);
    if (filters.actorId) add('a.actor_id = ?', filters.actorId);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = await getPool().query(`SELECT count(*) AS total FROM audit_logs a ${where}`, params);
    const rows = await getPool().query(
        `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
                a.actor_id AS "actorId", u.username AS "actorUsername", a.actor_role AS "actorRole",
                a.details, a.ip_address AS "ipAddress", a.created_at AS "createdAt"
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         ${where}
         ORDER BY a.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.limit, filters.offset]
    );
    return { rows: rows.rows, total: total.rows[0].total };
}

module.exports = { insert, list };
