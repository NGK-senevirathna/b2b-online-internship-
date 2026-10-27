'use strict';

import { h, replace } from '../dom.js';
import { pageHeader } from '../ui.js';

/** Profile card (kept from the original Northstar sign-in page). */
export function account(ctx) {
    const { user, container } = ctx;
    replace(container, pageHeader('My account', 'Your sign-in details and access level.'),
        h('div', { class: 'dashboard-grid' },
            h('article', { class: 'profile-card' },
                h('div', { class: 'section-title' }, h('div', {}, h('span', { class: 'section-kicker', text: 'IDENTITY' }), h('h2', { text: 'Account profile' }))),
                h('div', { class: 'profile-person' }, h('span', { class: 'avatar', 'aria-hidden': 'true', text: (user.username[0] || 'U').toUpperCase() }),
                    h('div', {}, h('strong', { text: user.username }), h('span', { text: user.email }))),
                h('div', { class: 'profile-details' },
                    h('div', {}, h('span', { text: 'ACCOUNT ROLE' }), h('strong', { text: user.role })),
                    h('div', {}, h('span', { text: 'ACCESS STATUS' }), h('strong', { class: 'active-status' }, h('i'), ' Active session')))),
            h('article', { class: 'security-card' },
                h('div', { class: 'security-badge', 'aria-hidden': 'true', text: '✓' }),
                h('div', {}, h('strong', { text: 'Your session is protected' }),
                    h('p', { text: 'Access tokens are kept in memory only and refreshed securely. Reloading the page signs you out; signing out revokes the session on the server.' })))));
}
