'use strict';

/**
 * A tiny Express-compatible subset (routing, JSON body, static files) with no dependencies.
 * Used only by the contract mock so the UI can be tested where node_modules is unavailable.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function compile(pattern) {
    const names = [];
    const source = pattern.replace(/\/+$/, '').replace(/:([A-Za-z]+)/g, (_m, n) => { names.push(n); return '([^/]+)'; });
    return { regex: new RegExp(`^${source}/?$`), names };
}

class Router {
    constructor() { this.layers = []; }
    use(...args) {
        const prefix = typeof args[0] === 'string' ? args.shift() : '';
        for (const handler of args) this.layers.push({ prefix, handler, method: null });
        return this;
    }
    add(method, pattern, handlers) {
        const { regex, names } = compile(pattern);
        for (const handler of handlers) this.layers.push({ method, regex, names, handler });
        return this;
    }
    get(p, ...h) { return this.add('GET', p, h); }
    post(p, ...h) { return this.add('POST', p, h); }
    put(p, ...h) { return this.add('PUT', p, h); }
    patch(p, ...h) { return this.add('PATCH', p, h); }
    delete(p, ...h) { return this.add('DELETE', p, h); }

    handle(req, res, done) {
        const basePath = req.url_path;
        let index = 0;
        const next = (error) => {
            req.url_path = basePath;
            const layer = this.layers[index++];
            if (!layer) return done(error);
            try {
                if (layer.method) {
                    const match = layer.regex.exec(basePath);
                    if (!match || layer.method !== req.method) return next(error);
                    req.params = Object.fromEntries(layer.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
                    if (error) return next(error);
                    return layer.handler(req, res, next);
                }
                if (layer.prefix && !(basePath === layer.prefix || basePath.startsWith(`${layer.prefix}/`))) return next(error);
                const isRouter = layer.handler instanceof Router;
                const isErrorHandler = !isRouter && layer.handler.length === 4;
                if (isErrorHandler) return error ? layer.handler(error, req, res, next) : next();
                if (error) return next(error);
                if (isRouter) {
                    req.url_path = basePath.slice(layer.prefix.length) || '/';
                    return layer.handler.handle(req, res, (e) => { req.url_path = basePath; next(e); });
                }
                if (layer.prefix) req.url_path = basePath.slice(layer.prefix.length) || '/';
                return layer.handler(req, res, (e) => { req.url_path = basePath; next(e); });
            } catch (e) { return next(e); }
        };
        next();
    }
}

function express() {
    const app = new Router();
    app.listen = (port, cb) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://x');
            req.url_path = url.pathname; req.path = url.pathname; req.query = Object.fromEntries(url.searchParams);
            req.get = (name) => req.headers[name.toLowerCase()];
            res.status = (code) => { res.statusCode = code; return res; };
            res.json = (body) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); return res; };
            app.handle(req, res, (error) => {
                if (error) { res.statusCode = 500; return res.end('Internal error'); }
                res.statusCode = 404; return res.end('Not found');
            });
        });
        return server.listen(port, cb);
    };
    return app;
}
express.Router = () => new Router();
express.json = ({ limit = '10kb' } = {}) => {
    const max = Number.parseInt(limit, 10) * 1024;
    return (req, res, next) => {
        if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
        let size = 0; const chunks = [];
        req.on('data', (c) => { size += c.length; chunks.push(c); });
        req.on('end', () => {
            if (size > max) return next(Object.assign(new Error('Request body is too large.'), { status: 413 }));
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) { req.body = undefined; return next(); }
            try { req.body = JSON.parse(text); next(); } catch (_e) { next(Object.assign(new Error('Request body contains invalid JSON.'), { status: 400 })); }
        });
    };
};
express.static = (dir, { index = 'index.html' } = {}) => (req, res, next) => {
    if (req.method !== 'GET') return next();
    let target = path.join(dir, path.normalize(req.url_path).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(dir)) return next();
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, index);
    if (!fs.existsSync(target)) return next();
    res.setHeader('Content-Type', MIME[path.extname(target)] || 'application/octet-stream');
    return res.end(fs.readFileSync(target));
};
module.exports = express;
