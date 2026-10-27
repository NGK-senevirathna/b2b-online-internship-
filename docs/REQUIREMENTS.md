# Requirements: B2B Order Management Platform

> Arrowstack Full Stack Internship, Project 1. Written for the product as built (Section 1 backend + Section 2 web UI).
> **Check before submitting:** this file was written without the Arrowstack PDF in front of it. Compare the headings and the acceptance table with the PDF's required deliverables and grading rubric, and rename or add rows where the PDF uses different wording.

## 1. Purpose

A distributor sells to business customers. Today (the simulated "before") orders arrive by email, stock lives in spreadsheets, and nobody can prove who changed what. This platform gives each party one place to work:

- **Buyers** find products, order them safely and see their invoices.
- **Sellers** keep their own catalogue and stock accurate and see the orders they must supply.
- **Admins** run the workflow (confirm, ship, deliver, get paid), manage accounts and audit everything.

## 2. Stakeholders

| Stakeholder | What they care about | How the product serves them |
| --- | --- | --- |
| Buyer (purchasing clerk) | Order what is really available, see totals and tax before paying, find past orders and invoices | Catalogue with search/sort/stock status, cart with stock warnings, checkout, order history, printable invoice |
| Seller (supplier) | Accurate stock, no overselling, see demand, protect margins and customer data | Own product table, stock ledger with notes, low-stock filter, orders showing **only their lines** (no delivery address) |
| Admin (operations / finance) | Control the order lifecycle, get paid, control access, prove what happened | Workflow buttons, invoice payment, user management, append-only audit log, dashboard |
| Platform owner / IT security | No data leaks, no privilege escalation, no tampering | Role guards, strict CSP, rate limits, audit trail, tests |
| Assessor / mentor | Complete, tested, explainable work | This document set, test evidence, demo script |

## 3. Scope

**In scope**

- Account registration and sign-in with three roles; sessions that can be revoked.
- Catalogue, cart, checkout, orders, invoices, stock control, user administration, audit log, dashboard.
- Web UI in plain HTML/CSS/JavaScript (no framework), responsive, keyboard operable.
- Docker packaging, automated tests, written documentation.

**Out of scope (stated limits)**

- Real payment gateway, refunds, shipping carriers, multi-currency, email notifications, password reset, multi-factor sign-in.
- Splitting one order into per-seller shipments (the Admin fulfils the whole order).
- Persisting the sign-in across a page reload (tokens are deliberately memory-only).

## 4. Functional requirements

| ID | Requirement |
| --- | --- |
| FR-1 | A person can register as Buyer; Seller/Admin only with the role-provisioning key. |
| FR-2 | A user can sign in, stay signed in while the page is open (silent refresh) and sign out (server revokes the session). |
| FR-3 | A Buyer can browse active products with search, sort, in-stock filter and pagination. |
| FR-4 | A Buyer can add products to a cart, change quantities and see subtotal, tax and total; the cart warns when stock is short or a product is gone. |
| FR-5 | A Buyer can check out with a shipping address; retries and double clicks never create two orders (Idempotency-Key). |
| FR-6 | Checkout fails clearly (409) when stock changed, naming the affected products. |
| FR-7 | A Buyer sees only their own orders, can cancel a **pending** order (stock returns, invoice voided) and can open and print the invoice. |
| FR-8 | A Seller can create, edit, archive and restore their own products and adjust stock with a mandatory note; the stock history is visible. |
| FR-9 | A Seller can filter their products by low stock. |
| FR-10 | A Seller sees orders that contain their products, limited to their own lines, without the delivery address. |
| FR-11 | An Admin sees all orders (status filter) and moves them `pending → confirmed → shipped → delivered` or cancels while pending/confirmed. |
| FR-12 | An Admin can mark an invoice paid (once, not after cancellation). |
| FR-13 | An Admin can list/search users, change a role and activate/deactivate an account (takes effect immediately). The last Admin and one's own account are protected. |
| FR-14 | An Admin can read and filter the audit log and see dashboard totals. |
| FR-15 | Every failure shows a clear message (validation, 401, 403, 404, 409, 429, 5xx, offline). |

## 5. Non-functional requirements

| ID | Requirement | Measure |
| --- | --- | --- |
| NFR-1 | Correct money | Integer cents, BigInt tax; no float rounding |
| NFR-2 | Concurrency safety | Never oversell; never double-order |
| NFR-3 | Security | OWASP-style controls listed in `SECURITY.md`; strict CSP; `npm audit` clean |
| NFR-4 | Accessibility | Keyboard-only use, skip link, focus moves to the page title, labelled controls, live regions, visible focus |
| NFR-5 | Responsive | No sideways scroll at 390 px; tables become cards |
| NFR-6 | Operability | `docker compose up`, health endpoints, migrations, seed data |
| NFR-7 | Auditability | Append-only audit log written inside the business transaction |

## 6. Success metrics

