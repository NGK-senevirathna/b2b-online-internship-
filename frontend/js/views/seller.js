'use strict';

import { h, replace } from '../dom.js';
import { api } from '../api.js';
import { centsToDollars, dollarsToCents, formatDate, formatMoney, titleCase } from '../format.js';
import { badge, confirmDialog, emptyState, errorPanel, field, flash, loadingBlock, notify, notifyError, pageHeader, pager, stockBadge, table, withBusy } from '../ui.js';

/** Seller (own) or Admin (all) product table with filters and row actions. */
export async function products(ctx) {
    const { container, query, user } = ctx;
    const isAdmin = user.role === 'Admin';
    const page = Math.max(1, Number(query.get('page')) || 1);
    const q = query.get('q') || '';
    const status = query.get('status') || '';
    const sort = query.get('sort') || 'name';
    const lowStock = query.get('lowStock') === 'true';

    const search = h('input', { type: 'search', value: q, maxlength: '100', placeholder: 'Name or SKU' });
    const statusSelect = h('select', {}, [['', 'All'], ['active', 'Active'], ['archived', 'Archived']].map(([v, l]) => h('option', { value: v, selected: v === status, text: l })));
    const sortSelect = h('select', {}, [['name', 'Name'], ['newest', 'Newest'], ['price_asc', 'Price ↑'], ['price_desc', 'Price ↓']].map(([v, l]) => h('option', { value: v, selected: v === sort, text: l })));
    const low = h('input', { type: 'checkbox', id: 'f-low', checked: lowStock });
    const filters = h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter products', on: { submit: (event) => {
        event.preventDefault();
        ctx.go('/seller/products', { q: search.value.trim(), status: statusSelect.value, sort: sortSelect.value, lowStock: low.checked ? 'true' : '' });
    } } },
    field('f-q', 'Search', search).wrap, field('f-status', 'Status', statusSelect).wrap, field('f-sort', 'Sort by', sortSelect).wrap,
    h('label', { class: 'check', for: 'f-low' }, low, ' Low stock only'),
    h('button', { class: 'primary-button inline', type: 'submit' }, 'Apply'),
    h('a', { class: 'text-button', href: '#/seller/products' }, 'Reset'));

    const results = h('div', { 'aria-live': 'polite' }, loadingBlock('Loading products…'));
    replace(container,
        pageHeader(isAdmin ? 'All products' : 'My products', isAdmin ? 'Manage any seller’s catalogue and stock.' : 'Create, edit, archive and restock your products.',
            isAdmin ? null : h('a', { class: 'primary-button inline link-button', href: '#/seller/products/new' }, '+ New product')),
        filters, results);
    try {
        const { data } = await api('/seller/products', { query: { q, status, sort, lowStock: lowStock ? 'true' : '', page, limit: 10 } });
        if (!ctx.alive()) return;
        if (data.products.length === 0) {
            replace(results, emptyState('No products found', lowStock ? 'Nothing is running low. Nice.' : 'Adjust the filters or create a product.'));
            return;
        }
        const columns = [
            { label: 'SKU', render: (p) => h('code', { text: p.sku }) },
            { label: 'Product', render: (p) => h('div', {}, h('strong', { text: p.name }), isAdmin ? h('div', { class: 'muted small', text: `Seller: ${p.sellerName}` }) : null) },
            { label: 'Price', class: 'num', render: (p) => formatMoney(p.priceCents) },
            { label: 'Stock', render: (p) => stockBadge(p) },
            { label: 'Status', render: (p) => badge(p.status) },
            { label: 'Actions', render: (p) => rowActions(ctx, p) }
        ];
        replace(results, table(columns, data.products, 'Products'),
            pager(data.pagination, (next) => ctx.go('/seller/products', { q, status, sort, lowStock: lowStock ? 'true' : '', page: next })));
    } catch (error) {
        if (ctx.alive()) replace(results, errorPanel(error, ctx.refresh));
    }
}

function rowActions(ctx, product) {
    const archived = product.status === 'archived';
    const toggle = h('button', { class: archived ? 'secondary-button small-btn' : 'danger-button small-btn', type: 'button', 'aria-label': `${archived ? 'Restore' : 'Archive'} ${product.name}`, on: { click: async (event) => {
        const button = event.currentTarget;
        if (!archived) {
            const ok = await confirmDialog({ title: `Archive “${product.name}”?`, message: 'Buyers will no longer see it. Past orders keep their history, and you can restore it later.', confirmLabel: 'Archive', danger: true });
            if (!ok) return;
        }
        await withBusy(button, async () => {
            try {
                if (archived) await api(`/seller/products/${product.id}`, { method: 'PATCH', body: { status: 'active' } });
                else await api(`/seller/products/${product.id}`, { method: 'DELETE' });
                notify(`${product.name} ${archived ? 'restored' : 'archived'}.`);
                ctx.refresh();
            } catch (error) { notifyError(error); }
        });
    } } }, archived ? 'Restore' : 'Archive');
    return h('div', { class: 'action-row' },
        h('a', { class: 'secondary-button small-btn link-button', href: `#/seller/products/${product.id}/edit`, 'aria-label': `Edit ${product.name}` }, 'Edit'),
        h('a', { class: 'secondary-button small-btn link-button', href: `#/seller/products/${product.id}/stock`, 'aria-label': `Stock for ${product.name}` }, 'Stock'),
        toggle);
}

