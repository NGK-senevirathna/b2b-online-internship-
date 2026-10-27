'use strict';

const { escapeLike } = require('../utils/validation');

const PRODUCT_COLUMNS = `p.id, p.seller_id AS "sellerId", u.username AS "sellerName", p.sku, p.name, p.description,
    p.price_cents AS "priceCents", p.stock_quantity AS "stockQuantity", p.status,
    p.created_at AS "createdAt", p.updated_at AS "updatedAt"`;

// Sort options are a fixed allow-list: user input never reaches the ORDER BY clause.
const SORT_CLAUSES = {
    name: 'p.name ASC, p.id ASC',
    newest: 'p.created_at DESC, p.id ASC',
    price_asc: 'p.price_cents ASC, p.id ASC',
    price_desc: 'p.price_cents DESC, p.id ASC'
};

/**
 * Inserts a product.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {{sellerId: string, sku: string, name: string, description: string, priceCents: number, stockQuantity: number}} product Product data.
 * @returns {Promise<string>} New product id.
 * @throws {Error} With code DUPLICATE_SKU when the seller already uses the SKU.
 */
async function create(db, product) {
    try {
        const result = await db.query(
            `INSERT INTO products (seller_id, sku, name, description, price_cents, stock_quantity)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [product.sellerId, product.sku, product.name, product.description, product.priceCents, product.stockQuantity]
        );
        return result.rows[0].id;
    } catch (error) {
        if (error.code === '23505' && error.constraint === 'products_seller_sku_key') {
            const duplicate = new Error('You already have a product with that SKU.');
            duplicate.code = 'DUPLICATE_SKU';
            throw duplicate;
        }
        throw error;
    }
}

/**
 * Loads one product, optionally locking its row for the rest of the transaction.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} id Product id.
 * @param {{forUpdate?: boolean}} [options] Locking behaviour.
 * @returns {Promise<object|undefined>} Product, or undefined when absent.
 */
async function findById(db, id, options = {}) {
    const result = await db.query(
        `SELECT ${PRODUCT_COLUMNS}
         FROM products p JOIN users u ON u.id = p.seller_id
         WHERE p.id = $1
         ${options.forUpdate ? 'FOR UPDATE OF p' : ''}`,
        [id]
    );
    return result.rows[0];
}

/**
 * Locks several products in a deterministic order (by id) to prevent deadlocks
 * between concurrent checkouts, and returns their current state.
 * @param {{query: Function}} db Transaction client.
 * @param {string[]} ids Product ids.
 * @returns {Promise<object[]>} Locked products.
 */
async function lockMany(db, ids) {
    const result = await db.query(
        `SELECT p.id, p.seller_id AS "sellerId", p.sku, p.name, p.price_cents AS "priceCents",
                p.stock_quantity AS "stockQuantity", p.status
         FROM products p
         WHERE p.id = ANY($1::uuid[])
         ORDER BY p.id
         FOR UPDATE OF p`,
        [ids]
    );
    return result.rows;
}

/**
 * Searches products with pagination.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {{search?: string, sellerId?: string, status?: string, inStockOnly?: boolean, lowStockAt?: number, sort: string, limit: number, offset: number}} filters Filters.
 * @returns {Promise<{rows: object[], total: number}>} Page and total match count.
 */
async function search(db, filters) {
    const conditions = [];
    const params = [];
    const add = (sql, value) => {
        params.push(value);
        conditions.push(sql.replace('?', `$${params.length}`));
    };

    if (filters.status) add('p.status = ?', filters.status);
    if (filters.sellerId) add('p.seller_id = ?', filters.sellerId);
    if (filters.search) {
        params.push(`%${escapeLike(filters.search)}%`);
        const pattern = `$${params.length}`;
        conditions.push(`(p.name ILIKE ${pattern} ESCAPE '\\' OR p.sku ILIKE ${pattern} ESCAPE '\\')`);
    }
    if (filters.inStockOnly) conditions.push('p.stock_quantity > 0');
    if (filters.lowStockAt !== undefined) add('p.stock_quantity <= ?', filters.lowStockAt);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = await db.query(`SELECT count(*) AS total FROM products p ${where}`, params);
    const rows = await db.query(
        `SELECT ${PRODUCT_COLUMNS}
         FROM products p JOIN users u ON u.id = p.seller_id
         ${where}
         ORDER BY ${SORT_CLAUSES[filters.sort] || SORT_CLAUSES.name}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.limit, filters.offset]
    );
    return { rows: rows.rows, total: total.rows[0].total };
}

/**
 * Updates the editable catalogue fields of a product.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} id Product id.
 * @param {{name?: string, description?: string, priceCents?: number, status?: string}} changes Fields to change.
 * @returns {Promise<void>} Resolves after the update.
 */
async function update(db, id, changes) {
    const assignments = [];
    const params = [id];
    const columns = { name: 'name', description: 'description', priceCents: 'price_cents', status: 'status' };
    for (const [key, column] of Object.entries(columns)) {
        if (changes[key] !== undefined) {
            params.push(changes[key]);
            assignments.push(`${column} = $${params.length}`);
        }
    }
    if (assignments.length === 0) return;
    await db.query(`UPDATE products SET ${assignments.join(', ')}, updated_at = now() WHERE id = $1`, params);
}

/**
 * Atomically changes stock by a delta, refusing to go below zero, and records the movement.
 * @param {{query: Function}} db Transaction client.
 * @param {{productId: string, delta: number, reason: string, note?: string, orderId?: string, actorId?: string}} change Stock change.
 * @returns {Promise<number|null>} New quantity, or null when the change would make stock negative.
 */
async function applyStockChange(db, change) {
    const result = await db.query(
        `UPDATE products
         SET stock_quantity = stock_quantity + $2, updated_at = now()
         WHERE id = $1 AND stock_quantity + $2 >= 0
         RETURNING stock_quantity AS "stockQuantity"`,
        [change.productId, change.delta]
    );
    if (result.rowCount === 0) return null;

    const quantityAfter = result.rows[0].stockQuantity;
    await db.query(
        `INSERT INTO stock_movements (product_id, delta, quantity_after, reason, note, order_id, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [change.productId, change.delta, quantityAfter, change.reason, change.note ?? null, change.orderId ?? null, change.actorId ?? null]
    );
    return quantityAfter;
}

/**
 * Lists recent stock movements for a product.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} productId Product id.
 * @param {number} limit Maximum rows.
 * @returns {Promise<object[]>} Movements, newest first.
 */
async function listMovements(db, productId, limit) {
    const result = await db.query(
        `SELECT m.id, m.delta, m.quantity_after AS "quantityAfter", m.reason, m.note,
                m.order_id AS "orderId", u.username AS "actorUsername", m.created_at AS "createdAt"
         FROM stock_movements m LEFT JOIN users u ON u.id = m.actor_id
         WHERE m.product_id = $1
         ORDER BY m.id DESC LIMIT $2`,
        [productId, limit]
    );
    return result.rows;
}

module.exports = { create, findById, lockMany, search, update, applyStockChange, listMovements };
