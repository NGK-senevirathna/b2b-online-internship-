'use strict';

import { api } from './api.js';

/** In-memory copy of the buyer's cart, used for the header badge and "already in cart" checks. */
let cart = null;
const listeners = new Set();

export const cartStore = {
    get cart() { return cart; },
    get count() { return cart ? cart.items.reduce((sum, item) => sum + item.quantity, 0) : 0; },
    quantityOf(productId) { return cart?.items.find((item) => item.productId === productId)?.quantity || 0; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { cart = next; for (const fn of listeners) fn(); },
    reset() { cart = null; for (const fn of listeners) fn(); },
    async load() {
        const result = await api('/cart');
        cartStore.set(result.data.cart);
        return cart;
    }
};
