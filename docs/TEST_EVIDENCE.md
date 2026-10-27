# Test evidence

## Section 1: backend

Captured 2026-10-26 in a Linux container. Node v22.23.4, PostgreSQL 16.15, real database (no mocks) for the database suites.

| Suite | Command | Result |
| --- | --- | --- |
| Unit and HTTP (no database) | `npm test` | 18 passed, 0 failed |
| PostgreSQL integration | `npm run test:db` | 40 passed, 0 failed, 0 skipped |
| Dependency audit | `npm audit --omit=dev` | 0 vulnerabilities |

## What the database suites prove

- **No overselling:** three buyers race for the last two units, exactly two orders succeed (the row lock is held open so the race is deterministic).
- **No double orders:** three parallel submits of one cart create exactly one order. Removing the cart lock makes this test fail (3 orders), so the test is effective.
- **Idempotency:** a retried checkout with the same `Idempotency-Key` returns the same order and decrements stock once.
- **Access control:** buyers cannot read or cancel each other's orders (404), sellers see only their own lines and never the delivery address, only Admins move orders through the workflow.
- **Audit trail:** order, stock, product, user and auth events are recorded; updates, deletes and truncation of `audit_logs` are rejected by the database.
- **Abuse protection:** failed sign-ins are rate limited (3 failures, then 429), SQL-injection strings are inert, unknown request fields are rejected, security headers and request ids are present.

## Real defect found by the tests

Tax was first computed as `subtotal * rate` in floating point. For the largest permitted order that product exceeds `Number.MAX_SAFE_INTEGER`. It now uses BigInt and is covered by `test/validation.test.js`.

## Test names (database suites)

```
ok 1 - seller creates a product, stock and movement are recorded
ok 2 - rejects invalid and malicious input
ok 3 - duplicate SKUs are rejected per seller but allowed across sellers
ok 4 - role and ownership rules are enforced
ok 5 - stock adjustments cannot go below zero and are audited
ok 6 - catalogue hides archived products from buyers, supports search and bounds pagination
ok 1 - catalogue and seller product management
ok 1 - cart enforces stock, ownership of role and computes totals with tax
ok 2 - checkout creates order, invoice and audit record, decrements stock and clears the cart
ok 3 - an empty cart cannot be checked out
ok 4 - Idempotency-Key makes retries safe
ok 5 - items that became unavailable block checkout with details
ok 2 - cart, checkout, invoices and stock integrity
ok 1 - three buyers race for the last two units: exactly two succeed
ok 2 - double-submitting one cart in parallel creates a single order
ok 3 - the database itself refuses negative stock
ok 3 - concurrent checkouts never oversell
ok 1 - buyers see only their own orders (no IDOR)
ok 2 - sellers see only orders containing their products, limited to their lines
ok 3 - buyer cancels a pending order: stock restored and invoice voided
ok 4 - only an Admin can progress an order, and only along the allowed workflow
ok 5 - invoices can be paid once, and not after cancellation
ok 6 - status filter and dashboard summary reflect the data
ok 4 - order access control, lifecycle and invoices
ok 1 - admin can list and search users
ok 2 - deactivating a user ends their sessions and blocks sign-in
ok 3 - role changes take effect immediately and unsafe changes are refused
ok 4 - audit log records security and business events and filters them
ok 5 - audit records cannot be altered or deleted, even with database access
ok 5 - administration, audit trail and account safety
ok 1 - security headers, request ids and no-store are present
ok 2 - errors never leak internals
ok 3 - SQL injection attempts in credentials are handled as plain text
ok 4 - privilege escalation through registration is blocked
ok 5 - repeated failed sign-ins are rate limited, successful ones are not counted
ok 6 - transport and abuse protections
ok 1 - looks up normalized identities and rejects duplicates
ok 2 - rotates once and revokes the session when the old token is reused
ok 3 - uses atomic PostgreSQL rate-limit counters
ok 7 - PostgreSQL persists unique users, rotates refresh tokens, and shares rate-limit counters
```

## Section 2: web UI

### What was run, and where (read this first)

| Run | Target | Result | Status |
| --- | --- | --- | --- |
| `npm run e2e` against the **contract mock** (`e2e/mock-api-server.js`, in memory, no PostgreSQL) | Same frontend files, same CSP header, API contract copied from the controllers | **29 / 29 steps passed**, 37 screenshots (`docs/screenshots/e2e-report.txt`) | Done in the authoring sandbox. It proves the **UI logic**, not the backend |
| `npm run e2e` against the **real server + PostgreSQL** | `docker compose up` stack | _paste the final line of the output here_ | **To do on your PC** |
| `npm test` and `npm run test:db` after the UI changes | Backend | _paste results_ | **To do on your PC.** Section 1 results above were captured earlier and the backend code was not changed |

The authoring sandbox had no PostgreSQL, no Docker and no network, so the backend suites could not be re-run there. Regenerate the screenshots on your PC after the real run so the evidence shows real data.

### What the browser test checks (29 steps)

Sign-in page and no stored tokens; wrong-password error; registering Admin, Seller and Buyer; wrong provisioning key refused; Seller product form validation, create, low-stock filter, edit, archive/restore with confirmation, stock adjustment with note and history; Buyer catalogue search, sort, pagination, hostile product names shown as text; add to cart, stock conflict message, quantity edit; cart warning after stock drops; checkout validation, `Idempotency-Key` header, double-click creates one order; cancel restores stock; printable invoice; checkout 409 with product lines; Seller sees own lines only and no address; Admin dashboard, workflow, mark paid, user role change and deactivation, own row locked, audit filters, all products; server 403 message; no-access page; offline message with retry; silent token refresh (mock only); keyboard-only sign-in and dialog Escape; mobile layout without sideways scroll; tokens never in storage and reload signs out; 429 message (mock run); zero script errors and zero CSP violations.

### Defects found by the UI test and fixed (frontend only, backend untouched)

| Defect | Cause | Fix |
| --- | --- | --- |
| Confirmed actions (archive, cancel, deactivate) silently did nothing | `event.currentTarget` is `null` after `await`ing the confirmation dialog | Capture the button before the first `await` |
| Success messages vanished immediately | The page re-rendered right after the message appeared and cleared it | Refresh keeps messages; messages across page changes use a "flash" queue |
| Username field `pattern` rejected by current browsers (console error, check skipped) | Unescaped `-` in a character class under the `v` flag | `[A-Za-z0-9_.\-]{3,30}` |
| Test race: an old message was read instead of the new one | Assertion looked at stale text | Assertion now waits for a matching message |

### Screenshot index (`docs/screenshots/`)

| File | Shows |
| --- | --- |
| `01-signin`, `02-signin-error`, `03-register` | Sign in, error, create account with provisioning key |
| `10`–`15` | Seller: empty list, form errors, products, low-stock filter, stock page, confirm dialog |
| `20`–`30` | Buyer: catalogue, search, stock conflict, cart, cart warning, checkout, order placed, orders, cancelled, invoice, print view, checkout 409 |
| `40`, `41` | Seller orders (own lines only, no address) |
| `50`–`55` | Admin: dashboard, orders, order detail, users, audit log, products |
| `60`–`63` | Errors: 403, no access, offline, 429 |
| `70`–`73` | Mobile (390 px): catalogue, menu, orders, admin orders |

Until you re-run on real PostgreSQL, these screenshots show data from the mock.
