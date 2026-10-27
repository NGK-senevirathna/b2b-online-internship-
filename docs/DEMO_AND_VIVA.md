# Demo script (10 minutes) and viva answers

> **Note:** the Arrowstack PDF was not available when this file was written. Section 3 answers the questions every reviewer of this kind of project asks, plus "what would you change for 10x load?". **Open the PDF, copy its viva questions into Section 4 and write your own answers in your own words.** Examiners can tell memorised text from understanding, so rewrite every answer so you could say it without reading.

## 1. Before you start (do this 15 minutes earlier)

1. `docker compose up --build -d` and `curl --fail http://localhost:5000/health/ready` → `ready`. (Or `npm run db:migrate && npm start`.)
2. `npm run db:seed` and **write down the printed password** (shown once). Accounts: `demo.admin`, `demo.seller`, `demo.buyer`.
3. Three browser windows (or profiles) side by side: Buyer, Seller, Admin. Open `http://localhost:5000/app/` in each. Remember: **a reload signs you out** (tokens are memory-only), so never press F5 while presenting.
4. Make sure the seed has at least one product with stock of 3-5 (low stock) and one with plenty.
5. Have the terminal ready with `npm test` and `npm run test:db`, and `docs/screenshots/` open as a fallback if the network or Docker misbehaves.
6. Close notifications. Browser zoom 100%.

## 2. The 10-minute demo

| Time | Say | Do | Point out |
| --- | --- | --- | --- |
| 0:00 | "A B2B ordering platform for a distributor, three roles, one database, built to be safe under concurrent use." | Show the sign-in page | Same Northstar design as Section 1 |
| 0:45 | "The Seller owns the catalogue." | Seller window → sign in → **New product** (leave price blank → inline error; then fill: SKU, name, 24.99, stock 4) | Validation messages; product appears with a **Low stock** badge |
| 1:45 | "Stock changes are never silent." | **Stock** → add 10 with a note → show history; try removing more than exists | Notes are mandatory; ledger shows who/when; cannot go below zero |
| 2:45 | "Buyers see only what is for sale." | Buyer window → catalogue → search, sort by price, next page | Pagination, stock status |
| 3:30 | "The cart tells the truth about stock." | Add 2 units; change to 3; then in Seller window reduce stock to 2 (note "write-off"); back in Buyer cart | Warning "Only 2 in stock", **checkout disabled** |
| 4:30 | "Checkout can't create duplicates." | Fix quantity → Checkout → submit empty address (inline error) → valid address → **double-click Place order** | One order only (open DevTools → Network: one `POST /api/orders` with an `Idempotency-Key` header) |
| 5:30 | "Invoice and history." | Order detail → progress tracker → **View invoice** → Print preview | Printable layout, tax lines |
| 6:15 | "Admin runs the workflow." | Admin window → Dashboard cards → Orders → **Confirm → Mark shipped → Mark delivered → Mark paid** | Buttons offer only legal next steps; Buyer's view updates |
| 7:30 | "Accounts and proof." | Users: change a role (dialog), deactivate a user; show your own row is locked. Audit log: filter `order.status` | Deactivation signs the user out at once; the audit log is append-only |
| 8:30 | "Security in two minutes." | Seller window → `#/admin/orders` ("no access"); create product named `<img src=x onerror=alert(1)>` → it is plain text; DevTools → storage is empty | Server enforces roles; no `innerHTML`; strict CSP |
| 9:15 | "Quality evidence." | Terminal: `npm test` (18 pass), mention `npm run test:db` (40 pass) and `npm run e2e` (UI steps), show `docs/TEST_EVIDENCE.md` | Race test: 3 buyers, 2 units, exactly 2 orders |
| 9:45 | "What I would do next." | Slide or sentence | See "10x load" answer |

**Failure plan:** if something breaks live, say what you expected, open the matching screenshot in `docs/screenshots/`, and keep going. Calm explanation scores better than a perfect run.

## 3. Viva questions and model answers

Rewrite these in your own words.

**Q1. Why Node/Express and PostgreSQL?**
Express is small and I can see every step of a request. PostgreSQL gives transactions, row locks, CHECK constraints and triggers, which are what keep money and stock correct. Orders, lines and invoices are strongly related, so a relational model fits better than a document store.

**Q2. Explain the architecture.**
Routes map URLs to controllers; controllers only validate input and shape responses; services hold business rules and transactions; models contain only SQL. This means a rule such as "only pending orders can be cancelled" lives in one place and is tested without HTTP.

**Q3. How do you prevent overselling?**
Checkout runs in one transaction. It locks the buyer's cart, locks the products in a fixed (id) order so two checkouts cannot deadlock, checks stock, decrements it, and writes the order, lines, invoice and audit record together. A database `CHECK (stock_quantity >= 0)` is the last line of defence. My test makes three buyers race for the last two units: exactly two succeed.

**Q4. What is an Idempotency-Key and why use it?**
It is a unique token the browser sends with the checkout request. If the network drops and the request is retried, or the user double-clicks, the server recognises the key and returns the original order instead of creating a second one. The UI keeps the same key while the cart is unchanged.

