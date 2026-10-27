'use strict';

import { h, replace } from '../dom.js';
import { api } from '../api.js';
import { formatDate, formatMoney, shortId, titleCase } from '../format.js';
import { badge, confirmDialog, emptyState, errorPanel, field, loadingBlock, notify, notifyError, pageHeader, pager, table, withBusy } from '../ui.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statCard({ label, value, hint, href, tone }) {
    const body = [h('span', { class: 'stat-label', text: label }), h('strong', { class: 'stat-value', text: String(value) }), hint ? h('span', { class: 'muted small', text: hint }) : null];
    return href ? h('a', { class: `stat-card ${tone || ''}`, href }, body) : h('div', { class: `stat-card ${tone || ''}` }, body);
}

/** Dashboard summary cards. */
export async function dashboard(ctx) {
    const { container } = ctx;
    replace(container, pageHeader('Dashboard', 'A snapshot of orders, money, stock and people.'), loadingBlock());
    try {
        const { summary: s } = (await api('/admin/summary')).data;
        if (!ctx.alive()) return;
        const order = (status) => statCard({ label: titleCase(status), value: s.ordersByStatus[status], href: `#/admin/orders?status=${status}`, tone: status });
        replace(container, pageHeader('Dashboard', 'A snapshot of orders, money, stock and people.'),
            h('section', { 'aria-labelledby': 'h-orders' }, h('h2', { id: 'h-orders', class: 'section-h', text: 'Orders by status' }),
                h('div', { class: 'stat-grid five' }, ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'].map(order))),
            h('section', { 'aria-labelledby': 'h-money' }, h('h2', { id: 'h-money', class: 'section-h', text: 'Money' }),
                h('div', { class: 'stat-grid' },
                    statCard({ label: 'Ordered (not cancelled)', value: formatMoney(s.orderedCents) }),
                    statCard({ label: 'Paid', value: formatMoney(s.paidCents), tone: 'delivered' }),
                    statCard({ label: 'Outstanding', value: formatMoney(s.outstandingCents), tone: 'pending' }))),
            h('section', { 'aria-labelledby': 'h-stock' }, h('h2', { id: 'h-stock', class: 'section-h', text: 'Catalogue' }),
                h('div', { class: 'stat-grid' },
                    statCard({ label: 'Active products', value: s.activeProducts, href: '#/seller/products?status=active' }),
                    statCard({ label: 'Low stock', value: s.lowStockProducts, hint: 'at or below the threshold', href: '#/seller/products?lowStock=true', tone: 'low-stock' }),
                    statCard({ label: 'Out of stock', value: s.outOfStockProducts, tone: 'cancelled' }))),
            h('section', { 'aria-labelledby': 'h-users' }, h('h2', { id: 'h-users', class: 'section-h', text: 'Active users' }),
                h('div', { class: 'stat-grid' }, ['Buyer', 'Seller', 'Admin'].map((role) => statCard({ label: `${role}s`, value: s.usersByRole[role], href: `#/admin/users?role=${role}` })))));
    } catch (error) {
        if (ctx.alive()) replace(container, pageHeader('Dashboard'), errorPanel(error, ctx.refresh));
    }
}

/** User list with role change and activate / deactivate. */
export async function users(ctx) {
    const { container, query, user: me } = ctx;
    const page = Math.max(1, Number(query.get('page')) || 1);
    const q = query.get('q') || '';
    const role = query.get('role') || '';
    const search = h('input', { type: 'search', value: q, maxlength: '100', placeholder: 'Username or email' });
    const roleSelect = h('select', {}, [['', 'All roles'], ['Buyer', 'Buyer'], ['Seller', 'Seller'], ['Admin', 'Admin']].map(([v, l]) => h('option', { value: v, selected: v === role, text: l })));
    const filters = h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter users', on: { submit: (event) => {
        event.preventDefault();
        ctx.go('/admin/users', { q: search.value.trim(), role: roleSelect.value });
    } } }, field('f-q', 'Search', search).wrap, field('f-role', 'Role', roleSelect).wrap,
    h('button', { class: 'primary-button inline', type: 'submit' }, 'Apply'), h('a', { class: 'text-button', href: '#/admin/users' }, 'Reset'));
    const results = h('div', { 'aria-live': 'polite' }, loadingBlock('Loading users…'));
    replace(container, pageHeader('Users', 'Change roles and switch accounts on or off. Deactivating signs the person out immediately.'), filters, results);
    try {
        const { data } = await api('/admin/users', { query: { q, role, page, limit: 15 } });
        if (!ctx.alive()) return;
        if (data.users.length === 0) { replace(results, emptyState('No users found', 'Try a different search.')); return; }
        const columns = [
            { label: 'User', render: (u) => h('div', {}, h('strong', { text: u.username }), u.id === me.id ? h('span', { class: 'muted small', text: ' (you)' }) : null, h('div', { class: 'muted small', text: u.email })) },
            { label: 'Role', render: (u) => roleControl(ctx, u, u.id === me.id) },
            { label: 'Status', render: (u) => badge(u.isActive ? 'active' : 'inactive', u.isActive ? 'Active' : 'Deactivated') },
            { label: 'Joined', render: (u) => formatDate(u.createdAt, false) },
            { label: 'Access', render: (u) => activeToggle(ctx, u, u.id === me.id) }
        ];
        replace(results, table(columns, data.users, 'Users'), pager(data.pagination, (next) => ctx.go('/admin/users', { q, role, page: next })));
    } catch (error) {
        if (ctx.alive()) replace(results, errorPanel(error, ctx.refresh));
    }
}

