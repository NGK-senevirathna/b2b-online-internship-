'use strict';

/**
 * Calculates tax in cents for a subtotal using integer basis points.
 * BigInt keeps the multiplication exact even for the largest permitted orders,
 * where subtotal * rate would exceed Number.MAX_SAFE_INTEGER.
 * @param {number} subtotalCents Subtotal in cents (non-negative safe integer).
 * @param {number} taxRateBps Tax rate in basis points (100 = 1%).
 * @returns {number} Tax in cents, rounded half up.
 */
function calculateTax(subtotalCents, taxRateBps) {
    return Number((BigInt(subtotalCents) * BigInt(taxRateBps) + 5000n) / 10000n);
}

module.exports = { calculateTax };
