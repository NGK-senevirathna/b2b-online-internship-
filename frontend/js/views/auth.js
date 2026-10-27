'use strict';

import { api, session, describeError } from '../api.js';
import { notify, clearMessages, withBusy } from '../ui.js';

const el = {
    loginTab: () => document.querySelector('#login-tab'),
    registerTab: () => document.querySelector('#register-tab'),
    loginForm: () => document.querySelector('#login-panel'),
    registerForm: () => document.querySelector('#register-panel'),
    role: () => document.querySelector('#register-role'),
    keyField: () => document.querySelector('#provisioning-field'),
    key: () => document.querySelector('#provisioning-key')
};

/** Switches between the sign-in and create-account panels. */
export function showAuthView(view) {
    const login = view === 'login';
    el.loginTab().classList.toggle('is-selected', login);
    el.loginTab().setAttribute('aria-selected', String(login));
    el.registerTab().classList.toggle('is-selected', !login);
    el.registerTab().setAttribute('aria-selected', String(!login));
    el.loginTab().tabIndex = login ? 0 : -1;
    el.registerTab().tabIndex = login ? -1 : 0;
    el.loginForm().hidden = !login;
    el.registerForm().hidden = login;
    clearMessages();
}

async function signIn(identifier, password) {
    const result = await api('/auth/login', { method: 'POST', body: { identifier, password }, auth: false });
    session.set(result.data);
}

/**
 * Wires the existing sign-in and registration forms.
 * @param {() => void} onSignedIn Called after a successful sign-in.
 */
export function initAuth(onSignedIn) {
    el.loginTab().addEventListener('click', () => showAuthView('login'));
    el.registerTab().addEventListener('click', () => showAuthView('register'));
    // Arrow keys move between the two tabs, as users expect from a tab list.
    for (const tab of [el.loginTab(), el.registerTab()]) {
        tab.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const next = tab === el.loginTab() ? el.registerTab() : el.loginTab();
            next.click();
            next.focus();
        });
    }
    el.role().addEventListener('change', () => {
        const privileged = el.role().value !== 'Buyer';
        el.keyField().hidden = !privileged;
        el.key().required = privileged;
    });

    el.loginForm().addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(el.loginForm());
        await withBusy(el.loginForm().querySelector('[type="submit"]'), async () => {
            clearMessages();
            try {
                await signIn(String(data.get('identifier')), String(data.get('password')));
                el.loginForm().reset();
                onSignedIn();
            } catch (error) {
                notify(describeError(error).message, 'error');
            }
        });
    });

    el.registerForm().addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(el.registerForm());
        const role = String(data.get('role'));
        const headers = {};
        const key = String(data.get('provisioningKey') || '');
        if (role !== 'Buyer' && key) headers['X-Role-Provisioning-Key'] = key;
        await withBusy(el.registerForm().querySelector('[type="submit"]'), async () => {
            clearMessages();
            try {
                await api('/auth/register', {
                    method: 'POST', auth: false, headers,
                    body: { username: data.get('username'), email: data.get('email'), password: data.get('password'), role }
                });
                await signIn(String(data.get('email')), String(data.get('password')));
                el.key().value = '';
                el.registerForm().reset();
                el.keyField().hidden = true;
                onSignedIn();
            } catch (error) {
                notify(describeError(error).message, 'error');
            }
        });
    });
}