function roleControl(ctx, user, isSelf) {
    const select = h('select', { 'aria-label': `Role for ${user.username}`, disabled: isSelf }, ['Buyer', 'Seller', 'Admin'].map((r) => h('option', { value: r, selected: r === user.role, text: r })));
    const save = h('button', { class: 'secondary-button small-btn', type: 'button', disabled: true, 'aria-label': `Save role for ${user.username}`, on: { click: async () => {
        const ok = await confirmDialog({ title: `Make ${user.username} a ${select.value}?`, message: 'The change applies immediately and is written to the audit log.', confirmLabel: 'Change role' });
        if (!ok) { select.value = user.role; save.disabled = true; return; }
        await withBusy(save, async () => {
            try {
                await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { role: select.value } });
                notify(`${user.username} is now ${select.value}.`);
                ctx.refresh();
            } catch (error) { notifyError(error); select.value = user.role; save.disabled = true; }
        });
    } } }, 'Save');
    select.addEventListener('change', () => { save.disabled = select.value === user.role; });
    return h('div', { class: 'action-row' }, select, isSelf ? null : save);
}

function activeToggle(ctx, user, isSelf) {
    if (isSelf) return h('span', { class: 'muted small', text: 'Not available for your own account' });
    const turnOff = user.isActive;
    return h('button', { class: turnOff ? 'danger-button small-btn' : 'secondary-button small-btn', type: 'button', 'aria-label': `${turnOff ? 'Deactivate' : 'Activate'} ${user.username}`, on: { click: async (event) => {
        const button = event.currentTarget;
        if (turnOff) {
            const ok = await confirmDialog({ title: `Deactivate ${user.username}?`, message: 'They are signed out at once and cannot sign in until you reactivate the account.', confirmLabel: 'Deactivate', danger: true });
            if (!ok) return;
        }
        await withBusy(button, async () => {
            try {
                await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { isActive: !turnOff } });
                notify(`${user.username} ${turnOff ? 'deactivated' : 'reactivated'}.`);
                ctx.refresh();
            } catch (error) { notifyError(error); }
        });
    } } }, turnOff ? 'Deactivate' : 'Activate');
}

const KNOWN_ACTIONS = ['auth.login', 'auth.login_failed', 'auth.login_blocked', 'auth.logout', 'auth.refresh_reuse_detected', 'user.register', 'user.update', 'product.create', 'product.update', 'product.archive', 'stock.adjust', 'order.create', 'order.status', 'order.cancel', 'invoice.paid'];

