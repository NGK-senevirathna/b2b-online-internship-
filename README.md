# B2B Auth Microservice

A modular Node.js and Express service for B2B account registration, JWT authentication, and role-based authorization. It persists users and revocable authentication sessions in PostgreSQL, rotates opaque refresh tokens, and shares rate-limit counters across service instances through PostgreSQL.

## Capabilities

- Buyer, Seller, and Admin roles with role-protected API routes.
- bcryptjs password hashing (12 salt rounds), input validation, and case-insensitive identity uniqueness.
- HS256 access JWTs (one-hour default) and rotating, hashed refresh tokens.
- Immediate access-token invalidation on logout, account lookup on protected requests, and refresh-token replay detection.
- PostgreSQL persistence and ordered, advisory-lock-protected SQL migrations.
- Helmet, configurable CORS, Morgan request logging, JSON body limits, and shared PostgreSQL-backed IP rate limiting.
- Readiness/liveness endpoints, graceful shutdown, standardized JSON errors, and automated tests.

## Architecture

```text
config/database.js                 PostgreSQL pool and connection checks
config/jwtConfig.js                JWT settings and secret validation
controllers/authController.js      Registration, login, refresh, logout, API responses
middleware/authMiddleware.js      JWT verification and active-session/user lookup
middleware/roleMiddleware.js      Role authorization
middleware/errorMiddleware.js     Not-found and global error responses
middleware/rateLimiter.js         Shared PostgreSQL rate-limit store
models/userModel.js                Parameterized PostgreSQL user operations
models/sessionModel.js             Atomic session and refresh-token lifecycle
migrations/001_initial_schema.sql  Users, sessions, refresh tokens, and rate-limit tables
scripts/migrate.js                 Ordered migration runner
routes/authRoutes.js               Auth API route definitions
frontend/                           Responsive browser UI (HTML, CSS, JavaScript)
server.js                          Express setup, health checks, startup/shutdown
test/                               HTTP and optional PostgreSQL integration tests
docker-compose.yml                 Local PostgreSQL for development
```

Controllers use asynchronous model interfaces. Parameterized SQL protects data operations, unique database constraints handle concurrent duplicate registrations, and refresh-token changes are transactional. The migration runner serializes concurrent deployments with a PostgreSQL advisory lock.

## Prerequisites

- Node.js 18 or newer
- npm
- Docker with Docker Compose (for the included local PostgreSQL service), or a reachable PostgreSQL 13+ database

## Reproducible local setup

Install exact locked dependencies and create local configuration:

```bash
npm ci
cp .env.example .env
```

Start PostgreSQL using the development-only credentials in `docker-compose.yml`:

```bash
docker compose up -d postgres
```

Change `JWT_SECRET` and `ROLE_PROVISIONING_KEY` in `.env` to different, randomly generated values of at least 32 characters. For example, generate one with:

```bash
openssl rand -base64 48
```

Apply database migrations, then start the service:

```bash
npm run db:migrate
npm start
```

The API listens on `http://localhost:5000` by default. On another deployment, set `DATABASE_URL` to the PostgreSQL connection string; run `npm run db:migrate` as a deployment step before starting the service. Runtime startup verifies the database connection and fails clearly if PostgreSQL is unavailable.

Open the web interface at `http://localhost:5000/app/` (or your configured port). It is served from the same Express origin as the API, so no separate frontend server or CORS origin is needed.

> The Compose database password and `.env.example` values are for local development only. Do not use them in a shared or production environment. Never commit `.env`.

### Run the complete stack in Docker

After copying `.env.example` to `.env` and replacing `JWT_SECRET` and `ROLE_PROVISIONING_KEY` with different random values, start both the PostgreSQL database and the API container:

```bash
docker compose up --build -d
docker compose ps
curl --fail http://localhost:5000/health/ready
```

The API container waits for PostgreSQL health, applies pending migrations, then starts the service. Stop containers without deleting the persistent database volume with:

