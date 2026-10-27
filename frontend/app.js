'use strict';

import { h, replace } from './js/dom.js';
import { api, session } from './js/api.js';
import { cartStore } from './js/cart-store.js';
import { clearMessages, flash, notify, notifyError, pageHeader, showFlash } from './js/ui.js';
import { initAuth, showAuthView } from './js/views/auth.js';
import { account } from './js/views/account.js';
import * as buyer from './js/views/buyer.js';
import * as orders from './js/views/orders.js';
import * as seller from './js/views/seller.js';
import * as admin from './js/views/admin.js';

// One table drives navigation, access control and rendering.
const ROUTES = [
    { path: '/catalogue', roles: ['Buyer'], title: 'Catalogue', render: buyer.catalogue },
    { path: '/cart', roles: ['Buyer'], title: 'Cart', render: buyer.cart },
    { path: '/checkout', roles: ['Buyer'], title: 'Checkout', render: buyer.checkout },
    { path: '/orders', roles: ['Buyer'], title: 'My orders', render: (ctx) => orders.list(ctx, '/orders') },
    { path: '/orders/:id', roles: ['Buyer', 'Seller', 'Admin'], title: 'Order', render: orders.detail },
    { path: '/orders/:id/invoice', roles: ['Buyer', 'Admin'], title: 'Invoice', render: orders.invoice },
    { path: '/seller/products', roles: ['Seller', 'Admin'], title: 'Products', render: seller.products },
    { path: '/seller/products/new', roles: ['Seller'], title: 'New product', render: seller.productForm },
    { path: '/seller/products/:id/edit', roles: ['Seller', 'Admin'], title: 'Edit product', render: seller.productForm },
    { path: '/seller/products/:id/stock', roles: ['Seller', 'Admin'], title: 'Stock', render: seller.stock },
    { path: '/seller/orders', roles: ['Seller'], title: 'Orders', render: (ctx) => orders.list(ctx, '/seller/orders') },
    { path: '/admin', roles: ['Admin'], title: 'Dashboard', render: admin.dashboard },
    { path: '/admin/orders', roles: ['Admin'], title: 'All orders', render: (ctx) => orders.list(ctx, '/admin/orders') },
    { path: '/admin/users', roles: ['Admin'], title: 'Users', render: admin.users },
    { path: '/admin/audit', roles: ['Admin'], title: 'Audit log', render: admin.audit },
    { path: '/account', roles: ['Buyer', 'Seller', 'Admin'], title: 'My account', render: account }
];

const NAV = {
    Buyer: [['/catalogue', 'Catalogue', '▦'], ['/cart', 'Cart', '🛒'], ['/orders', 'My orders', '☰'], ['/account', 'My account', '♙']],
    Seller: [['/seller/products', 'My products', '▦'], ['/seller/orders', 'Orders', '☰'], ['/account', 'My account', '♙']],
    Admin: [['/admin', 'Dashboard', '◫'], ['/admin/orders', 'Orders', '☰'], ['/seller/products', 'Products', '▦'], ['/admin/users', 'Users', '♙'], ['/admin/audit', 'Audit log', '✎'], ['/account', 'My account', '⚙']]
};
const HOME = { Buyer: '/catalogue', Seller: '/seller/products', Admin: '/admin' };

const $ = (selector) => document.querySelector(selector);
let navigation = 0;
let pendingHash = null;

function matchRoute(path) {
    for (const route of ROUTES) {
        const names = [];
        const pattern = new RegExp(`^${route.path.replace(/:([a-z]+)/g, (_m, name) => { names.push(name); return '([0-9a-fA-F-]{36})'; })}$`);
        const match = pattern.exec(path);
        if (match) return { route, params: Object.fromEntries(names.map((n, i) => [n, match[i + 1]])) };
    }
    return null;
}

function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, search = ''] = raw.split('?');
    return { path, query: new URLSearchParams(search) };
}

/** Navigates to a path; when the hash does not change, re-renders instead. */
function go(path, query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== '' && value !== undefined && value !== null && value !== false) params.set(key, value);
    const text = params.toString();
    const target = `#${path}${text ? `?${text}` : ''}`;
    if (location.hash === target) renderRoute();
    else location.hash = target;
}

function renderNav() {
    const user = session.user;
    const nav = $('#side-nav');
    if (!user) { replace(nav); return; }
    const current = parseHash().path;
    replace(nav, NAV[user.role].map(([path, label, icon]) => {
        const active = current === path || (path !== '/admin' && path !== '/account' && current.startsWith(`${path}/`));
        const link = h('a', { class: `nav-link${active ? ' is-active' : ''}`, href: `#${path}`, 'aria-current': active ? 'page' : null },
            h('span', { class: 'nav-icon', 'aria-hidden': 'true', text: icon }), label);
        if (path === '/cart') link.append(h('span', { class: 'cart-count', id: 'cart-count', text: String(cartStore.count), hidden: cartStore.count === 0 }));
        return link;
    }));
}

