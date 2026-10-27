'use strict';

import { h, replace } from './dom.js';
import { describeError } from './api.js';
import { titleCase } from './format.js';

const noticeEl = () => document.querySelector('#notice');
const alertEl = () => document.querySelector('#alert-region');
let noticeTimer = null;

/** Hides both message regions. */
export function clearMessages() {
    for (const el of [noticeEl(), alertEl()]) {
        el.textContent = '';
        el.hidden = true;
    }
    clearTimeout(noticeTimer);
}

/**
 * Shows a message at the top of the page. Errors use role="alert", others a polite status region.
 * @param {string} message Text to show (never HTML).
 * @param {'error'|'success'|'info'} [kind] Visual and announcement type.
 * @param {string[]} [lines] Extra detail lines.
 */
export function notify(message, kind = 'success', lines = []) {
    clearMessages();
    const target = kind === 'error' ? alertEl() : noticeEl();
    target.className = `notice${kind === 'success' ? ' is-success' : kind === 'info' ? ' is-info' : ''}`;
    replace(target, h('span', { text: message }),
        lines.length ? h('ul', { class: 'notice-list' }, lines.map((line) => h('li', { text: line }))) : null);
    target.hidden = false;
    if (kind === 'error') target.scrollIntoView?.({ block: 'nearest' });
    if (kind !== 'error') noticeTimer = setTimeout(clearMessages, 8000);
}

let pendingFlash = null;

/** Queues a message to show after the next page change (the page change clears older messages). */
export function flash(message, kind = 'success') {
    pendingFlash = { message, kind };
}

/** Shows and clears the queued message, if any. */
export function showFlash() {
    if (!pendingFlash) return;
    const { message, kind } = pendingFlash;
    pendingFlash = null;
    notify(message, kind);
}

/** Shows an API error using the plain-language mapping. */
export function notifyError(error) {
    const { message, lines } = describeError(error);
    notify(message, 'error', lines);
}

/** Loading placeholder (announced politely to screen readers). */
export function loadingBlock(text = 'Loading…') {
    return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text }));
}

/** Inline error panel with an optional retry button. */
export function errorPanel(error, retry) {
    const { message, lines } = describeError(error);
    return h('div', { class: 'error-panel', role: 'alert' },
        h('strong', { text: message }),
        lines.length ? h('ul', {}, lines.map((line) => h('li', { text: line }))) : null,
        retry ? h('button', { class: 'secondary-button', type: 'button', on: { click: retry } }, 'Try again') : null);
}

/** Empty-state panel. */
export function emptyState(title, text, action) {
    return h('div', { class: 'empty-state' }, h('strong', { text: title }), text ? h('p', { text }) : null, action || null);
}

/** Page heading with optional actions. */
export function pageHeader(title, subtitle, actions) {
    return h('div', { class: 'view-header' },
        h('div', {}, h('h1', { id: 'view-title', tabindex: '-1', text: title }), subtitle ? h('p', { text: subtitle }) : null),
        actions ? h('div', { class: 'view-actions' }, actions) : null);
}

/** Coloured status pill. */
export function badge(status, label) {
    return h('span', { class: `badge badge-${String(status).replace(/_/g, '-')}`, text: label || titleCase(status) });
}

/** Stock badge for a product. */
export function stockBadge(product) {
    if (product.stockStatus === 'out_of_stock') return badge('out_of_stock', 'Out of stock');
    if (product.stockStatus === 'low_stock') return badge('low_stock', `Low stock · ${product.stockQuantity} left`);
    return badge('in_stock', `In stock · ${product.stockQuantity}`);
}

/**
 * Runs an async action while a button is disabled, so a double click cannot submit twice.
 * @param {HTMLButtonElement} button Button to lock.
 * @param {() => Promise<void>} action Work to do.
 */
export async function withBusy(button, action) {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
        await action();
    } finally {
        if (button.isConnected) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
        }
    }
}

/**
 * Builds a responsive table. On narrow screens each row becomes a card using data-label.
 * @param {{label: string, render: (row: any) => any, class?: string}[]} columns Column definitions.
 * @param {any[]} rows Data rows.
 * @param {string} caption Accessible table caption.
 */
export function table(columns, rows, caption) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
        h('caption', { class: 'sr-only', text: caption }),
        h('thead', {}, h('tr', {}, columns.map((c) => h('th', { scope: 'col', class: c.class || null, text: c.label })))),
        h('tbody', {}, rows.map((row) => h('tr', {}, columns.map((c) =>
            h('td', { 'data-label': c.label, class: c.class || null }, c.render(row))))))));
}

/**
 * Previous / next pager.
 * @param {{page:number,totalPages:number,total:number}} info Pagination info from the API.
 * @param {(page:number) => void} go Called with the new page number.
 */
export function pager(info, go) {
    if (!info) return null;
    return h('nav', { class: 'pager', 'aria-label': 'Pagination' },
        h('button', { class: 'secondary-button', type: 'button', disabled: info.page <= 1, on: { click: () => go(info.page - 1) } }, '← Previous'),
        h('span', { class: 'pager-info', text: `Page ${info.page} of ${info.totalPages} · ${info.total} result${info.total === 1 ? '' : 's'}` }),
        h('button', { class: 'secondary-button', type: 'button', disabled: info.page >= info.totalPages, on: { click: () => go(info.page + 1) } }, 'Next →'));
}

/**
 * Label + control pair with optional help and error text, wired for screen readers.
 * @returns {{wrap: HTMLElement, input: HTMLElement, setError: (message: string) => void}} Field parts.
 */
export function field(id, labelText, input, help) {
    input.id = id;
    const helpId = `${id}-help`;
    const errorId = `${id}-error`;
    const errorEl = h('span', { class: 'field-error', id: errorId, hidden: true });
    input.setAttribute('aria-describedby', help ? `${helpId} ${errorId}` : errorId);
    const wrap = h('div', { class: 'field' },
        h('label', { for: id, text: labelText }), input,
        help ? h('span', { class: 'field-hint', id: helpId, text: help }) : null, errorEl);
    return {
        wrap, input,
        setError(message) {
            errorEl.textContent = message || '';
            errorEl.hidden = !message;
            if (message) input.setAttribute('aria-invalid', 'true');
            else input.removeAttribute('aria-invalid');
        }
    };
}

/**
 * Accessible confirmation dialog built on the native <dialog> element
 * (focus is trapped and Escape cancels).
 * @returns {Promise<boolean>} True if the user confirmed.
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
        const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'dialog-title' });
        const finish = (result) => {
            dialog.close();
            dialog.remove();
            resolve(result);
        };
        dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
        dialog.append(h('form', { method: 'dialog', on: { submit: (event) => { event.preventDefault(); finish(true); } } },
            h('h2', { id: 'dialog-title', text: title }),
            h('p', { text: message }),
            h('div', { class: 'dialog-actions' },
                h('button', { class: 'secondary-button', type: 'button', on: { click: () => finish(false) } }, 'Cancel'),
                h('button', { class: danger ? 'danger-button' : 'primary-button inline', type: 'submit' }, confirmLabel))));
        document.querySelector('#modal-root').appendChild(dialog);
        dialog.showModal();
        dialog.querySelector('button[type="button"]').focus();
    });
}