**Q5. How does authentication work?**
Passwords are hashed with bcrypt (12 rounds). Login returns a short-lived (1 h) JWT access token and a single-use refresh token. Every refresh rotates the token; if an old one is replayed, the whole session is revoked. On every request the server checks the signature, that the session is still active, and loads the user from the database, so deactivation and role changes apply immediately.

**Q6. Where do you store the token in the browser, and why?**
Only in JavaScript memory. localStorage and normal cookies can be read by injected scripts or sent automatically. The trade-off is that a reload signs the user out; the next step would be a small backend-for-frontend using HttpOnly cookies.

**Q7. How do you stop XSS?**
Three layers: the UI never builds HTML from data (`textContent`/text nodes only; my DOM helper refuses `on*` and `style` attributes); a strict CSP (`script-src 'self'`, no inline script) so injected code would not run; and tokens are not in storage, so there is little to steal. I tested with a product named `<img onerror=…>`.

**Q8. How do you handle authorisation?**
Three layers: route role guards, ownership checks inside services (other people's data returns 404, not 403, so existence is not leaked), and field whitelists. The UI also hides actions, but that is convenience; the server decides.

**Q9. Why store money as integer cents?**
Floating point cannot represent 0.10 exactly. Cents are integers. Tax uses BigInt basis points. My own tests found that the first float implementation could exceed `Number.MAX_SAFE_INTEGER` for the largest order; I fixed it and added a test.

**Q10. What does the audit log guarantee?**
Entries are written in the same transaction as the change, so there is never an action without a record or the reverse. A trigger rejects UPDATE, DELETE and TRUNCATE, so even someone with database access through the app cannot silently rewrite history.

**Q11. How did you test it?**
18 unit/HTTP tests with no database, 40 integration tests against a real PostgreSQL (races, idempotency, IDOR, audit immutability, rate limits), and a browser test (Playwright) that drives the UI as Buyer, Seller and Admin, checks keyboard use, mobile layout and CSP violations, and saves screenshots. I also proved one test is effective by removing the cart lock and watching it fail (3 orders instead of 1).

**Q12. What was the hardest bug?**
_Write your own. Candidates from this project:_ the float tax overflow; success messages disappearing because the page re-rendered right after showing them (fixed with a "flash" queue and a keep-messages refresh); `event.currentTarget` being `null` after awaiting a confirmation dialog, which made Archive silently do nothing; an invalid `pattern` regex on the username field in newer browsers.

**Q13. What would you change for 10x load?**
First measure, then fix the real bottleneck. My ordered list:

1. **Database first.** Add the right indexes (check `EXPLAIN ANALYZE` on catalogue search, orders by buyer/status, audit filters), use a connection pooler (PgBouncer) and size the pool. Move heavy read queries (dashboard, audit search, reports) to a read replica or materialised views refreshed on a schedule.
2. **Stateless app, scale out.** The API keeps no session state in memory (JWT + database sessions), so run several containers behind a load balancer. Rate-limit counters already live in PostgreSQL; at 10x I would move them to Redis because they are written on every request.
3. **Hot rows.** Checkout locks product rows; a very popular product becomes a queue. Keep transactions short, keep the lock order, and for flash-sale products consider a reservation table or a stock counter in Redis reconciled to PostgreSQL.
4. **Caching.** Cache the public catalogue pages for seconds (CDN or Redis), serve the static UI with long-lived hashed filenames from a CDN; `no-store` stays on private API data.
5. **Asynchronous work.** Move audit-heavy reporting, emails and invoice PDF generation to a queue; keep the order transaction small.
6. **Pagination and limits.** Switch deep `OFFSET` pagination to keyset (cursor) pagination for big tables; partition `audit_logs` and `stock_movements` by month.
7. **Observability.** Request ids already exist; add metrics (latency percentiles, pool usage, lock waits), structured logs and alerts, then load-test (k6) before and after each change.

**Q14. What are the limitations?**
Single currency, no payment gateway, no email/password reset/MFA, the whole order is fulfilled by the Admin rather than per seller, and a reload signs the user out. Each is documented, with the next step.

**Q15. How would you deploy it?**
`docker compose` already starts PostgreSQL and the app with a read-only filesystem and a non-root user. For production: managed PostgreSQL, secrets from a secret manager, HTTPS at a reverse proxy with `TRUST_PROXY` set, `CORS_ORIGIN` listed, CI that runs the tests and `npm audit`, and health checks wired to the orchestrator.

**Q16. What did you learn / what would you do differently?**
_Write your own, from your `WORKLOG.md` reflection._

## 4. The PDF's own viva questions

_Paste each question below and write your answer in your own words._

1. …
2. …
3. …

## 5. Last-minute checklist

- [ ] Docker stack healthy; seed password written down.
- [ ] Three windows signed in; no reload needed.
- [ ] `npm test` and `npm run test:db` pass on your machine today.
- [ ] You can explain the checkout transaction without looking.
- [ ] You can find: the order service, the audit trigger migration, the CSP in `server.js`, `frontend/js/dom.js`.