function renderCartBadge() {
    const badge = $('#cart-count');
    if (badge) {
        badge.textContent = String(cartStore.count);
        badge.hidden = cartStore.count === 0;
    }
    const top = $('#top-cart');
    if (top) {
        top.hidden = session.user?.role !== 'Buyer';
        top.textContent = `Cart (${cartStore.count})`;
    }
}

function showShell(signedIn) {
    $('#auth-view').hidden = signedIn;
    $('#app-view').hidden = !signedIn;
    $('#topbar-session').hidden = !signedIn;
    $('#menu-button').hidden = !signedIn;
    $('#page-heading').hidden = signedIn;
    $('#sidebar').classList.toggle('is-signed-in', signedIn);
    if (!signedIn) {
        $('#sidebar').classList.remove('is-open');
        $('#menu-button').setAttribute('aria-expanded', 'false');
    }
}

async function renderRoute(options = {}) {
    const id = ++navigation;
    // A refresh after an action keeps the message that action just showed; a page change clears it.
    if (!options.keepMessages) {
        clearMessages();
        showFlash();
    }
    if (!session.signedIn) {
        showShell(false);
        $('#crumb').textContent = 'Sign in';
        renderNav();
        return;
    }
    const user = session.user;
    showShell(true);
    $('#sidebar').classList.remove('is-open');
    $('#menu-button').setAttribute('aria-expanded', 'false');
    $('#topbar-username').textContent = `${user.username} · ${user.role}`;

    const { path, query } = parseHash();
    if (path === '/' || path === '') { go(HOME[user.role]); return; }
    const found = matchRoute(path);
    const container = $('#view');
    renderNav();
    renderCartBadge();

    if (!found) {
        $('#crumb').textContent = 'Not found';
        replace(container, pageHeader('Page not found', 'That address does not exist.'), h('a', { class: 'primary-button inline link-button', href: `#${HOME[user.role]}` }, 'Go to your home page'));
        focusHeading();
        return;
    }
    if (!found.route.roles.includes(user.role)) {
        $('#crumb').textContent = 'No access';
        replace(container, pageHeader('You do not have access to this page', `Your role is ${user.role}.`), h('a', { class: 'primary-button inline link-button', href: `#${HOME[user.role]}` }, 'Go to your home page'));
        focusHeading();
        return;
    }
    $('#crumb').textContent = found.route.title;
    document.title = `${found.route.title} | Northstar`;
    const ctx = { container, params: found.params, query, user, go, refresh: () => renderRoute({ keepMessages: true }), alive: () => id === navigation };
    try {
        await found.route.render(ctx);
    } catch (error) {
        if (ctx.alive()) { notifyError(error); }
    }
    if (ctx.alive()) focusHeading();
}

function focusHeading() {
    // Move keyboard and screen-reader focus to the new page title after navigation.
    const heading = $('#view-title') || $('#view h1');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}

function afterSignIn() {
    cartStore.reset();
    if (session.user.role === 'Buyer') cartStore.load().catch(() => null);
    const target = pendingHash && pendingHash !== '#/' ? pendingHash : `#${HOME[session.user.role]}`;
    pendingHash = null;
    if (location.hash === target) renderRoute(); else location.hash = target;
}

async function signOut() {
    try { await api('/auth/logout', { method: 'POST' }); } catch (_e) { /* local session is cleared either way */ }
    session.clear();
    cartStore.reset();
    pendingHash = null;
    showAuthView('login');
    flash('You have signed out.', 'info');
    if (location.hash === '#/') renderRoute(); else location.hash = '#/';
}

function boot() {
    initAuth(afterSignIn);
    pendingHash = location.hash;
    window.addEventListener('hashchange', renderRoute);
    $('#signout-button').addEventListener('click', signOut);
    $('#menu-button').addEventListener('click', () => {
        const open = $('#sidebar').classList.toggle('is-open');
        $('#menu-button').setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && $('#sidebar').classList.contains('is-open')) {
            $('#sidebar').classList.remove('is-open');
            $('#menu-button').setAttribute('aria-expanded', 'false');
            $('#menu-button').focus();
        }
    });
    session.on('expired', () => {
        cartStore.reset();
        showAuthView('login');
        renderRoute();
        notify('Your session expired. Please sign in again.', 'error');
    });
    session.on('busy', (event) => {
        $('#busy-bar').classList.toggle('is-busy', event.detail);
        document.body.setAttribute('aria-busy', String(event.detail));
    });
    cartStore.subscribe(renderCartBadge);
    renderRoute();
}

boot();
