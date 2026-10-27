# API reference

Base path `/api`. JSON in, JSON out. The web UI uses relative paths, so it works on any host.

## Conventions

- **Auth:** `Authorization: Bearer <access token>` on everything except `POST /auth/register|login|refresh`.
- **Success:** `{ "success": true, "message": "...", "data": { ... } }`
- **Failure:** `{ "success": false, "error": "text", "statusCode": 409, "code": "OPTIONAL_CODE", "details": { } }`
- **Money:** integer cents (`priceCents`, `totalCents`). **Dates:** ISO 8601 UTC.
- **Lists:** `?page=1&limit=20` (limit max 100; audit max 200). Response includes `pagination: { page, limit, total, totalPages }`.
- **Unknown request fields are rejected with 400.** Responses carry `X-Request-Id` and `Cache-Control: no-store`.

## Status codes the UI handles

| Code | Meaning | What the user sees |
| --- | --- | --- |
| 400 | Validation | The server's message, next to the form |
| 401 | Missing/expired token | Silent refresh once; otherwise "session expired", back to sign-in |
| 403 | Wrong role | "You do not have permission to do that." |
| 404 | Not found, or not yours (no information leak) | Not-found message |
| 409 | Conflict (see codes below) | Specific message and, for carts, one line per product |
| 413 / 429 | Too large / rate limited | "Too many requests. Please wait…" |
| 5xx | Server problem | Generic message with the request id |

Conflict `code` values: `INSUFFICIENT_STOCK`, `CART_FULL`, `CART_EMPTY`, `CART_ITEMS_UNAVAILABLE` (`details.items[]` with `reason`, `requested`, `available`), `STOCK_CHANGED`, `STOCK_BELOW_ZERO`, `INVALID_TRANSITION`, `INVOICE_NOT_PAYABLE`, `SELF_LOCKOUT`, `LAST_ADMIN`.

## Authentication

| Method and path | Body | Notes |
| --- | --- | --- |
| `POST /auth/register` | `username` (3-30), `email`, `password` (8-72 bytes), `role` | Seller/Admin need header `X-Role-Provisioning-Key`. 201 |
| `POST /auth/login` | `identifier` (username or email), `password` | Returns `token`, `refreshToken`, `user`. Failed attempts are rate limited |
| `POST /auth/refresh` | `refreshToken` | Rotates; reuse of an old token revokes the session |
| `POST /auth/logout` | none | Revokes the session |
| `GET /auth/me` | none | Current user |

## Catalogue and seller tools

| Method and path | Roles | Notes |
| --- | --- | --- |
| `GET /products?q=&sort=&inStock=&page=&limit=` | any | `sort`: `name`, `newest`, `price_asc`, `price_desc`. Product has `stockStatus`: `in_stock`, `low_stock`, `out_of_stock` |
| `GET /products/:id` | any | Archived products only for owner/Admin |
| `GET /seller/products?status=&lowStock=&q=&sort=` | Seller (own), Admin (all) | Includes archived |
| `POST /seller/products` | Seller | `sku`, `name`, `description?`, `priceCents`, `stockQuantity?` |
| `PATCH /seller/products/:id` | owner, Admin | `name`, `description`, `priceCents`, `status` |
| `DELETE /seller/products/:id` | owner, Admin | Archive (soft delete) |
| `POST /seller/products/:id/stock` | owner, Admin | `delta` (non-zero integer), `note` (3-200). 409 `STOCK_BELOW_ZERO` |
| `GET /seller/products/:id/stock-history` | owner, Admin | Last 50 movements |

## Cart and orders

| Method and path | Roles | Notes |
| --- | --- | --- |
| `GET /cart`, `DELETE /cart` | Buyer | Cart: `items[]` (with `issue`: `null`, `unavailable`, `insufficient_stock`), `subtotalCents`, `taxCents`, `totalCents`, `canCheckout` |
| `PUT /cart/items/:productId` | Buyer | `{ "quantity": n }` sets (not adds) the quantity. 409 `INSUFFICIENT_STOCK` |
| `DELETE /cart/items/:productId` | Buyer | |
| `POST /orders` | Buyer | `{ "shippingAddress": "10-500 chars" }`, header `Idempotency-Key: 8-64 chars`. 201 new, 200 replay (`data.replayed: true`) |
| `GET /orders?status=` | any | Buyer: own. Seller: orders with their lines (`items` limited to them, `sellerSubtotalCents`). Admin: all |
| `GET /orders/:id` | owner / seller with lines / Admin | Others get 404 |
| `POST /orders/:id/cancel` | Buyer | Own **pending** order only |
| `GET /orders/:id/invoice` | Buyer (own), Admin | Seller gets 403 |

Order workflow: `pending → confirmed → shipped → delivered`; `pending|confirmed → cancelled`. Shipped and delivered are final.

## Administration

| Method and path | Notes |
| --- | --- |
| `PATCH /admin/orders/:id/status` | `{ "status": "confirmed" }` |
| `POST /admin/orders/:id/invoice/pay` | Once; not after cancellation |
| `GET /admin/summary` | `ordersByStatus`, `orderedCents`, `paidCents`, `outstandingCents`, `activeProducts`, `lowStockProducts`, `outOfStockProducts`, `usersByRole` |
| `GET /admin/users?q=&role=` | |
| `PATCH /admin/users/:id` | `role` and/or `isActive` (deactivating revokes sessions) |
| `GET /admin/audit-logs?action=&entityType=&entityId=&actorId=` | `entityType`: `auth`, `user`, `product`, `order`, `invoice`. Entries: `action`, `entityType`, `entityId`, `actorUsername`, `actorRole`, `details`, `ipAddress`, `createdAt` |

Audit `action` values seen in the code: `auth.login`, `auth.login_failed`, `auth.login_blocked`, `auth.logout`, `auth.refresh_reuse_detected`, `user.register`, `user.update`, `product.create`, `product.update`, `product.archive`, `stock.adjust`, `order.create`, `order.status`, `order.cancel`, `invoice.paid`.

## Health

`GET /health/live` (process up), `GET /health/ready` (database reachable). The UI itself is served at `/app/`.