```bash
docker compose down
```

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Controls request-log format. |
| `PORT` | No | `5000` | HTTP listen port (1-65535). |
| `HOST_PORT` | No | `5000` | Host port published by Docker Compose. |
| `POSTGRES_PASSWORD` | Local Compose only | `b2b_auth_dev_password` | Development database password; use a managed secret and change it outside local development. |
| `DATABASE_URL` | Yes | — | PostgreSQL connection URI. |
| `DATABASE_SSL` | No | `false` | Set `true` to enable TLS for PostgreSQL. |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | No | `true` | Set `false` only when the database TLS certificate policy explicitly requires it. |
| `DB_POOL_MAX` | No | `10` | Maximum PostgreSQL pool connections per service process. |
| `JWT_SECRET` | Yes | — | HS256 signing secret; at least 32 characters. |
| `JWT_EXPIRES_IN` | No | `1h` | `jsonwebtoken` duration string for access tokens. |
| `REFRESH_TOKEN_TTL_DAYS` | No | `30` | Sliding refresh-session lifetime, from 1 to 365 days. |
| `CORS_ORIGIN` | No | `*` | Comma-separated allowed origins. Use explicit frontend origins in production. |
| `TRUST_PROXY` | No | — | Trusted proxy hop count or comma-separated proxy addresses/subnets. Configure only for a known reverse-proxy topology. |
| `ROLE_PROVISIONING_KEY` | For API Seller/Admin provisioning | — | Separate secret (at least 32 characters), sent as `X-Role-Provisioning-Key`. Restrict it to trusted provisioning systems. |

## API response format

Success:

```json
{ "success": true, "message": "Description.", "data": {} }
```

Failure:

```json
{ "success": false, "error": "Description.", "statusCode": 400 }
```

Protected routes require `Authorization: Bearer <ACCESS_TOKEN>`.

## API reference

### `GET /` and `GET /health/live`

Liveness endpoints (HTTP 200):

```json
{
  "success": true,
  "message": "Service is live.",
  "data": { "status": "ok" }
}
```

### `GET /health/ready`

Checks PostgreSQL connectivity. Returns HTTP 200 when ready; database errors are handled centrally and readiness does not report success if the database is down.

### `POST /api/auth/register`

Requires username (3-30 allowed characters), valid email, and password (8 or more characters, no more than 72 UTF-8 bytes). Username and email uniqueness is case-insensitive. If omitted, `role` defaults to `Buyer`. Public requests can create Buyers only; Seller and Admin registration requires the trusted role-provisioning key.

Request:

```json
{
  "username": "buyer01",
  "email": "buyer@example.com",
  "password": "correct-horse-battery"
}
```

For a provisioned Seller or Admin, add:

```http
X-Role-Provisioning-Key: <ROLE_PROVISIONING_KEY>
```

and include `"role": "Seller"` or `"role": "Admin"` in the JSON body. Success returns HTTP 201 and the public user profile; password hashes are never returned.

### `POST /api/auth/login`

Accepts a `username`, `email`, or `identifier` and a password. Invalid credentials return a generic HTTP 401 response.

```json
{ "username": "buyer01", "password": "correct-horse-battery" }
```

Success returns the access token (`data.token`), refresh token (`data.refreshToken`), expiry metadata, and public profile.

### `POST /api/auth/refresh`

Exchanges a valid refresh token for a new access/refresh token pair. Each refresh token is single-use; replaying an already-consumed token revokes its entire session family.

```json
{ "refreshToken": "<OPAQUE_REFRESH_TOKEN>" }
```

Clients must atomically replace their stored refresh token with the new `data.refreshToken`. Store refresh tokens in a secure client-side secret store; never log or expose them.

### `POST /api/auth/logout`

Requires an access token. Revokes its session and refresh-token family; all access tokens associated with that session are rejected immediately on subsequent requests.

### `GET /api/auth/me`

Requires any valid, non-revoked session. Returns the current public account profile. The user record is loaded for each protected request, so role changes in the database take effect without waiting for access-token expiry.

### `GET /api/auth/seller-panel`

Requires a valid session and the `Seller` or `Admin` role. Other authenticated users receive HTTP 403.

### `GET /api/auth/admin-dashboard`

Requires a valid session and the `Admin` role. Other authenticated users receive HTTP 403.

## Demonstrate with curl

Create a Buyer, then log in:

```bash
curl --fail -X POST http://localhost:5000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo-buyer","email":"demo-buyer@example.com","password":"demo-password-123"}'

curl --fail -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo-buyer","password":"demo-password-123"}'
```

Copy `data.token` from the login response:

```bash
curl --fail http://localhost:5000/api/auth/me \
  -H 'Authorization: Bearer <ACCESS_TOKEN>'

curl -i http://localhost:5000/api/auth/seller-panel \
  -H 'Authorization: Bearer <ACCESS_TOKEN>'
```

The profile request succeeds; the Buyer request to the Seller panel returns 403. To demonstrate the Seller and Admin routes, add the provisioning header to registration, set the corresponding role, log in, and use the returned access token. Refresh and logout using the request shapes above.