/** Create (no id) or edit (with id) form. */
export async function productForm(ctx) {
    const { container, params } = ctx;
    const editing = Boolean(params.id);
    let existing = null;
    if (editing) {
        replace(container, pageHeader('Edit product'), loadingBlock());
        try {
            existing = (await api(`/products/${params.id}`)).data.product;
        } catch (error) {
            if (ctx.alive()) replace(container, pageHeader('Edit product'), errorPanel(error, ctx.refresh));
            return;
        }
        if (!ctx.alive()) return;
    }

    const sku = h('input', { maxlength: '40', autocomplete: 'off', required: !editing, disabled: editing, value: existing?.sku || '' });
    const name = h('input', { maxlength: '120', required: true, value: existing?.name || '' });
    const description = h('textarea', { rows: '4', maxlength: '2000' });
    description.value = existing?.description || '';
    const price = h('input', { inputmode: 'decimal', required: true, placeholder: '0.00', value: existing ? centsToDollars(existing.priceCents) : '' });
    const stock = h('input', { type: 'number', min: '0', max: '1000000', value: '0', inputmode: 'numeric' });
    const statusSelect = h('select', {}, ['active', 'archived'].map((s) => h('option', { value: s, selected: existing?.status === s, text: titleCase(s) })));

    const f = {
        sku: field('p-sku', 'SKU', sku, editing ? 'The SKU cannot be changed.' : '2–40 characters: letters, numbers, dot, underscore, hyphen.'),
        name: field('p-name', 'Product name', name, '2–120 characters.'),
        description: field('p-description', 'Description (optional)', description),
        price: field('p-price', 'Price (USD)', price, 'For example 24.99'),
        stock: field('p-stock', 'Opening stock', stock, 'Later changes are made on the Stock page, with a note.'),
        status: field('p-status', 'Status', statusSelect, 'Archived products are hidden from buyers.')
    };
    const submit = h('button', { class: 'primary-button inline', type: 'submit' }, editing ? 'Save changes' : 'Create product');
    const form = h('form', { class: 'panel form-grid', novalidate: true, on: { submit: async (event) => {
        event.preventDefault();
        for (const item of Object.values(f)) item.setError('');
        const problems = [];
        if (!editing && !/^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/.test(sku.value.trim())) problems.push([f.sku, 'Use 2–40 letters, numbers, dots, underscores or hyphens.']);
        if (name.value.trim().length < 2) problems.push([f.name, 'Enter a name of at least 2 characters.']);
        const cents = dollarsToCents(price.value);
        if (cents === null || cents < 1 || cents > 100000000) problems.push([f.price, 'Enter a price such as 24.99 (at most 1,000,000.00).']);
        const opening = Number(stock.value);
        if (!editing && (!Number.isInteger(opening) || opening < 0 || opening > 1000000)) problems.push([f.stock, 'Enter a whole number from 0 to 1,000,000.']);
        if (problems.length) {
            for (const [item, message] of problems) item.setError(message);
            problems[0][0].input.focus();
            return;
        }
        await withBusy(submit, async () => {
            try {
                if (editing) {
                    const changes = {};
                    if (name.value.trim() !== existing.name) changes.name = name.value.trim();
                    if (description.value.trim() !== existing.description) changes.description = description.value.trim();
                    if (cents !== existing.priceCents) changes.priceCents = cents;
                    if (statusSelect.value !== existing.status) changes.status = statusSelect.value;
                    if (Object.keys(changes).length === 0) { notify('There is nothing to save yet — no fields changed.', 'info'); return; }
                    await api(`/seller/products/${existing.id}`, { method: 'PATCH', body: changes });
                    flash('Product updated.');
                    ctx.go('/seller/products', {});
                } else {
                    await api('/seller/products', { method: 'POST', body: { sku: sku.value.trim(), name: name.value.trim(), description: description.value.trim(), priceCents: cents, stockQuantity: opening } });
                    flash('Product created.');
                    ctx.go('/seller/products', {});
                }
            } catch (error) {
                if (error.status === 409 && !editing) f.sku.setError(error.message);
                notifyError(error);
            }
        });
    } } },
    f.sku.wrap, f.name.wrap, h('div', { class: 'span-2' }, f.description.wrap), f.price.wrap,
    editing ? f.status.wrap : f.stock.wrap,
    h('div', { class: 'button-row span-2' }, h('a', { class: 'secondary-button link-button', href: '#/seller/products' }, 'Cancel'), submit));

    replace(container, pageHeader(editing ? `Edit ${existing.name}` : 'New product', editing ? 'Change catalogue details. Use the Stock page to change quantities.' : 'Add a product to your catalogue.'), form);
}