| Metric | Target | How it is measured |
| --- | --- | --- |
| Oversold units in the race test | 0 | `npm run test:db` (3 buyers, last 2 units: exactly 2 orders) |
| Duplicate orders from double submit | 0 | DB test (3 parallel submits → 1 order) and UI test (double click → 1 `POST /api/orders`) |
| Cross-user data exposure | 0 | DB tests (404 for others' orders, sellers never see address) |
| Core journeys completable per role | 3 of 3 | `npm run e2e` (Buyer, Seller, Admin) |
| Script errors / CSP violations in the browser | 0 | Final step of `npm run e2e` |
| Dependency vulnerabilities (production) | 0 | `npm audit --omit=dev` |
| Time for a buyer to place a repeat order | under 2 minutes | Manual timing during the demo (fill in your own measured value in `WORKLOG.md`) |

## 7. Acceptance criteria mapped to evidence

"Evidence" names a file or command. Rows marked **(run on your PC)** need you to run the command against real PostgreSQL and paste the result into `docs/TEST_EVIDENCE.md`.

| Req | Acceptance criterion (Given / When / Then) | Evidence |
| --- | --- | --- |
| FR-1 | Given no key, when registering as Seller, then 403 and an error message | DB test "privilege escalation through registration is blocked"; UI step "registering Seller with a wrong provisioning key is refused"; `screenshots/03-register.png` |
| FR-2 | Given an expired access token, when the user clicks anything, then the UI refreshes silently and continues | `e2e` step "expired access token is refreshed transparently" (mock hook only; real: DB test "rotates once and revokes the session when the old token is reused") |
| FR-3 | Given 16 products, when the Buyer opens the catalogue, then 12 show with "Page 1 of 2"; sorting by price works | `20-catalogue.png`, `21-catalogue-search.png`, e2e step "catalogue, search, sort, pagination" |
| FR-4 | Given stock falls below the cart quantity, when the cart opens, then a warning shows and checkout is disabled | `24-cart-warning.png`, DB test "cart enforces stock…" |
| FR-5 | Given a double click on Place order, then exactly one order exists | e2e step "double click makes one order"; DB tests "Idempotency-Key makes retries safe", "double-submitting one cart in parallel creates a single order" |
| FR-6 | Given stock changed after the checkout page opened, when ordering, then 409 lists the product | `30-checkout-409.png`; DB test "items that became unavailable block checkout with details" |
| FR-7 | Given a pending order, when the Buyer cancels, then status is cancelled and stock is back | `28-order-cancelled.png`; DB test "buyer cancels a pending order…"; `29-invoice.png`, `29b-invoice-print.png` |
| FR-8 | Given a stock removal larger than stock, then it is refused with a message | `14-seller-stock.png`; DB test "stock adjustments cannot go below zero and are audited" |
| FR-9 | Given low-stock products, when the filter is on, then only those show | `13-seller-low-stock.png` |
| FR-10 | Given an order with two sellers' products, then each seller sees only their lines and no address | `40-seller-orders.png`, `41-seller-order-detail.png`; DB test "sellers see only orders containing their products…" |
| FR-11 | Given a pending order, when the Admin confirms, ships and delivers it, then each step succeeds and no further actions remain | `51-admin-orders.png`, `52-admin-order-detail.png`; DB test "only an Admin can progress an order…" |
| FR-12 | Given a delivered order, when the Admin marks it paid, then the invoice is paid; a second attempt is refused | e2e step "move through the workflow, mark invoice paid"; DB test "invoices can be paid once…" |
| FR-13 | Given an Admin, when deactivating a user, then that user cannot sign in; own row is locked | `53-admin-users.png`; DB tests "deactivating a user ends their sessions…", "role changes take effect immediately…" |
| FR-14 | Given activity, when filtering the audit log by `order.status`, then the three transitions show | `54-admin-audit.png`; DB test "audit records cannot be altered or deleted" |
| FR-15 | Given 403 / 409 / 429 / offline, then a plain-language message shows | `60-error-403.png`, `22-add-conflict.png`, `30-checkout-409.png`, `63-error-429.png`, `62-error-offline.png` |
| NFR-1 | Largest order tax is exact | `test/validation.test.js` (BigInt tax) |
| NFR-3 | No inline script/style; no CSP violations | Last e2e step; `SECURITY.md` |
| NFR-4 | Keyboard sign-in, Escape closes dialogs, focus on title | e2e step "Keyboard…" |
| NFR-5 | No horizontal scroll at 390 px | e2e step "Mobile (390px)…", `70`–`73-mobile-*.png` |
| NFR-6 | Stack starts with Docker and answers `/health/ready` | `docker compose up --build -d` + `curl --fail http://localhost:5000/health/ready` **(run on your PC)** |

## 8. Assumptions and constraints

- One currency (USD), tax is one configurable percentage (`TAX_RATE_BPS`).
- Invoices are due 30 days after issue.
- The seeded demo accounts (`demo.admin`, `demo.seller`, `demo.buyer`) exist only in development.
- The rubric and required deliverables come from the Arrowstack PDF; see the note at the top of this file.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Two buyers want the last unit | Row locks and a database CHECK; tested |
| A page reload signs the user out | Accepted trade-off for XSS safety; documented as a limitation |
| Shared IP (office) trips the sign-in limiter | Limits are configurable; `TRUST_PROXY` for correct client IPs |
| Admin demotes themselves | Server refuses (`SELF_LOCKOUT`, `LAST_ADMIN`) |
