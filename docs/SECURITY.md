# Security and threat model

## 1. What we protect

| Asset | Why it matters |
| --- | --- |
| Accounts and sessions | Impersonation gives access to money and data |
| Orders, addresses, invoices | Business-confidential and personal data |
| Stock and prices | Integrity drives revenue |
| Audit log | The proof of who did what |
| Secrets (`JWT_SECRET`, `ROLE_PROVISIONING_KEY`, DB password) | Compromise defeats every other control |

## 2. Actors and trust boundaries

```text
Browser (untrusted)  --HTTPS-->  Express API (trusted code)  --private network-->  PostgreSQL
      |                              |
  Buyer / Seller / Admin         Role guards + services enforce rules
  attacker with a valid account  (the browser UI is only a convenience, never the authority)
```

Anything from the browser is untrusted, including the UI's own checks. The UI hides buttons a role cannot use; **the server re-checks every request**.

## 3. Threats and controls (STRIDE)

| # | Threat | Category | Control | Where | Evidence |
| --- | --- | --- | --- | --- | --- |
| T1 | Guess passwords | Spoofing | bcrypt (12 rounds); failed-login limiter (10 / 15 min / IP, counters in PostgreSQL); generic error text | `authController`, `rateLimiter` | DB test "repeated failed sign-ins are rate limited"; UI `63-error-429.png` |
| T2 | Learn which accounts exist (timing / messages) | Info disclosure | Same message for unknown user and wrong password; hash compared even if the user is missing | `authController` | Code review |
| T3 | Steal or replay a token | Spoofing | Access JWT 1 h; refresh tokens single-use with rotation; reuse revokes the whole session; logout and deactivation revoke at once | `sessionModel` | DB test "rotates once and revokes the session when the old token is reused" |
| T4 | Token stolen by script injection (XSS) | Info disclosure | Tokens live only in JavaScript memory (no localStorage/cookie); strict CSP `script-src 'self'`; **no `innerHTML`**: every value is a text node; no inline scripts or styles | `frontend/js/dom.js`, `server.js` | UI test renders `<img onerror>` and `<script>` as plain text and checks `window.__xss` is undefined; zero CSP violations |
| T5 | Clickjacking | Tampering | `frame-ancestors 'none'` | `server.js` | Header test |
| T6 | Buyer reads another buyer's order (IDOR) | Info disclosure | Ownership checked in the service; other people's orders return 404 | `orderService.loadVisibleOrder` | DB test "buyers see only their own orders (no IDOR)" |
| T7 | Seller reads addresses of buyers | Info disclosure | Seller view of an order omits address and totals; only own lines | `presentOrder` | DB test; UI `41-seller-order-detail.png` |
| T8 | Privilege escalation (register as Admin, edit role in request) | Elevation | Seller/Admin registration needs `X-Role-Provisioning-Key`; request bodies accept only listed fields; role changes only by Admin | `authController`, `validation.exactObject` | DB test "privilege escalation through registration is blocked" |
| T9 | Stale permissions after demotion | Elevation | Role is read from the database on every request, not trusted from the JWT | `authMiddleware` | DB test "role changes take effect immediately"; UI `60-error-403.png` |
| T10 | SQL injection | Tampering | Parameterised queries only; sort fields from an allow-list; `LIKE` wildcards escaped | `models/*` | DB test "SQL injection attempts … handled as plain text" |
| T11 | Oversell / double order (race, double click, retry) | Tampering | One transaction with row locks (products locked in id order), cart lock, `Idempotency-Key`, DB CHECK `stock >= 0` | `orderService.checkout` | DB tests (3 buyers, 2 units; 3 parallel submits); UI double-click test |
| T12 | Money rounding errors | Tampering | Integer cents; BigInt tax | `utils/money.js` | `validation.test.js` (defect found and fixed) |
| T13 | Admin (or attacker with DB access) rewrites history | Repudiation | Audit rows written inside the business transaction; table rejects UPDATE, DELETE, TRUNCATE (trigger); stock movements are a ledger | migrations | DB test "audit records cannot be altered or deleted, even with database access" |
| T14 | Admin locks everyone out | Denial of service | Cannot demote/deactivate yourself; last active Admin protected | `adminService` | DB test; UI disables own row |
| T15 | Flooding the API | Denial of service | General limiter (300 / 15 min / IP), sign-up limiter, 10 kB JSON body limit, pagination caps | `rateLimiter`, `server.js` | `63-error-429.png` |
| T16 | Error messages leak internals | Info disclosure | Generic 500 text; request id for log correlation; DB error codes mapped to safe messages | `errorMiddleware` | DB test "errors never leak internals" |
| T17 | Cached private data on shared computers | Info disclosure | `Cache-Control: no-store` on `/api`; reload signs out | `requestContext` | Header test; e2e "reload signs out" |
| T18 | Cross-origin abuse | Tampering | CORS allow-list (explicit origins required in production); no cookies are used for auth, so CSRF does not apply to the API | `server.js` | Config check |
| T19 | Vulnerable dependencies | Various | Minimal dependency set, lockfile, `npm audit` clean | `package.json` | `npm audit --omit=dev` |
| T20 | Container breakout / secrets in image | Elevation | Non-root user, read-only filesystem, all capabilities dropped, `no-new-privileges`, DB published on loopback only, `.env` in `.gitignore` and `.dockerignore`, production refuses weak secrets | `Dockerfile`, `docker-compose.yml` | `docker compose config` |

## 4. UI-specific rules (Section 2)

1. Build elements with `createElement` + `textContent`/text nodes (`frontend/js/dom.js`). The helper **refuses** `on*` attributes, `style`, `srcdoc` and non-local `href` values, so a future mistake fails loudly.
2. No inline `<script>`, event-handler attributes or `style=` anywhere; styling is done with CSS classes (the CSP would block the rest).
3. Tokens are module variables in `js/api.js`: not in storage, cookies, the URL or the DOM.
4. One refresh at a time (single-use refresh tokens must not be raced).
5. Idempotency-Key per checkout attempt; regenerated when the cart content changes or after a definitive 409.
6. Role-based routing in the browser is a usability feature; the server's 403/404 responses are the real control, and the UI shows them clearly.

## 5. Residual risks (honest list)

| Risk | Status |
| --- | --- |
| No MFA, password reset or email verification | Out of scope; would be the next security work |
| Memory-only tokens mean sign-in after each reload | Chosen for XSS safety; a backend-for-frontend with HttpOnly SameSite cookies would fix the UX |
| Rate limits are per IP; many users behind one NAT share a budget | Configurable; use `TRUST_PROXY` correctly |
| `ROLE_PROVISIONING_KEY` is a shared secret | Rotate it; replace with an invitation flow for real use |
| TLS is not terminated by this app | Run behind a reverse proxy / load balancer with HTTPS (production already sends `upgrade-insecure-requests`) |
| No automated scanning (SAST/DAST) in CI | Suggested: CodeQL and OWASP ZAP baseline |

## 6. How to demonstrate security in the viva (2 minutes)

1. Open `#/admin` as a Buyer: "no access" page. Show the same request in DevTools → 403/404 from the server.
2. Create a product named `<img src=x onerror=alert(1)>`: it appears as text.
3. DevTools → Application: localStorage, sessionStorage and cookies are empty.
4. Console: `fetch('/api/admin/summary')` without a token → 401.
5. Show the audit log entries produced by your own actions.
