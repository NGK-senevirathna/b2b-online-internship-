'use strict';

const ORDER_SELECT = `
    SELECT o.id, o.order_number AS "orderNumber", o.buyer_id AS "buyerId", b.username AS "buyerUsername",
           o.status, o.shipping_address AS "shippingAddress",
           o.subtotal_cents AS "subtotalCents", o.tax_cents AS "taxCents", o.total_cents AS "totalCents",
           o.created_at AS "createdAt", o.updated_at AS "updatedAt",
           i.id AS "invoiceId", i.invoice_number AS "invoiceNumber", i.status AS "invoiceStatus",
           i.issued_at AS "invoiceIssuedAt", i.due_at AS "invoiceDueAt", i.paid_at AS "invoicePaidAt"
    FROM orders o
    JOIN users b ON b.id = o.buyer_id
    LEFT JOIN invoices i ON i.order_id = o.id`;

/**
 * Inserts an order header.
 * @param {{query: Function}} db Transaction client.
 * @param {{buyerId: string, shippingAddress: string, subtotalCents: number, taxCents: number, totalCents: number, idempotencyKey?: string}} order Order data.
 * @returns {Promise<string>} New order id.
 */
async function insertOrder(db, order) {
    const result = await db.query(
        `INSERT INTO orders (buyer_id, shipping_address, subtotal_cents, tax_cents, total_cents, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [order.buyerId, order.shippingAddress, order.subtotalCents, order.taxCents, order.totalCents, order.idempotencyKey ?? null]
    );
    return result.rows[0].id;
}

/**
 * Inserts all order lines in a single statement.
 * @param {{query: Function}} db Transaction client.
 * @param {string} orderId Order id.
 * @param {{productId: string, sellerId: string, sku: string, name: string, unitPriceCents: number, quantity: number}[]} items Lines.
 * @returns {Promise<void>} Resolves after insertion.
 */
async function insertItems(db, orderId, items) {
    await db.query(
        `INSERT INTO order_items (order_id, product_id, seller_id, sku, name, unit_price_cents, quantity, line_total_cents)
         SELECT $1, t.product_id, t.seller_id, t.sku, t.name, t.unit_price_cents, t.quantity, t.unit_price_cents * t.quantity
         FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::bigint[], $7::int[])
              AS t(product_id, seller_id, sku, name, unit_price_cents, quantity)`,
        [
            orderId,
            items.map((item) => item.productId),
            items.map((item) => item.sellerId),
            items.map((item) => item.sku),
            items.map((item) => item.name),
            items.map((item) => item.unitPriceCents),
            items.map((item) => item.quantity)
        ]
    );
}

/**
 * Finds a buyer's earlier order created with the same idempotency key.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} buyerId Buyer id.
 * @param {string} key Idempotency key.
 * @returns {Promise<string|undefined>} Order id when one exists.
 */
async function findIdByIdempotencyKey(db, buyerId, key) {
    const result = await db.query(
        'SELECT id FROM orders WHERE buyer_id = $1 AND idempotency_key = $2',
        [buyerId, key]
    );
    return result.rows[0]?.id;
}

/**
 * Loads one order with buyer and invoice summary.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} id Order id.
 * @param {{forUpdate?: boolean}} [options] Locking behaviour.
 * @returns {Promise<object|undefined>} Order, or undefined when absent.
 */
async function findById(db, id, options = {}) {
    const result = await db.query(
        `${ORDER_SELECT} WHERE o.id = $1 ${options.forUpdate ? 'FOR UPDATE OF o' : ''}`,
        [id]
    );
    return result.rows[0];
}

/**
 * Lists the lines of an order, optionally restricted to one seller's lines.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} orderId Order id.
 * @param {string} [sellerId] Restrict to this seller.
 * @returns {Promise<object[]>} Order lines.
 */
async function listItems(db, orderId, sellerId) {
    const params = [orderId];
    let sellerFilter = '';
    if (sellerId) {
        params.push(sellerId);
        sellerFilter = 'AND oi.seller_id = $2';
    }
    const result = await db.query(
        `SELECT oi.product_id AS "productId", oi.seller_id AS "sellerId", oi.sku, oi.name,
                oi.unit_price_cents AS "unitPriceCents", oi.quantity, oi.line_total_cents AS "lineTotalCents"
         FROM order_items oi
         WHERE oi.order_id = $1 ${sellerFilter}
         ORDER BY oi.id`,
        params
    );
    return result.rows;
}

/**
 * Searches orders visible to a role with pagination.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {{buyerId?: string, sellerId?: string, status?: string, limit: number, offset: number}} filters Filters; buyerId or sellerId scopes visibility.
 * @returns {Promise<{rows: object[], total: number}>} Page and total match count.
 */
async function search(db, filters) {
    const conditions = [];
    const params = [];
    if (filters.buyerId) {
        params.push(filters.buyerId);
        conditions.push(`o.buyer_id = $${params.length}`);
    }
    if (filters.sellerId) {
        params.push(filters.sellerId);
        conditions.push(`EXISTS (SELECT 1 FROM order_items s WHERE s.order_id = o.id AND s.seller_id = $${params.length})`);
    }
    if (filters.status) {
        params.push(filters.status);
        conditions.push(`o.status = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = await db.query(`SELECT count(*) AS total FROM orders o ${where}`, params);
    const rows = await db.query(
        `${ORDER_SELECT}
         ${where}
         ORDER BY o.created_at DESC, o.id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.limit, filters.offset]
    );
    return { rows: rows.rows, total: total.rows[0].total };
}

/**
 * Sets an order's status.
 * @param {{query: Function}} db Transaction client.
 * @param {string} id Order id.
 * @param {string} status New status.
 * @returns {Promise<void>} Resolves after the update.
 */
async function updateStatus(db, id, status) {
    await db.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
}

/**
 * Aggregates order and catalogue figures for the administrator dashboard.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {number} lowStockThreshold Quantity at or below which a product counts as low stock.
 * @returns {Promise<object>} Summary figures.
 */
async function dashboardSummary(db, lowStockThreshold) {
    const [statuses, money, catalog, users] = await Promise.all([
        db.query('SELECT status, count(*) AS total FROM orders GROUP BY status'),
        db.query(
            `SELECT COALESCE(sum(total_cents) FILTER (WHERE status <> 'cancelled'), 0) AS "orderedCents",
                    (SELECT COALESCE(sum(total_cents), 0) FROM invoices WHERE status = 'paid') AS "paidCents",
                    (SELECT COALESCE(sum(total_cents), 0) FROM invoices WHERE status = 'issued') AS "outstandingCents"
             FROM orders`
        ),
        db.query(
            `SELECT count(*) FILTER (WHERE status = 'active') AS "activeProducts",
                    count(*) FILTER (WHERE status = 'active' AND stock_quantity <= $1) AS "lowStockProducts",
                    count(*) FILTER (WHERE status = 'active' AND stock_quantity = 0) AS "outOfStockProducts"
             FROM products`,
            [lowStockThreshold]
        ),
        db.query('SELECT role, count(*) AS total FROM users WHERE is_active GROUP BY role')
    ]);

    const ordersByStatus = Object.fromEntries(
        ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'].map((status) => [status, 0])
    );
    for (const row of statuses.rows) ordersByStatus[row.status] = row.total;
    const usersByRole = { Buyer: 0, Seller: 0, Admin: 0 };
    for (const row of users.rows) usersByRole[row.role] = row.total;

    return { ordersByStatus, ...money.rows[0], ...catalog.rows[0], usersByRole };
}

module.exports = {
    insertOrder,
    insertItems,
    findIdByIdempotencyKey,
    findById,
    listItems,
    search,
    updateStatus,
    dashboardSummary
};
