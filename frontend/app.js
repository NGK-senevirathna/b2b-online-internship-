'use strict';

const API_BASE = `${window.location.origin}/api/auth`;

const state = {
    accessToken: null,
    refreshToken: null,
    user: null,
    panel: null,
    busy: false
};

const elements = {
    notice: document.querySelector('#notice'),
    authView: document.querySelector('#auth-view'),
    dashboardView: document.querySelector('#dashboard-view'),
    loginTab: document.querySelector('#login-tab'),
    registerTab: document.querySelector('#register-tab'),
    loginForm: document.querySelector('#login-panel'),
    registerForm: document.querySelector('#register-panel'),
    roleSelect: document.querySelector('#register-role'),
    provisioningField: document.querySelector('#provisioning-field'),
    provisioningKey: document.querySelector('#provisioning-key'),
    topbarSession: document.querySelector('#topbar-session'),
    topbarUsername: document.querySelector('#topbar-username'),
    pageTitle: document.querySelector('#page-title'),
    pageSubtitle: document.querySelector('#page-subtitle'),
    welcomeTitle: document.querySelector('#welcome-title'),
    welcomeMessage: document.querySelector('#welcome-message'),
    profileAvatar: document.querySelector('#profile-avatar'),
    profileName: document.querySelector('#profile-name'),
    profileEmail: document.querySelector('#profile-email'),
    profileRole: document.querySelector('#profile-role'),
    roleCardTitle: document.querySelector('#role-card-title'),
    roleCardDescription: document.querySelector('#role-card-description'),
    roleAction: document.querySelector('#role-action'),
    roleResult: document.querySelector('#role-result'),
    roleResultTitle: document.querySelector('#role-result-title'),
    roleResultCopy: document.querySelector('#role-result-copy'),
    logoutButton: document.querySelector('#logout-button')
};

/**
 * Sends a JSON request to the authentication API and normalizes API errors.
 * @param {string} path Auth route path.
 * @param {RequestInit} [options] Fetch options.
 * @param {boolean} [allowRefresh] Whether to refresh an expired access token once.
 * @returns {Promise<object>} Parsed API response.
 * @throws {Error} If the request fails or the API returns a failure response.
 */
async function apiRequest(path, options = {}, allowRefresh = true) {
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    if (state.accessToken) headers.set('Authorization', `Bearer ${state.accessToken}`);

    let response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers,
            body: options.body === undefined ? undefined : options.body
        });
    } catch (_error) {
        throw new Error('Could not reach the authentication service. Check that the API is running.');
    }

    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && allowRefresh && state.refreshToken && path !== '/refresh') {
        await refreshSession();
        return apiRequest(path, options, false);
    }
    if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `Request failed with status ${response.status}.`);
    }
    return payload;
}

/**
 * Switches the authentication card between sign-in and registration.
 * @param {'login'|'register'} view Selected view.
 * @returns {void} Updates tab and form visibility.
 */
function showAuthView(view) {
    const showLogin = view === 'login';
    elements.loginTab.classList.toggle('is-selected', showLogin);
    elements.loginTab.setAttribute('aria-selected', String(showLogin));
    elements.registerTab.classList.toggle('is-selected', !showLogin);
    elements.registerTab.setAttribute('aria-selected', String(!showLogin));
    elements.loginForm.hidden = !showLogin;
    elements.registerForm.hidden = showLogin;
    clearNotice();
}

/**
 * Displays a visible status or error message without interpreting HTML.
 * @param {string} message Message content.
 * @param {'error'|'success'|'info'} [kind] Visual state.
 * @returns {void} Updates the accessible status region.
 */
function showNotice(message, kind = 'error') {
    elements.notice.textContent = message;
    elements.notice.className = `notice${kind === 'success' ? ' is-success' : kind === 'info' ? ' is-info' : ''}`;
    elements.notice.hidden = false;
}

/**
 * Hides and clears the status region.
 * @returns {void} Resets the status element.
 */
function clearNotice() {
    elements.notice.textContent = '';
    elements.notice.hidden = true;
    elements.notice.className = 'notice';
}

/**
 * Disables submit controls during an in-flight request.
 * @param {HTMLFormElement} form Form being submitted.
 * @param {boolean} busy Whether the request is running.
 * @returns {void} Updates the submit button.
 */
function setFormBusy(form, busy) {
    state.busy = busy;
    const button = form.querySelector('[type="submit"]');
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
}

/**
 * Logs in and stores access and refresh tokens only in page memory.
 * @param {SubmitEvent} event Form submission event.
 * @returns {Promise<void>} Resolves after displaying the account workspace.
 */
async function handleLogin(event) {
    event.preventDefault();
    if (state.busy) return;
    const form = new FormData(elements.loginForm);
    setFormBusy(elements.loginForm, true);
    clearNotice();

    try {
        const result = await apiRequest('/login', {
            method: 'POST',
            body: JSON.stringify({
                identifier: form.get('identifier'),
                password: form.get('password')
            })
        }, false);
        state.accessToken = result.data.token;
        state.refreshToken = result.data.refreshToken;
        state.user = result.data.user;
        renderDashboard();
        showNotice('You are signed in. Your session tokens are held in memory only.', 'success');
    } catch (error) {
        showNotice(error.message);
    } finally {
        setFormBusy(elements.loginForm, false);
    }
}

/**
 * Registers an account, then signs the user in using the new credentials.
 * @param {SubmitEvent} event Form submission event.
 * @returns {Promise<void>} Resolves after registration or error feedback.
 */
