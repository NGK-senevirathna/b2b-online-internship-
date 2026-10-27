'use strict';

/**
 * Creates the invoice for an order.
 * @param {{query: Function}} db Transaction client.
 * @param {{orderId: string, buyerId: string, subtotalCents: number, taxCents: number, totalCents: number}} invoice Invoice data.
 * @returns {Promise<void>} Resolves after insertion.
 */
async function create(db, invoice) {
    await db.query(
        `INSERT INTO invoices (order_id, buyer_id, subtotal_cents, tax_cents, total_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoice.orderId, invoice.buyerId, invoice.subtotalCents, invoice.taxCents, invoice.totalCents]
    );
}

/**
 * Marks an order's issued invoice as paid.
 * @param {{query: Function}} db Transaction client.
 * @param {string} orderId Order id.
 * @returns {Promise<boolean>} Whether an issued invoice was updated.
 */
async function markPaid(db, orderId) {
    const result = await db.query(
        `UPDATE invoices SET status = 'paid', paid_at = now()
         WHERE order_id = $1 AND status = 'issued'`,
        [orderId]
    );
    return result.rowCount === 1;
}

/**
 * Voids an order's invoice (used when the order is cancelled).
 * @param {{query: Function}} db Transaction client.
 * @param {string} orderId Order id.
 * @returns {Promise<void>} Resolves after the update.
 */
async function voidForOrder(db, orderId) {
    await db.query(
        `UPDATE invoices SET status = 'void', paid_at = NULL
         WHERE order_id = $1 AND status <> 'void'`,
        [orderId]
    );
}

module.exports = { create, markPaid, voidForOrder };
