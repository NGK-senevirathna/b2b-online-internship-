# B2B Order Management Platform

Multi-role ordering system for a simulated distributor: product catalogue, stock control, carts, orders, invoices, administration and an append-only audit trail. Node.js + Express, PostgreSQL, JWT, Docker.

> **Status:** Section 1 (backend, database, security, tests) and Section 2 (web UI, browser tests, written deliverables) are complete. Open **http://localhost:5000/app/** after starting the server.

## Roles

| Role | Can do |
| --- | --- |
| **Buyer** | Browse the catalogue, manage a cart, place and cancel (while pending) orders, view own orders and invoices |
| **Seller** | Create and edit own products, adjust stock, archive products, see orders that contain their products (their lines only, no delivery address) |
| **Admin** | See all orders, manage any product and its stock, move orders through the workflow, mark invoices paid, manage users (role, deactivate), read the audit log and dashboard summary |

## Quick start

```bash
npm ci
cp .env.example .env        # then replace every value marked CHANGE
docker compose up -d postgres
npm run db:migrate
npm run db:seed             # optional demo data: demo.admin / demo.seller / demo.buyer
npm start                   # http://localhost:5000
```

`npm run db:seed` prints a random password once (or uses `SEED_PASSWORD`). It refuses to run when `NODE_ENV=production`.

Full stack in Docker: `docker compose up --build -d`, then `curl --fail http://localhost:5000/health/ready`.

## Web UI

Plain HTML, CSS and JavaScript (ES modules) in `frontend/`, served by the same Express server at `/app/`. No framework, no build step, no inline scripts or styles (the strict CSP would block them), relative `/api` paths, tokens kept in memory only (a page reload signs you out), and every value is rendered with `textContent`, never `innerHTML`.

| Role | Screens |
| --- | --- |
| Everyone | Sign in / create account, My account |
| **Buyer** | Catalogue (search, sort, in-stock filter, pagination), Cart (quantity edit, stock warnings, totals), Checkout (shipping address + Idempotency-Key), My orders, Order detail (progress, cancel while pending), printable Invoice |
| **Seller** | My products (search, status and low-stock filters), New/Edit product, Archive/Restore, Stock adjustment with note + stock history, Orders containing my products (own lines only) |
| **Admin** | Dashboard cards, All orders (status filter, workflow buttons, mark invoice paid), All products, Users (role change, activate/deactivate), Audit log (filters) |

Failures are explained in plain language (validation, 403, 404, 409 stock conflicts, 429, server errors, offline) and there is a loading indicator. The UI works on a 390 px phone (tables become cards) and fully from the keyboard (skip link, focus moves to the page title, dialogs close with Escape).

```text
frontend/
  index.html  styles.css  app.js        shell, router, navigation
  js/api.js dom.js format.js ui.js cart-store.js
  js/views/auth.js account.js buyer.js orders.js seller.js admin.js
```

Screenshots of every screen are in `docs/screenshots/`.

## Architecture

```text
routes/        URL -> controller, role guards
controllers/   HTTP only: validate input, call a service, shape the response
services/      Business rules and transactions (checkout, cancel, stock, user admin, audit)
models/        SQL only, always parameterized
middleware/    auth, roles, rate limits, request id, error handling
utils/         validation, errors, money
migrations/    001 auth, 002 commerce schema
```

Key design decisions:

- **Money is integer cents** (`bigint`); tax uses BigInt basis points, so there is no floating-point error.
- **Checkout is one transaction:** lock the buyer's cart, replay an earlier order for the same `Idempotency-Key`, lock products in id order (no deadlocks), check stock, decrement stock, write order lines, invoice, audit record, clear the cart. Any failure rolls everything back.
- **Order lines snapshot** name, SKU and price, so later catalogue edits never change history.
- **Stock changes are ledgered** in `stock_movements`; stock can never go below zero (also enforced by a database CHECK).
- **Audit entries are written inside the business transaction** and the table rejects UPDATE, DELETE and TRUNCATE.
- **Order workflow:** `pending -> confirmed -> shipped -> delivered`; `pending/confirmed -> cancelled` (restores stock, voids the invoice). Shipped and delivered orders are final.

## API summary

All routes except health and `/api/auth/register|login|refresh` need `Authorization: Bearer <token>`. Success: `{ "success": true, "message", "data" }`. Failure: `{ "success": false, "error", "statusCode", "code"?, "details"? }`. List endpoints accept `page` and `limit` (max 100).