The same requests can be sent from Postman or Thunder Client with JSON content type and the corresponding authorization/header values.

The web interface at `/app/` provides Buyer registration and sign-in, conditionally asks for the role-provisioning key for Seller/Admin registration, displays the authenticated profile, and calls the role-specific protected API. Access and refresh tokens are held in JavaScript memory only; reloading the page clears them and requires sign-in again. This avoids storing credentials in browser localStorage/sessionStorage. For production, consider a backend-for-frontend with secure, HttpOnly cookies.

## Tests and validation

The default suite is self-contained and tests HTTP behavior with isolated in-memory test doubles:

```bash
npm test
```

For real PostgreSQL repository/session/rate-limit integration coverage, configure a test database in `DATABASE_URL`, apply migrations, and run:

```bash
npm run test:db
```

The DB integration suite skips when `DATABASE_URL` is absent. Use a disposable database for this suite; it creates and deletes test records. Never point destructive test runs at production data.

Additional checks:

```bash
npm audit --omit=dev
git diff --check
```

## Acceptance criteria and evidence map

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Registration validation, case-insensitive uniqueness, password hashing, Buyer default | `controllers/authController.js`, `models/userModel.js`, migration | `npm test`; `npm run test:db` checks PostgreSQL unique constraints |
| Controlled Seller/Admin role provisioning | Registration controller and `ROLE_PROVISIONING_KEY` | `npm test` rejects missing provisioning key and verifies authorized roles |
| Username/email login and configurable access JWT | Auth controller and JWT config | `npm test` login/protected API flow |
| Persistent users and sessions | PostgreSQL models and SQL migration | `npm run test:db` |
| Access JWT verification and immediate logout | Auth middleware and session model | `npm test` revokes access following logout |
| Refresh rotation and token replay handling | Session model/controller | `npm test` verifies single-use refresh and family revocation; PostgreSQL test exercises atomic DB behavior |
| Buyer/Seller/Admin route policies | Role middleware and routes | `npm test` verifies expected 200/401/403 outcomes |
| Shared IP rate limits | PostgreSQL rate-limit store | `npm run test:db` checks shared counter operations |
| Same-origin responsive web portal | `frontend/`, served at `/app/` by Express | `npm test` verifies HTML, JavaScript, and CSS assets are served |
| HTTP hardening, logging, error handling, health | `server.js`, middleware | `npm test`, manual readiness probe, and production configuration review |
| Reproducible setup/API usage | This README, `.env.example`, Compose file | Follow setup and curl walkthrough |

## Design decisions and operational notes

- **Access token and session policy:** access JWTs retain a one-hour configurable lifetime for the project requirements. A server-side session ID enables immediate logout/revocation; every protected request checks both session state and the current user/role in PostgreSQL.
- **Refresh-token storage:** refresh tokens are high-entropy opaque values. Only SHA-256 digests are stored. Rotation is performed in a database transaction; reuse of a consumed token revokes the whole session family.
- **Database constraints:** normalized generated columns and unique constraints make identity uniqueness case-insensitive and safe under concurrent registration attempts.
- **Role provisioning:** a shared provisioning key is a controlled bootstrap mechanism, not a replacement for a full administrator identity and audit workflow. Restrict it to trusted deployment/provisioning systems and rotate it if exposed.
- **Rate limiting:** the PostgreSQL store shares atomic fixed-window counters between replicas. It adds database traffic; monitor its latency and capacity. A dedicated Redis store can be preferable at higher scale.
- **Maintenance:** expired sessions (and their cascading refresh tokens) and expired rate-limit keys are periodically removed. Retention and cleanup cadence should be reviewed for deployment requirements.
- **Production deployment:** use TLS, managed database credentials, explicit CORS allowlists, database backups, monitoring, least-privilege DB roles, connection/pool limits, and a secret manager. Configure trusted proxy handling deliberately before deploying behind a reverse proxy.
- **Testing scope:** unit-level HTTP tests use model doubles; the optional DB suite exercises actual PostgreSQL operations when configured. Passing tests does not replace load testing, deployment checks, or an independent security review.

## Mentor review checklist

1. Follow local setup from a clean checkout.
2. Inspect the migration and confirm durable user/session records survive service restarts.
3. Register Buyer, Seller, and Admin users; verify missing provisioning headers fail.
4. Demonstrate 401 without a token, 403 for a disallowed role, and 200 for allowed roles.
5. Refresh a token once, replay the old token, and verify the session is revoked.
6. Log out and verify the same access token no longer works.
7. Run both test commands and review the documented limitations and next steps.
