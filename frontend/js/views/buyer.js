'use strict';

import { h, replace } from '../dom.js';
import { api, describeError } from '../api.js';
import { cartStore } from '../cart-store.js';
import { formatMoney, newIdempotencyKey } from '../format.js';
import { confirmDialog, emptyState, errorPanel, field, loadingBlock, notify, notifyError, pageHeader, pager, stockBadge, table, withBusy } from '../ui.js';

const PAGE_SIZE = 12;

/** Catalogue with search, sort, in-stock filter and pagination. */
export async function catalogue(ctx) {
    const { container, query } = ctx;
    const page = Math.max(1, Number(query.get('page')) || 1);
    const q = query.get('q') || '';
    const sort = query.get('sort') || 'name';
    const inStock = query.get('inStock') === 'true';

    const search = h('input', { type: 'search', name: 'q', value: q, maxlength: '100', placeholder: 'Name or SKU' });
    const sortSelect = h('select', { name: 'sort' },
        [['name', 'Name (A–Z)'], ['newest', 'Newest first'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low']]
            .map(([value, label]) => h('option', { value, selected: value === sort, text: label })));
    const stockBox = h('input', { type: 'checkbox', name: 'inStock', id: 'f-stock', checked: inStock });
    const form = h('form', { class: 'filters', role: 'search', 'aria-label': 'Search the catalogue', on: {
        submit: (event) => {
            event.preventDefault();
            ctx.go('/catalogue', { q: search.value.trim(), sort: sortSelect.value, inStock: stockBox.checked ? 'true' : '' });
        }
    } },
    field('f-q', 'Search', search).wrap,
    field('f-sort', 'Sort by', sortSelect).wrap,
    h('label', { class: 'check', for: 'f-stock' }, stockBox, ' In stock only'),
    h('button', { class: 'primary-button inline', type: 'submit' }, 'Search'),
    h('a', { class: 'text-button', href: '#/catalogue' }, 'Reset'));

    const results = h('div', { 'aria-live': 'polite' }, loadingBlock('Loading products…'));
    replace(container, pageHeader('Catalogue', 'Browse products from every seller and add them to your cart.'), form, results);

    try {
        const [response] = await Promise.all([
            api('/products', { query: { q, sort, inStock: inStock ? 'true' : '', page, limit: PAGE_SIZE } }),
            cartStore.cart ? null : cartStore.load().catch(() => null)
        ]);
        if (!ctx.alive()) return;
        const { products, pagination } = response.data;
        if (products.length === 0) {
            replace(results, emptyState('No products found', q ? `Nothing matches “${q}”. Try a different search.` : 'The catalogue is empty right now.'));
            return;
        }
        replace(results,
            h('p', { class: 'result-count', text: `${pagination.total} product${pagination.total === 1 ? '' : 's'}` }),
            h('div', { class: 'product-grid' }, products.map((product) => productCard(ctx, product))),
            pager(pagination, (next) => ctx.go('/catalogue', { q, sort, inStock: inStock ? 'true' : '', page: next })));
    } catch (error) {
        if (ctx.alive()) replace(results, errorPanel(error, ctx.refresh));
    }
}

function productCard(ctx, product) {
    const inCart = cartStore.quantityOf(product.id);
    const qty = h('input', { type: 'number', min: '1', max: String(Math.max(1, product.stockQuantity)), value: '1', inputmode: 'numeric' });
    qty.id = `qty-${product.id}`;
    const addButton = h('button', { class: 'primary-button inline', type: 'submit', disabled: product.stockQuantity === 0 }, 'Add to cart');
    const add = async (event) => {
        event.preventDefault();
        const amount = Number(qty.value);
        if (!Number.isInteger(amount) || amount < 1) { notify('Enter a quantity of 1 or more.', 'error'); qty.focus(); return; }
        await withBusy(addButton, async () => {
            try {
                const result = await api(`/cart/items/${product.id}`, { method: 'PUT', body: { quantity: inCart + amount } });
                cartStore.set(result.data.cart);
                notify(`Added ${amount} × ${product.name} to your cart.`);
                ctx.refresh();
            } catch (error) {
                const { message, lines } = describeError(error);
                const extra = error.code === 'INSUFFICIENT_STOCK' && inCart > 0 ? ` You already have ${inCart} in your cart.` : '';
                notify(message + extra, 'error', lines);
            }
        });
    };
    return h('article', { class: 'product-card' },
        h('div', { class: 'product-top' }, h('h2', { text: product.name }), stockBadge(product)),
        h('p', { class: 'muted small', text: `SKU ${product.sku} · sold by ${product.sellerName}` }),
        h('p', { class: 'product-desc', text: product.description || 'No description provided.' }),
        h('p', { class: 'price', text: formatMoney(product.priceCents) }),
        h('form', { class: 'add-form', on: { submit: add } },
            h('label', { class: 'sr-only', for: qty.id, text: `Quantity of ${product.name}` }), qty, addButton),
        inCart > 0 ? h('p', { class: 'muted small', text: `${inCart} already in your cart` }) : null);
}

/** Cart with quantity edit, stock warnings and totals. */
export async function cart(ctx) {
    const { container } = ctx;
    replace(container, pageHeader('Your cart', 'Review quantities before you check out.'), loadingBlock('Loading your cart…'));
    try {
        const current = await cartStore.load();
        if (!ctx.alive()) return;
        replace(container, pageHeader('Your cart', 'Review quantities before you check out.'), cartBody(ctx, current));
    } catch (error) {
        if (ctx.alive()) replace(container, pageHeader('Your cart'), errorPanel(error, ctx.refresh));
    }
}

function issueText(item) {
    if (item.issue === 'unavailable') return 'This product is no longer available. Remove it to continue.';
    if (item.issue === 'insufficient_stock') return `Only ${item.availableQuantity} in stock. Reduce the quantity to continue.`;
    return null;
}

function cartBody(ctx, current) {
    if (current.items.length === 0) {
        return emptyState('Your cart is empty', 'Add products from the catalogue to start an order.',
            h('a', { class: 'primary-button inline link-button', href: '#/catalogue' }, 'Browse the catalogue'));
    }
    const columns = [
        { label: 'Product', render: (item) => h('div', {},
            h('strong', { text: item.name }), h('div', { class: 'muted small', text: `SKU ${item.sku}` }),
            item.issue ? h('div', { class: 'issue', role: 'alert', text: `⚠ ${issueText(item)}` }) : null) },
        { label: 'Unit price', class: 'num', render: (item) => formatMoney(item.unitPriceCents) },
        { label: 'Quantity', render: (item) => quantityForm(ctx, item) },
        { label: 'Line total', class: 'num', render: (item) => formatMoney(item.lineTotalCents) },
        { label: 'Remove', render: (item) => h('button', { class: 'text-button', type: 'button', 'aria-label': `Remove ${item.name} from cart`, on: { click: async (event) => {
        const button = event.currentTarget;
            await withBusy(button, async () => {
                try {
                    const result = await api(`/cart/items/${item.productId}`, { method: 'DELETE' });
                    cartStore.set(result.data.cart);
                    notify(`${item.name} removed from your cart.`, 'info');
                    ctx.refresh();
                } catch (error) { notifyError(error); }
            });
        } } }, 'Remove') }
    ];
    const blocked = !current.canCheckout;
    return h('div', {},
        blocked ? h('div', { class: 'notice', role: 'alert' }, 'Some items need attention before you can check out.') : null,
        table(columns, current.items, 'Items in your cart'),
        totalsBlock(current),
        h('div', { class: 'button-row' },
            h('button', { class: 'secondary-button', type: 'button', on: { click: async () => {
                const ok = await confirmDialog({ title: 'Clear your cart?', message: 'All items will be removed from your cart.', confirmLabel: 'Clear cart', danger: true });
                if (!ok) return;
                try {
                    const result = await api('/cart', { method: 'DELETE' });
                    cartStore.set(result.data.cart);
                    ctx.refresh();
                } catch (error) { notifyError(error); }
            } } }, 'Clear cart'),
            h('a', { class: 'secondary-button link-button', href: '#/catalogue' }, 'Continue shopping'),
            blocked
                ? h('button', { class: 'primary-button inline', type: 'button', disabled: true, 'aria-describedby': 'checkout-help' }, 'Proceed to checkout')
                : h('a', { class: 'primary-button inline link-button', href: '#/checkout' }, 'Proceed to checkout')),
        blocked ? h('p', { class: 'muted small', id: 'checkout-help', text: 'Fix the warnings above to enable checkout.' }) : null);
}

function quantityForm(ctx, item) {
    const input = h('input', { type: 'number', min: '1', max: '10000', value: String(item.quantity), inputmode: 'numeric' });
    input.id = `cart-qty-${item.productId}`;
    const save = h('button', { class: 'secondary-button', type: 'submit' }, 'Update');
    return h('form', { class: 'qty-form', on: { submit: async (event) => {
        event.preventDefault();
        const quantity = Number(input.value);
        if (!Number.isInteger(quantity) || quantity < 1) { notify('Enter a quantity of 1 or more.', 'error'); input.focus(); return; }
        await withBusy(save, async () => {
            try {
                const result = await api(`/cart/items/${item.productId}`, { method: 'PUT', body: { quantity } });
                cartStore.set(result.data.cart);
                notify(`Quantity for ${item.name} set to ${quantity}.`);
                ctx.refresh();
            } catch (error) {
                notifyError(error);
                input.value = String(item.quantity);
            }
        });
    } } }, h('label', { class: 'sr-only', for: input.id, text: `Quantity of ${item.name}` }), input, save);
}

function totalsBlock(current) {
    return h('dl', { class: 'totals' },
        h('div', {}, h('dt', { text: 'Subtotal' }), h('dd', { text: formatMoney(current.subtotalCents) })),
        h('div', {}, h('dt', { text: 'Tax' }), h('dd', { text: formatMoney(current.taxCents) })),
        h('div', { class: 'grand' }, h('dt', { text: 'Total' }), h('dd', { text: formatMoney(current.totalCents) })));
}

// The key stays the same while the buyer retries the same cart, so a double click
// or a flaky network can never create two orders. It changes when the cart changes.
let checkoutKey = null;
let checkoutSignature = null;

/** Checkout with a shipping address and an Idempotency-Key. */
export async function checkout(ctx) {
    const { container } = ctx;
    replace(container, pageHeader('Checkout', 'Confirm your items and where to deliver them.'), loadingBlock());
    let current;
    try {
        current = await cartStore.load();
    } catch (error) {
        if (ctx.alive()) replace(container, pageHeader('Checkout'), errorPanel(error, ctx.refresh));
        return;
    }
    if (!ctx.alive()) return;
    if (current.items.length === 0) {
        replace(container, pageHeader('Checkout'), emptyState('Your cart is empty', 'Add something first.',
            h('a', { class: 'primary-button inline link-button', href: '#/catalogue' }, 'Browse the catalogue')));
        return;
    }
    if (!current.canCheckout) {
        replace(container, pageHeader('Checkout'), h('div', { class: 'error-panel', role: 'alert' },
            h('strong', { text: 'Some items in your cart cannot be ordered yet.' }),
            h('ul', {}, current.items.filter((item) => item.issue).map((item) => h('li', { text: `${item.name}: ${issueText(item)}` })))),
        h('a', { class: 'primary-button inline link-button', href: '#/cart' }, 'Review your cart'));
        return;
    }

    const signature = current.items.map((item) => `${item.productId}:${item.quantity}`).join('|');
    if (!checkoutKey || signature !== checkoutSignature) {
        checkoutKey = newIdempotencyKey();
        checkoutSignature = signature;
    }

    const address = h('textarea', { rows: '4', minlength: '10', maxlength: '500', required: true, autocomplete: 'street-address', placeholder: 'Company, street, city, postal code, country' });
    const addressField = field('shipping-address', 'Shipping address', address, '10–500 characters. Include street, city and postal code.');
    const submit = h('button', { class: 'primary-button inline', type: 'submit' }, 'Place order');
    const form = h('form', { class: 'panel', novalidate: true, on: { submit: async (event) => {
        event.preventDefault();
        const value = address.value.trim();
        if (value.length < 10 || value.length > 500) {
            addressField.setError('Enter a full address between 10 and 500 characters.');
            address.focus();
            return;
        }
        addressField.setError('');
        await withBusy(submit, async () => {
            try {
                const result = await api('/orders', { method: 'POST', body: { shippingAddress: value }, headers: { 'Idempotency-Key': checkoutKey } });
                checkoutKey = null;
                checkoutSignature = null;
                cartStore.reset();
                const order = result.data.order;
                ctx.go(`/orders/${order.id}`, { placed: result.data.replayed ? 'replayed' : '1' });
            } catch (error) {
                notifyError(error);
                if (error.status === 409) {
                    // Stock moved: the key is useless for the changed cart, so start fresh.
                    checkoutKey = null;
                    await cartStore.load().catch(() => null);
                }
            }
        });
    } } }, h('h2', { text: 'Delivery' }), addressField.wrap, h('div', { class: 'button-row' }, h('a', { class: 'secondary-button link-button', href: '#/cart' }, 'Back to cart'), submit));

    const summary = table([
        { label: 'Product', render: (item) => h('span', {}, h('strong', { text: item.name }), ' ', h('span', { class: 'muted small', text: `(${item.sku})` })) },
        { label: 'Quantity', class: 'num', render: (item) => item.quantity },
        { label: 'Line total', class: 'num', render: (item) => formatMoney(item.lineTotalCents) }
    ], current.items, 'Order summary');

    replace(container, pageHeader('Checkout', 'Confirm your items and where to deliver them.'),
        h('div', { class: 'two-col' }, h('div', {}, h('h2', { class: 'section-h', text: 'Order summary' }), summary, totalsBlock(current)), form));
}