| Method and path | Roles | Purpose |
| --- | --- | --- |
| `POST /api/auth/register`, `login`, `refresh`, `logout`; `GET /api/auth/me` | public / any | Accounts and sessions (see section below) |
| `GET /api/products?q=&sort=&inStock=` | any | Catalogue (active products) |
| `GET /api/products/:id` | any | One product |
| `GET /api/seller/products?status=&lowStock=` | Seller, Admin | Managed products incl. archived |
| `POST /api/seller/products` | Seller | Create (`sku`, `name`, `description`, `priceCents`, `stockQuantity`) |
| `PATCH /api/seller/products/:id` | owner, Admin | Edit `name`, `description`, `priceCents`, `status` |
| `DELETE /api/seller/products/:id` | owner, Admin | Archive (soft delete) |
| `POST /api/seller/products/:id/stock` | owner, Admin | Adjust stock (`delta`, `note`) |
| `GET /api/seller/products/:id/stock-history` | owner, Admin | Stock ledger |
| `GET /api/cart`, `DELETE /api/cart` | Buyer | View or clear cart |
| `PUT /api/cart/items/:productId` | Buyer | Set quantity (`quantity`) |
| `DELETE /api/cart/items/:productId` | Buyer | Remove line |
| `POST /api/orders` | Buyer | Checkout (`shippingAddress`; optional `Idempotency-Key` header) |
| `GET /api/orders?status=` | any | Orders visible to the caller |
| `GET /api/orders/:id` | owner / seller with lines / Admin | One order |
| `POST /api/orders/:id/cancel` | Buyer | Cancel own pending order |
| `GET /api/orders/:id/invoice` | Buyer (own), Admin | Invoice data |
| `PATCH /api/admin/orders/:id/status` | Admin | Workflow transition (`status`) |
| `POST /api/admin/orders/:id/invoice/pay` | Admin | Mark invoice paid |
| `GET /api/admin/summary` | Admin | Dashboard figures |
| `GET /api/admin/users?q=&role=`, `PATCH /api/admin/users/:id` | Admin | List users; change `role` / `isActive` |
| `GET /api/admin/audit-logs?action=&entityType=&entityId=&actorId=` | Admin | Audit trail |

Auth details: bcrypt (12 rounds), HS256 access JWT (1 h), rotating single-use refresh tokens with replay detection, immediate revocation on logout and when an account is deactivated, Seller/Admin registration only with `X-Role-Provisioning-Key`.

## Security controls

| Threat | Control |
| --- | --- |
| SQL injection | Parameterized queries only; sort fields are an allow-list; LIKE wildcards escaped |
| Broken access control / IDOR | Role guards on every route; ownership checked in services; other users' orders and products return 404 |
| Mass assignment | Request bodies accept only listed fields; unknown fields are rejected with 400 |
| Brute force | Failed sign-ins limited per IP (default 10 / 15 min), sign-ups limited, general API limit; counters shared via PostgreSQL |
| User enumeration by timing | Password hash is compared even when the account does not exist |
| Overselling / double submit | Row locks, cart lock, idempotency keys, database CHECK constraints |
| XSS / clickjacking | Strict CSP (`script-src 'self'`, `frame-ancestors 'none'`), no inline scripts, tokens kept in memory only |
| Data exposure | `Cache-Control: no-store` on the API, generic 500 messages, request ids for log correlation, passwords never logged or audited |
| Tampering with history | Append-only audit table (trigger-enforced) and stock ledger |
| Container hardening | Non-root user, read-only filesystem, all capabilities dropped, database published on loopback only |
| Dependencies | `npm audit` clean (0 vulnerabilities) |

## Configuration

See `.env.example` (all variables documented). Business settings: `TAX_RATE_BPS`, `LOW_STOCK_THRESHOLD`. Production requires explicit `CORS_ORIGIN`, strong `JWT_SECRET` and `ROLE_PROVISIONING_KEY`. Run `npm run db:migrate` before starting a new version.

## Tests

```bash
npm test                  # 18 tests, no database needed
npm run test:db           # 40 tests against a DISPOSABLE PostgreSQL (set DATABASE_URL)

# Browser end-to-end test of the UI (Buyer + Seller + Admin), needs the app running on real PostgreSQL:
npm install --no-save playwright && npx playwright install chromium
BASE_URL=http://localhost:5000 ROLE_PROVISIONING_KEY=<value from .env> npm run e2e
```

`npm run e2e` registers its own throw-away users, drives the real screens, saves screenshots to `docs/screenshots/` and writes `docs/screenshots/e2e-report.txt`. Set `E2E_TEST_429=1` only if you accept being rate-limited for about 15 minutes. The `e2e/mock-api-server.js` file is a database-free stand-in used only to test the UI where no PostgreSQL is available; it is **not** evidence about the backend.

Results and what they prove: `docs/TEST_EVIDENCE.md`.

## Documentation

| File | Contents |
| --- | --- |
| `docs/REQUIREMENTS.md` | Stakeholders, scope, success metrics, acceptance criteria mapped to evidence |
| `docs/API.md` | Every endpoint, response shape, error codes |
| `docs/SECURITY.md` | Threat model, controls, residual risks |
| `docs/TEST_EVIDENCE.md` | Test results and screenshots index |
| `docs/DEMO_AND_VIVA.md` | 10-minute demo script, viva answers, 10x-load plan |
| `docs/WORKLOG.md` | Template for your own dated work log |

## Known limitations and next steps

- Single currency (USD display); no payment gateway, refunds or shipping carriers.
- One order can span several sellers, but fulfilment is done by the Admin, not per seller.
- Browser tokens are held in memory only, so a page reload requires signing in again; a backend-for-frontend with HttpOnly cookies would improve this.
- The UI has no automatic accessibility audit (axe) yet; keyboard and mobile behaviour are covered by `npm run e2e`.
- No email notifications, password reset or multi-factor authentication.
- For 10x load: add Redis for rate limiting, read replicas for reporting queries and an index review under real data.