/** Stock adjustment with a mandatory note, plus the ledger of movements. */
export async function stock(ctx) {
    const { container, params } = ctx;
    replace(container, pageHeader('Stock'), loadingBlock());
    let product;
    let movements;
    try {
        [product, movements] = await Promise.all([
            api(`/products/${params.id}`).then((r) => r.data.product),
            api(`/seller/products/${params.id}/stock-history`).then((r) => r.data.movements)
        ]);
    } catch (error) {
        if (ctx.alive()) replace(container, pageHeader('Stock'), errorPanel(error, ctx.refresh));
        return;
    }
    if (!ctx.alive()) return;

    const direction = h('select', {}, h('option', { value: 'add', text: 'Add stock (receive)' }), h('option', { value: 'remove', text: 'Remove stock (loss, return…)' }));
    const amount = h('input', { type: 'number', min: '1', max: '1000000', inputmode: 'numeric', required: true });
    const note = h('input', { maxlength: '200', required: true, placeholder: 'e.g. Supplier delivery PO-1182' });
    const preview = h('p', { class: 'muted small', 'aria-live': 'polite' });
    const f = {
        direction: field('s-dir', 'Change', direction),
        amount: field('s-amount', 'Quantity', amount),
        note: field('s-note', 'Note (required)', note, '3–200 characters. This is saved in the stock history.')
    };
    const update = () => {
        const n = Number(amount.value);
        if (!Number.isInteger(n) || n < 1) { preview.textContent = ''; return; }
        const next = product.stockQuantity + (direction.value === 'add' ? n : -n);
        preview.textContent = next < 0 ? `This would take stock below zero (now ${product.stockQuantity}).` : `New stock level: ${next}.`;
    };
    direction.addEventListener('change', update);
    amount.addEventListener('input', update);
    const submit = h('button', { class: 'primary-button inline', type: 'submit' }, 'Apply adjustment');
    const form = h('form', { class: 'panel', novalidate: true, on: { submit: async (event) => {
        event.preventDefault();
        for (const item of Object.values(f)) item.setError('');
        const n = Number(amount.value);
        if (!Number.isInteger(n) || n < 1 || n > 1000000) { f.amount.setError('Enter a whole number of 1 or more.'); amount.focus(); return; }
        const delta = direction.value === 'add' ? n : -n;
        if (product.stockQuantity + delta < 0) { f.amount.setError(`You only have ${product.stockQuantity} in stock.`); amount.focus(); return; }
        if (note.value.trim().length < 3) { f.note.setError('Add a short note (at least 3 characters).'); note.focus(); return; }
        await withBusy(submit, async () => {
            try {
                await api(`/seller/products/${product.id}/stock`, { method: 'POST', body: { delta, note: note.value.trim() } });
                notify(`Stock updated (${delta > 0 ? '+' : ''}${delta}).`);
                ctx.refresh();
            } catch (error) { notifyError(error); }
        });
    } } }, h('h2', { text: 'Adjust stock' }), f.direction.wrap, f.amount.wrap, preview, f.note.wrap, submit);

    const history = movements.length === 0
        ? emptyState('No movements yet', 'Adjustments and sales will be listed here.')
        : table([
            { label: 'When', render: (m) => formatDate(m.createdAt) },
            { label: 'Change', class: 'num', render: (m) => h('strong', { class: m.delta > 0 ? 'pos' : 'neg', text: `${m.delta > 0 ? '+' : ''}${m.delta}` }) },
            { label: 'Stock after', class: 'num', render: (m) => m.quantityAfter },
            { label: 'Reason', render: (m) => titleCase(m.reason) },
            { label: 'Note', render: (m) => m.note || '—' },
            { label: 'By', render: (m) => m.actorUsername || 'system' }
        ], movements, `Stock history for ${product.name}`);

    replace(container,
        pageHeader(`Stock · ${product.name}`, `SKU ${product.sku}`, h('a', { class: 'secondary-button link-button', href: '#/seller/products' }, '← Back to products')),
        h('div', { class: 'panel status-line' }, h('span', { class: 'big-number', text: String(product.stockQuantity) }), h('span', { class: 'muted', text: 'units on hand' }), stockBadge(product), badge(product.status)),
        h('div', { class: 'two-col' }, form, h('div', {}, h('h2', { class: 'section-h', text: 'Stock history' }), history)));
}
