'use strict';

/**
 * Returns the buyer's cart id, creating the cart on first use.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} userId Buyer id.
 * @returns {Promise<string>} Cart id.
 */
async function ensureCart(db, userId) {
    const result = await db.query(
        `INSERT INTO carts (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [userId]
    );
    return result.rows[0].id;
}

/**
 * Locks the buyer's cart row, serializing concurrent checkouts for the same buyer.
 * @param {{query: Function}} db Transaction client.
 * @param {string} userId Buyer id.
 * @returns {Promise<string>} Cart id.
 */
async function lockCart(db, userId) {
    await ensureCart(db, userId);
    const result = await db.query('SELECT id FROM carts WHERE user_id = $1 FOR UPDATE', [userId]);
    return result.rows[0].id;
}

/**
 * Lists cart lines with live product data.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} userId Buyer id.
 * @returns {Promise<object[]>} Cart lines.
 */
async function listItems(db, userId) {
    const result = await db.query(
        `SELECT p.id AS "productId", p.sku, p.name, p.price_cents AS "unitPriceCents",
                ci.quantity, p.stock_quantity AS "stockQuantity", p.status
         FROM cart_items ci
         JOIN carts c ON c.id = ci.cart_id
         JOIN products p ON p.id = ci.product_id
         WHERE c.user_id = $1
         ORDER BY ci.added_at, p.id`,
        [userId]
    );
    return result.rows;
}

/**
 * Counts distinct lines currently in a cart.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} cartId Cart id.
 * @returns {Promise<number>} Line count.
 */
async function countLines(db, cartId) {
    const result = await db.query('SELECT count(*) AS total FROM cart_items WHERE cart_id = $1', [cartId]);
    return result.rows[0].total;
}

/**
 * Checks whether a product is already in the cart.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} cartId Cart id.
 * @param {string} productId Product id.
 * @returns {Promise<boolean>} Whether the line exists.
 */
async function hasItem(db, cartId, productId) {
    const result = await db.query('SELECT 1 FROM cart_items WHERE cart_id = $1 AND product_id = $2', [cartId, productId]);
    return result.rowCount === 1;
}

/**
 * Sets the quantity of a product in the cart (insert or replace).
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} cartId Cart id.
 * @param {string} productId Product id.
 * @param {number} quantity New quantity.
 * @returns {Promise<void>} Resolves after the upsert.
 */
async function setItem(db, cartId, productId, quantity) {
    await db.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
        [cartId, productId, quantity]
    );
    await db.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
}

/**
 * Removes one product from the cart.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} cartId Cart id.
 * @param {string} productId Product id.
 * @returns {Promise<void>} Resolves after deletion.
 */
async function removeItem(db, cartId, productId) {
    await db.query('DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2', [cartId, productId]);
}

/**
 * Removes every line from the cart.
 * @param {{query: Function}} db Pool or transaction client.
 * @param {string} cartId Cart id.
 * @returns {Promise<void>} Resolves after deletion.
 */
async function clear(db, cartId) {
    await db.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
}

module.exports = { ensureCart, lockCart, listItems, countLines, hasItem, setItem, removeItem, clear };
