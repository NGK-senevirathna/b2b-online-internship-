'use strict';

import { h, replace } from '../dom.js';
import { api } from '../api.js';
import { FLOW, NEXT_STATUS, formatDate, formatMoney, titleCase } from '../format.js';
import { badge, confirmDialog, emptyState, errorPanel, field, loadingBlock, notify, notifyError, pageHeader, pager, table, withBusy } from '../ui.js';

const STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const ACTION_LABEL = { confirmed: 'Confirm', shipped: 'Mark shipped', delivered: 'Mark delivered', cancelled: 'Cancel order' };

function statusFilter(ctx, basePath, current) {
    const select = h('select', { name: 'status' }, h('option', { value: '', text: 'All statuses' }),
        STATUSES.map((s) => h('option', { value: s, selected: s === current, text: titleCase(s) })));
    return h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter orders', on: { submit: (event) => {
        event.preventDefault();
        ctx.go(basePath, { status: select.value });
    } } }, field('f-status', 'Status', select).wrap,
    h('button', { class: 'primary-button inline', type: 'submit' }, 'Apply'),
    h('a', { class: 'text-button', href: `#${basePath}` }, 'Reset'));
}

/** Order list for all three roles; columns and actions depend on who is looking. */
export async function list(ctx, basePath) {
    const { container, query, user } = ctx;
    const status = query.get('status') || '';
    const page = Math.max(1, Number(query.get('page')) || 1);
    const titles = { Buyer: ['My orders', 'Every order you have placed.'], Seller: ['Orders with my products', 'Only your own lines are shown.'], Admin: ['All orders', 'Move orders through the workflow and record payments.'] };
    const [title, subtitle] = titles[user.role];
    const results = h('div', { 'aria-live': 'polite' }, loadingBlock('Loading orders…'));
    replace(container, pageHeader(title, subtitle), statusFilter(ctx, basePath, status), results);
    try {
        const response = await api('/orders', { query: { status, page, limit: 10 } });
        if (!ctx.alive()) return;
        const { orders, pagination } = response.data;
        if (orders.length === 0) {
            replace(results, emptyState('No orders yet', status ? `There are no ${status} orders.` : user.role === 'Buyer' ? 'Place your first order from the catalogue.' : 'Orders will appear here.',
                user.role === 'Buyer' ? h('a', { class: 'primary-button inline link-button', href: '#/catalogue' }, 'Browse the catalogue') : null));
            return;
        }
        const orderCell = (o) => h('a', { href: `#/orders/${o.id}`, text: o.orderNumber });
        const columns = {
            Buyer: [
                { label: 'Order', render: orderCell },
                { label: 'Placed', render: (o) => formatDate(o.createdAt) },
                { label: 'Status', render: (o) => badge(o.status) },
                { label: 'Invoice', render: (o) => (o.invoice ? badge(o.invoice.status) : '—') },
                { label: 'Total', class: 'num', render: (o) => formatMoney(o.totalCents) }
            ],
            Seller: [
                { label: 'Order', render: orderCell },
                { label: 'Buyer', render: (o) => o.buyerUsername },
                { label: 'Placed', render: (o) => formatDate(o.createdAt) },
                { label: 'Status', render: (o) => badge(o.status) },
                { label: 'My lines', render: (o) => h('ul', { class: 'plain-list' }, (o.items || []).map((i) => h('li', { text: `${i.quantity} × ${i.name}` }))) },
                { label: 'My subtotal', class: 'num', render: (o) => formatMoney(o.sellerSubtotalCents) }
            ],
            Admin: [
                { label: 'Order', render: orderCell },
                { label: 'Buyer', render: (o) => o.buyerUsername },
                { label: 'Placed', render: (o) => formatDate(o.createdAt) },
                { label: 'Status', render: (o) => badge(o.status) },
                { label: 'Invoice', render: (o) => (o.invoice ? badge(o.invoice.status) : '—') },
                { label: 'Total', class: 'num', render: (o) => formatMoney(o.totalCents) },
                { label: 'Actions', render: (o) => adminActions(o, ctx.refresh) }
            ]
        }[user.role];
        replace(results, table(columns, orders, title), pager(pagination, (next) => ctx.go(basePath, { status, page: next })));
    } catch (error) {
        if (ctx.alive()) replace(results, errorPanel(error, ctx.refresh));
    }
}

/**
 * Workflow buttons for an Admin: the next allowed status values and "mark invoice paid".
 * The server re-checks every move, so these buttons only guide the user.
 */