/** Audit log with filters. */
export async function audit(ctx) {
    const { container, query } = ctx;
    const page = Math.max(1, Number(query.get('page')) || 1);
    const values = { action: query.get('action') || '', entityType: query.get('entityType') || '', entityId: query.get('entityId') || '', actorId: query.get('actorId') || '' };

    const action = h('input', { value: values.action, list: 'audit-actions', maxlength: '60', placeholder: 'e.g. order.status', autocomplete: 'off' });
    const datalist = h('datalist', { id: 'audit-actions' }, KNOWN_ACTIONS.map((a) => h('option', { value: a })));
    const entityType = h('select', {}, [['', 'Any'], ['auth', 'auth'], ['user', 'user'], ['product', 'product'], ['order', 'order'], ['invoice', 'invoice']].map(([v, l]) => h('option', { value: v, selected: v === values.entityType, text: l })));
    const entityId = h('input', { value: values.entityId, maxlength: '36', placeholder: 'UUID', autocomplete: 'off' });
    const actorId = h('input', { value: values.actorId, maxlength: '36', placeholder: 'UUID', autocomplete: 'off' });
    const fe = field('a-entity', 'Entity id', entityId);
    const fa = field('a-actor', 'Actor id', actorId);
    const filters = h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter the audit log', novalidate: true, on: { submit: (event) => {
        event.preventDefault();
        fe.setError(''); fa.setError('');
        if (entityId.value.trim() && !UUID.test(entityId.value.trim())) { fe.setError('Enter a full UUID.'); entityId.focus(); return; }
        if (actorId.value.trim() && !UUID.test(actorId.value.trim())) { fa.setError('Enter a full UUID.'); actorId.focus(); return; }
        ctx.go('/admin/audit', { action: action.value.trim(), entityType: entityType.value, entityId: entityId.value.trim(), actorId: actorId.value.trim() });
    } } }, field('a-action', 'Action', action).wrap, datalist, field('a-type', 'Entity type', entityType).wrap, fe.wrap, fa.wrap,
    h('button', { class: 'primary-button inline', type: 'submit' }, 'Apply'), h('a', { class: 'text-button', href: '#/admin/audit' }, 'Reset'));

    const results = h('div', { 'aria-live': 'polite' }, loadingBlock('Loading audit log…'));
    replace(container, pageHeader('Audit log', 'Append-only record of security and business events.'), filters, results);
    try {
        const { data } = await api('/admin/audit-logs', { query: { ...values, page, limit: 25 } });
        if (!ctx.alive()) return;
        if (data.entries.length === 0) { replace(results, emptyState('No matching entries', 'Try removing a filter.')); return; }
        const columns = [
            { label: 'When', render: (e) => formatDate(e.createdAt) },
            { label: 'Action', render: (e) => h('code', { text: e.action }) },
            { label: 'Entity', render: (e) => h('span', {}, e.entityType, ' ', e.entityId ? h('a', { href: `#/admin/audit?entityType=${encodeURIComponent(e.entityType)}&entityId=${encodeURIComponent(e.entityId)}`, title: e.entityId, text: shortId(e.entityId) }) : '') },
            { label: 'Actor', render: (e) => (e.actorUsername ? `${e.actorUsername} (${e.actorRole})` : e.actorRole || 'system') },
            { label: 'Details', render: (e) => detailsCell(e.details) },
            { label: 'IP', render: (e) => e.ipAddress || '—' }
        ];
        replace(results, table(columns, data.entries, 'Audit log'), pager(data.pagination, (next) => ctx.go('/admin/audit', { ...values, page: next })));
    } catch (error) {
        if (ctx.alive()) replace(results, errorPanel(error, ctx.refresh));
    }
}

function detailsCell(details) {
    if (!details || Object.keys(details).length === 0) return '—';
    const text = JSON.stringify(details, null, 2);
    return h('details', {}, h('summary', { text: 'View' }), h('pre', { class: 'json', text }));
}
