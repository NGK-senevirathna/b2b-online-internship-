'use strict';

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Formats integer cents as dollars for display. */
export function formatMoney(cents) {
    return Number.isFinite(cents) ? currency.format(cents / 100) : '—';
}

/** Formats an ISO timestamp for the viewer's locale. */
export function formatDate(iso, withTime = true) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return withTime
        ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/**
 * Converts a typed dollar amount ("12", "12.5", "12.50") to integer cents using string math only.
 * @param {string} text Typed amount.
 * @returns {number|null} Cents, or null when the text is not a valid amount.
 */
export function dollarsToCents(text) {
    const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(text).trim());
    if (!match) return null;
    return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0') || 0);
}

/** Converts integer cents to an editable dollar string such as "12.50". */
export function centsToDollars(cents) {
    return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Shortens a UUID for display. */
export function shortId(id) {
    return typeof id === 'string' ? id.slice(0, 8) : '—';
}

/** Returns "Title case" text for status words such as in_stock. */
export function titleCase(text) {
    const words = String(text || '').replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Allowed workflow moves, mirroring the server's rules (the server stays the authority). */
export const NEXT_STATUS = Object.freeze({
    pending: ['confirmed', 'cancelled'],
    confirmed: ['shipped', 'cancelled'],
    shipped: ['delivered'],
    delivered: [],
    cancelled: []
});

export const FLOW = ['pending', 'confirmed', 'shipped', 'delivered'];

/** Creates a fresh Idempotency-Key (8-64 chars of letters, digits, hyphen, underscore). */
export function newIdempotencyKey() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