export function adminActions(order, done) {
    const buttons = [];
    for (const next of NEXT_STATUS[order.status] || []) {
        const cancel = next === 'cancelled';
        buttons.push(h('button', { class: cancel ? 'danger-button small-btn' : 'secondary-button small-btn', type: 'button', 'aria-label': `${ACTION_LABEL[next]} ${order.orderNumber}`, on: { click: async (event) => {
        const button = event.currentTarget;
            if (cancel) {
                const ok = await confirmDialog({ title: `Cancel ${order.orderNumber}?`, message: 'Stock is returned and the invoice is voided. This cannot be undone.', confirmLabel: 'Cancel order', danger: true });
                if (!ok) return;
            }
            await withBusy(button, async () => {
                try {
                    await api(`/admin/orders/${order.id}/status`, { method: 'PATCH', body: { status: next } });
                    notify(`${order.orderNumber} is now ${next}.`);
                    done();
                } catch (error) { notifyError(error); }
            });
        } } }, ACTION_LABEL[next]));
    }
    if (order.invoice?.status === 'issued' && order.status !== 'cancelled') {
        buttons.push(h('button', { class: 'secondary-button small-btn', type: 'button', 'aria-label': `Mark invoice for ${order.orderNumber} as paid`, on: { click: async (event) => {
        const button = event.currentTarget;
            await withBusy(button, async () => {
                try {
                    await api(`/admin/orders/${order.id}/invoice/pay`, { method: 'POST' });
                    notify(`Invoice for ${order.orderNumber} marked as paid.`);
                    done();
                } catch (error) { notifyError(error); }
            });
        } } }, 'Mark paid'));
    }
    return h('div', { class: 'action-row' }, buttons.length ? buttons : h('span', { class: 'muted small', text: 'No actions' }));
}

function tracker(status) {
    if (status === 'cancelled') return h('p', { class: 'tracker-cancelled' }, badge('cancelled'), ' This order was cancelled; stock was returned.');
    const index = FLOW.indexOf(status);
    return h('ol', { class: 'tracker', 'aria-label': 'Order progress' }, FLOW.map((step, i) =>
        h('li', { class: i < index ? 'done' : i === index ? 'current' : '', 'aria-current': i === index ? 'step' : null },
            h('span', { class: 'dot', 'aria-hidden': 'true', text: i < index ? '✓' : String(i + 1) }), h('span', { text: titleCase(step) }))));
}

/** One order: progress, lines, totals, address, invoice, and role-specific actions. */
export async function detail(ctx) {
    const { container, params, user, query } = ctx;
    replace(container, pageHeader('Order'), loadingBlock('Loading order…'));
    try {
        const { data } = await api(`/orders/${params.id}`);
        if (!ctx.alive()) return;
        const order = data.order;
        const isSeller = user.role === 'Seller';
        const actions = [h('a', { class: 'secondary-button link-button', href: user.role === 'Buyer' ? '#/orders' : user.role === 'Admin' ? '#/admin/orders' : '#/seller/orders' }, '← Back to orders')];
        if (user.role === 'Buyer' && order.status === 'pending') {
            actions.push(h('button', { class: 'danger-button', type: 'button', on: { click: async (event) => {
        const button = event.currentTarget;
                const ok = await confirmDialog({ title: `Cancel ${order.orderNumber}?`, message: 'Your items go back into stock and the invoice is voided. Only pending orders can be cancelled.', confirmLabel: 'Cancel order', danger: true });
                if (!ok) return;
                await withBusy(button, async () => {
                    try {
                        await api(`/orders/${order.id}/cancel`, { method: 'POST' });
                        notify('Order cancelled and stock restored.');
                        ctx.refresh();
                    } catch (error) { notifyError(error); ctx.refresh(); }
                });
            } } }, 'Cancel order'));
        }
        if (!isSeller && order.invoice) actions.push(h('a', { class: 'primary-button inline link-button', href: `#/orders/${order.id}/invoice` }, 'View invoice'));

        const lineColumns = [
            { label: 'Product', render: (i) => h('span', {}, h('strong', { text: i.name }), ' ', h('span', { class: 'muted small', text: `(${i.sku})` })) },
            { label: 'Unit price', class: 'num', render: (i) => formatMoney(i.unitPriceCents) },
            { label: 'Quantity', class: 'num', render: (i) => i.quantity },
            { label: 'Line total', class: 'num', render: (i) => formatMoney(i.lineTotalCents) }
        ];
        const facts = [
            ['Placed', formatDate(order.createdAt)],
            ['Buyer', order.buyerUsername],
            ...(isSeller ? [] : [['Ship to', order.shippingAddress]]),
            ...(order.invoice ? [['Invoice', `${order.invoice.invoiceNumber} · ${titleCase(order.invoice.status)}`], ['Payment due', formatDate(order.invoice.dueAt, false)], ['Paid', order.invoice.paidAt ? formatDate(order.invoice.paidAt) : 'Not yet']] : [])
        ];
        replace(container,
            pageHeader(order.orderNumber, null, actions),
            query.get('placed') ? h('div', { class: 'notice is-success', role: 'status' }, query.get('placed') === 'replayed'
                ? 'This order had already been placed with the same request, so no duplicate was created.'
                : 'Thank you! Your order was placed and your invoice was issued.') : null,
            h('div', { class: 'panel' }, h('div', { class: 'status-line' }, badge(order.status), isSeller ? h('span', { class: 'muted small', text: 'Showing only the lines for your products.' }) : null), tracker(order.status)),
            h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { class: k === 'Ship to' ? 'pre' : '', text: v })))),
            table(lineColumns, order.items || [], `Lines of ${order.orderNumber}`),
            isSeller
                ? h('dl', { class: 'totals' }, h('div', { class: 'grand' }, h('dt', { text: 'Your subtotal' }), h('dd', { text: formatMoney(order.sellerSubtotalCents) })))
                : h('dl', { class: 'totals' },
                    h('div', {}, h('dt', { text: 'Subtotal' }), h('dd', { text: formatMoney(order.subtotalCents) })),
                    h('div', {}, h('dt', { text: 'Tax' }), h('dd', { text: formatMoney(order.taxCents) })),
                    h('div', { class: 'grand' }, h('dt', { text: 'Total' }), h('dd', { text: formatMoney(order.totalCents) }))),
            user.role === 'Admin' ? h('div', { class: 'panel' }, h('h2', { text: 'Admin actions' }), adminActions(order, ctx.refresh)) : null);
    } catch (error) {
        if (ctx.alive()) replace(container, pageHeader('Order'), errorPanel(error, ctx.refresh), h('a', { class: 'secondary-button link-button', href: '#/orders' }, '← Back to orders'));
    }
}

