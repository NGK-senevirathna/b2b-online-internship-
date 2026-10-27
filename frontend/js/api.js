'use strict';

/**
 * API client. Access and refresh tokens live in module memory only: nothing is
 * written to localStorage, sessionStorage, cookies or the URL.
 */

const BASE = '/api';

let accessToken = null;
let refreshToken = null;
let currentUser = null;
let refreshing = null;
let inFlight = 0;

const bus = new EventTarget();

export class ApiError extends Error {
    constructor({ status, message, code, details, requestId, retryAfter }) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
        this.requestId = requestId;
        this.retryAfter = retryAfter;
    }
}

export const session = {
    get user() { return currentUser; },
    get signedIn() { return Boolean(accessToken && currentUser); },
    on(type, handler) { bus.addEventListener(type, handler); },
    set(data) {
        accessToken = data.token;
        refreshToken = data.refreshToken;
        currentUser = data.user;
    },
    clear() {
        accessToken = null;
        refreshToken = null;
        currentUser = null;
    }
};

function trackBusy(delta) {
    inFlight += delta;
    bus.dispatchEvent(new CustomEvent('busy', { detail: inFlight > 0 }));
}

function buildUrl(path, query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
        if (value === undefined || value === null || value === '' || value === false) continue;
        params.set(key, String(value));
    }
    const text = params.toString();
    return `${BASE}${path}${text ? `?${text}` : ''}`;
}

async function send(path, { method = 'GET', body, query, headers = {}, auth = true } = {}) {
    const init = { method, headers: { Accept: 'application/json', ...headers }, credentials: 'same-origin' };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    if (auth && accessToken) init.headers.Authorization = `Bearer ${accessToken}`;
    let response;
    try {
        response = await fetch(buildUrl(path, query), init);
    } catch (_error) {
        throw new ApiError({ status: 0, message: 'Cannot reach the server. Check your connection and try again.' });
    }
    const payload = await response.json().catch(() => ({}));
    const requestId = response.headers.get('x-request-id') || undefined;
    if (!response.ok || payload.success === false) {
        throw new ApiError({
            status: response.status,
            message: payload.error || `Request failed (${response.status}).`,
            code: payload.code,
            details: payload.details,
            requestId,
            retryAfter: Number(response.headers.get('retry-after')) || undefined
        });
    }
    return { status: response.status, message: payload.message, data: payload.data, requestId };
}

async function refreshTokens() {
    if (!refreshToken) throw new ApiError({ status: 401, message: 'Your session has expired. Please sign in again.' });
    // One refresh at a time: refresh tokens are single-use, so parallel calls must share it.
    refreshing ??= send('/auth/refresh', { method: 'POST', body: { refreshToken }, auth: false })
        .then((result) => { session.set(result.data); })
        .finally(() => { refreshing = null; });
    return refreshing;
}

/**
 * Calls the API, refreshing the access token once if it has expired.
 * @param {string} path Path under /api, for example "/products".
 * @param {object} [options] method, body, query, headers, auth.
 * @returns {Promise<{status:number,message:string,data:any,requestId?:string}>} Parsed success payload.
 * @throws {ApiError} On any failure.
 */
export async function api(path, options = {}) {
    trackBusy(1);
    try {
        try {
            return await send(path, options);
        } catch (error) {
            const canRetry = error.status === 401 && options.auth !== false && refreshToken;
            if (!canRetry) throw error;
            try {
                await refreshTokens();
            } catch (_refreshError) {
                session.clear();
                bus.dispatchEvent(new Event('expired'));
                throw new ApiError({ status: 401, message: 'Your session has expired. Please sign in again.' });
            }
            return await send(path, options);
        }
    } finally {
        trackBusy(-1);
    }
}

/**
 * Turns an API error into short, plain-language text for the user.
 * @param {unknown} error Caught error.
 * @returns {{message: string, lines: string[]}} Headline plus optional detail lines.
 */
export function describeError(error) {
    if (!(error instanceof ApiError)) return { message: 'Something unexpected went wrong. Please try again.', lines: [] };
    const lines = [];
    switch (error.status) {
    case 0:
        return { message: error.message, lines };
    case 401:
        return { message: error.message || 'Please sign in again.', lines };
    case 403:
        return { message: 'You do not have permission to do that. Ask an administrator if you need access.', lines };
    case 429: {
        const wait = error.retryAfter ? ` Try again in about ${Math.max(1, Math.ceil(error.retryAfter / 60))} minute(s).` : ' Please wait a few minutes and try again.';
        return { message: `Too many requests.${wait}`, lines };
    }
    case 409:
        return describeConflict(error);
    default:
        if (error.status >= 500) {
            const ref = error.requestId ? ` (reference ${error.requestId})` : '';
            return { message: `The server had a problem. Please try again shortly${ref}.`, lines };
        }
        return { message: error.message, lines };
    }
}

function describeConflict(error) {
    const lines = [];
    const details = error.details || {};
    if (error.code === 'CART_ITEMS_UNAVAILABLE' && Array.isArray(details.items)) {
        for (const item of details.items) {
            lines.push(item.reason === 'unavailable'
                ? `${item.name}: no longer available.`
                : `${item.name}: you asked for ${item.requested}, only ${item.available} in stock.`);
        }
        return { message: 'Stock changed. Some items in your cart cannot be ordered as they are.', lines };
    }
    if (error.code === 'INSUFFICIENT_STOCK') {
        return { message: `Not enough stock. Only ${details.available ?? 0} unit(s) available.`, lines };
    }
    if (error.code === 'STOCK_CHANGED') {
        return { message: 'Stock changed while ordering. Review your cart and try again.', lines };
    }
    if (error.code === 'STOCK_BELOW_ZERO') {
        return { message: `Stock cannot go below zero (currently ${details.available ?? 0}).`, lines };
    }
    return { message: error.message, lines };
}