async function handleRegister(event) {
    event.preventDefault();
    if (state.busy) return;
    const form = new FormData(elements.registerForm);
    const role = String(form.get('role'));
    const headers = new Headers();
    const provisioningKey = String(form.get('provisioningKey') || '');

    if (role !== 'Buyer' && provisioningKey) {
        headers.set('X-Role-Provisioning-Key', provisioningKey);
    }

    setFormBusy(elements.registerForm, true);
    clearNotice();
    try {
        await apiRequest('/register', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                username: form.get('username'),
                email: form.get('email'),
                password: form.get('password'),
                role
            })
        }, false);

        elements.provisioningKey.value = '';
        showNotice('Account created. Signing you in…', 'success');
        const login = await apiRequest('/login', {
            method: 'POST',
            body: JSON.stringify({
                identifier: form.get('email'),
                password: form.get('password')
            })
        }, false);
        state.accessToken = login.data.token;
        state.refreshToken = login.data.refreshToken;
        state.user = login.data.user;
        renderDashboard();
        showNotice('Your account is ready.', 'success');
    } catch (error) {
        showNotice(error.message);
    } finally {
        setFormBusy(elements.registerForm, false);
    }
}

/**
 * Rotates the current refresh token and replaces the in-memory token pair.
 * @returns {Promise<void>} Resolves when tokens are replaced.
 * @throws {Error} If the session has expired or been revoked.
 */
async function refreshSession() {
    if (!state.refreshToken) throw new Error('Your session has expired. Please sign in again.');
    const result = await apiRequest('/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: state.refreshToken })
    }, false);
    state.accessToken = result.data.token;
    state.refreshToken = result.data.refreshToken;
    state.user = result.data.user;
}

/**
 * Requests a profile and displays the workspace allowed by the user's role.
 * @returns {Promise<void>} Resolves after updating dashboard state.
 */
async function openRoleWorkspace() {
    const role = state.user?.role;
    if (role !== 'Seller' && role !== 'Admin') return;

    elements.roleAction.disabled = true;
    elements.roleResult.hidden = true;
    try {
        const endpoint = role === 'Admin' ? '/admin-dashboard' : '/seller-panel';
        const result = await apiRequest(endpoint);
        state.panel = role;
        elements.roleResultTitle.textContent = 'Access granted';
        elements.roleResultCopy.textContent = result.message;
        elements.roleResult.hidden = false;
    } catch (error) {
        showNotice(error.message);
    } finally {
        elements.roleAction.disabled = false;
    }
}

/**
 * Revokes the current server session and clears local in-memory credentials.
 * @returns {Promise<void>} Resolves after sign-out.
 */
async function logout() {
    const token = state.accessToken;
    try {
        if (token) {
            await apiRequest('/logout', { method: 'POST' });
        }
        showNotice('You have signed out successfully.', 'success');
    } catch (error) {
        showNotice(`${error.message} Local session data was cleared.`, 'info');
    } finally {
        state.accessToken = null;
        state.refreshToken = null;
        state.user = null;
        state.panel = null;
        elements.topbarSession.hidden = true;
        elements.dashboardView.hidden = true;
        elements.authView.hidden = false;
        elements.pageTitle.textContent = 'Your business, connected.';
        elements.pageSubtitle.textContent = 'Sign in to securely access your organization\'s workspace.';
        showAuthView('login');
    }
}

/**
 * Renders account information and role-specific available actions.
 * @returns {void} Displays the authenticated dashboard.
 */
function renderDashboard() {
    const user = state.user;
    const role = user.role;
    const hasSellerAccess = role === 'Seller' || role === 'Admin';
    elements.authView.hidden = true;
    elements.dashboardView.hidden = false;
    elements.topbarSession.hidden = false;
    elements.topbarUsername.textContent = user.username;
    elements.welcomeTitle.textContent = `Welcome, ${user.username}`;
    elements.welcomeMessage.textContent = `${role} access is active for your account.`;
    elements.profileAvatar.textContent = (user.username[0] || 'U').toUpperCase();
    elements.profileName.textContent = user.username;
    elements.profileEmail.textContent = user.email;
    elements.profileRole.textContent = role;
    elements.roleCardTitle.textContent = hasSellerAccess
        ? role === 'Admin' ? 'Administration center' : 'Seller workspace'
        : 'Buyer account';
    elements.roleCardDescription.textContent = hasSellerAccess
        ? role === 'Admin'
            ? 'Your Admin role can access seller tools and the protected administration dashboard.'
            : 'Your Seller role can access the seller panel. Your account is verified and ready to work.'
        : 'Your Buyer account is active. Seller and Admin areas require an assigned, provisioned role.';
    elements.roleAction.hidden = !hasSellerAccess;
    elements.roleAction.textContent = role === 'Admin' ? 'Open admin dashboard →' : 'Open seller panel →';
    elements.roleResult.hidden = true;
    elements.pageTitle.textContent = 'Your workspace, connected.';
    elements.pageSubtitle.textContent = 'A clear view of your account and the tools available to your role.';
}

/**
 * Updates role provisioning UI based on the selected registration role.
 * @returns {void} Shows the key input only for privileged roles.
 */
function updateProvisioningField() {
    const privilegedRole = elements.roleSelect.value !== 'Buyer';
    elements.provisioningField.hidden = !privilegedRole;
    elements.provisioningKey.required = privilegedRole;
}

elements.loginTab.addEventListener('click', () => showAuthView('login'));
elements.registerTab.addEventListener('click', () => showAuthView('register'));
elements.loginForm.addEventListener('submit', handleLogin);
elements.registerForm.addEventListener('submit', handleRegister);
elements.roleSelect.addEventListener('change', updateProvisioningField);
elements.roleAction.addEventListener('click', openRoleWorkspace);
elements.logoutButton.addEventListener('click', logout);