/** Printable invoice (the print stylesheet hides everything except the sheet). */
export async function invoice(ctx) {
    const { container, params } = ctx;
    replace(container, pageHeader('Invoice'), loadingBlock('Loading invoice…'));
    try {
        const { data } = await api(`/orders/${params.id}/invoice`);
        if (!ctx.alive()) return;
        const inv = data.invoice;
        const columns = [
            { label: 'Description', render: (i) => h('span', {}, h('strong', { text: i.name }), ' ', h('span', { class: 'muted small', text: `(${i.sku})` })) },
            { label: 'Unit price', class: 'num', render: (i) => formatMoney(i.unitPriceCents) },
            { label: 'Qty', class: 'num', render: (i) => i.quantity },
            { label: 'Amount', class: 'num', render: (i) => formatMoney(i.lineTotalCents) }
        ];
        replace(container,
            h('div', { class: 'view-header no-print' },
                h('div', {}, h('h1', { id: 'view-title', tabindex: '-1', text: `Invoice ${inv.invoiceNumber}` }), h('p', { text: `For order ${inv.orderNumber}` })),
                h('div', { class: 'view-actions' },
                    h('a', { class: 'secondary-button link-button', href: `#/orders/${params.id}` }, '← Back to order'),
                    h('button', { class: 'primary-button inline', type: 'button', on: { click: () => window.print() } }, 'Print invoice'))),
            h('article', { class: 'invoice-sheet', 'aria-label': `Invoice ${inv.invoiceNumber}` },
                h('header', { class: 'invoice-head' },
                    h('div', { class: 'brand-inline' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true', text: 'N' }), h('strong', { text: 'northstar.' })),
                    h('div', { class: 'invoice-meta' }, h('h2', { text: 'INVOICE' }), h('p', { text: inv.invoiceNumber }), badge(inv.status))),
                h('div', { class: 'invoice-parties' },
                    h('div', {}, h('h3', { text: 'Bill to' }), h('p', { text: inv.billTo.username }), h('p', { text: inv.billTo.email }), h('p', { class: 'pre', text: inv.billTo.shippingAddress })),
                    h('dl', { class: 'facts compact' },
                        h('div', {}, h('dt', { text: 'Issued' }), h('dd', { text: formatDate(inv.issuedAt, false) })),
                        h('div', {}, h('dt', { text: 'Due' }), h('dd', { text: formatDate(inv.dueAt, false) })),
                        h('div', {}, h('dt', { text: 'Paid' }), h('dd', { text: inv.paidAt ? formatDate(inv.paidAt, false) : 'Not yet' })),
                        h('div', {}, h('dt', { text: 'Order status' }), h('dd', { text: titleCase(inv.orderStatus) })))),
                table(columns, inv.items, `Invoice lines for ${inv.invoiceNumber}`),
                h('dl', { class: 'totals' },
                    h('div', {}, h('dt', { text: 'Subtotal' }), h('dd', { text: formatMoney(inv.subtotalCents) })),
                    h('div', {}, h('dt', { text: 'Tax' }), h('dd', { text: formatMoney(inv.taxCents) })),
                    h('div', { class: 'grand' }, h('dt', { text: 'Total due' }), h('dd', { text: formatMoney(inv.totalCents) }))),
                h('p', { class: 'muted small', text: 'Thank you for your business.' })));
    } catch (error) {
        if (ctx.alive()) replace(container, pageHeader('Invoice'), errorPanel(error, ctx.refresh), h('a', { class: 'secondary-button link-button', href: `#/orders/${params.id}` }, '← Back to order'));
    }
}
