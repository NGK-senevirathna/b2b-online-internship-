# B2B Auth Microservice

A modular Node.js and Express.js authentication service for B2B applications. It supports account registration, password-based login, signed JSON Web Tokens, and role-protected API routes for Buyer, Seller, and Admin users.

> **Persistence notice:** The included database adapter is in-memory and intended for local development and evaluation. It loses all data when the process restarts and is not shared between multiple instances. Replace `models/userModel.js` with a durable database adapter before production deployment.

## Features

- Password hashing with bcryptjs (12 salt rounds).
- JWTs signed with HS256 and a configurable expiration (one hour by default).
- Authorization based on validated `Buyer`, `Seller`, and `Admin` roles.
- Seller and Admin registration protected by a separate role-provisioning secret; public registrations are Buyers by default.
- Helmet security headers, configurable CORS, request logging, and IP rate limiting (100 requests per 15 minutes).
- Centralized error handling and consistent success/failure response formats.
- In-memory user model with a clean asynchronous interface for database replacement.

## Architecture

```text
config/jwtConfig.js              JWT settings and secret validation
controllers/authController.js    Registration, login, and protected responses
middleware/authMiddleware.js    JWT authentication
middleware/roleMiddleware.js    Role authorization
middleware/errorMiddleware.js   Not-found and centralized error responses
middleware/rateLimiter.js       IP request limit
models/userModel.js             In-memory persistence adapter
routes/authRoutes.js             Authentication and protected routes
server.js                        Express configuration and startup
```

The controller depends on the user model's asynchronous interface rather than its storage implementation. The model can be replaced with a MongoDB, PostgreSQL, or MySQL repository while keeping the HTTP routes and controller contract stable.

## Requirements and installation

- Node.js 18 or newer
- npm

Install dependencies:

```bash
npm install
```

Create a local environment file and set private values:

```bash
cp .env.example .env
```

At minimum, replace `JWT_SECRET` with a cryptographically random value of at least 32 characters. Generate one, for example, with:

```bash
openssl rand -base64 48
```

Set `ROLE_PROVISIONING_KEY` to a different random secret if you need to provision Seller or Admin accounts through the registration endpoint. Keep both values in a secret manager in deployed environments. Do not commit `.env`.

Start the service:

```bash
npm start
```

By default, the service listens on `http://localhost:5000`.

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Controls logging format. |
| `PORT` | No | `5000` | HTTP listen port (1-65535). |
| `JWT_SECRET` | Yes | — | HS256 signing secret; at least 32 characters. |
| `JWT_EXPIRES_IN` | No | `1h` | `jsonwebtoken` duration string for access tokens. |
| `CORS_ORIGIN` | No | `*` | Comma-separated allowed origins; use explicit origins in production. |
| `ROLE_PROVISIONING_KEY` | Only for API Seller/Admin provisioning | — | Separate secret, at least 32 characters, supplied in the `X-Role-Provisioning-Key` header. |

## API conventions

All successful responses use:

```json
{
  "success": true,
  "message": "Description of the result.",
  "data": {}
}
```

All failures use:

```json
{
  "success": false,
  "error": "Description of the failure.",
  "statusCode": 400
}
```

Protected endpoints require `Authorization: Bearer <TOKEN>`.

## API endpoints

### `GET /`

Health/readiness response.

```json
{
  "success": true,
  "message": "B2B Auth Microservice is running.",
  "data": { "status": "ok" }
}
```

### `POST /api/auth/register`

Creates an account. `username` must be 3-30 letters, digits, dots, underscores, or hyphens; `email` must be valid; and `password` must be at least 8 characters and at most 72 UTF-8 bytes. Username and email uniqueness is case-insensitive. If omitted, `role` defaults to `Buyer`. Supported roles are `Buyer`, `Seller`, and `Admin`. Public registration may create only Buyers; Seller and Admin registration requires the provisioning header described below.

Request:

```json
{
  "username": "buyer01",
  "email": "buyer@example.com",
  "password": "correct-horse-battery",
  "role": "Buyer"
}
```

Privileged-role provisioning request header:

```http
X-Role-Provisioning-Key: <ROLE_PROVISIONING_KEY>
```

Success (`201`):

```json
{
  "success": true,
  "message": "User registered successfully.",
  "data": {
    "user": {
      "id": "e22a15b4-cad5-4e16-b26b-fd6ba109f203",
      "username": "buyer01",
      "email": "buyer@example.com",
      "role": "Buyer"
    }
  }
}
```

### `POST /api/auth/login`

Authenticates by `username`, `email`, or `identifier`. Invalid credentials return the same generic `401` response.

Request:

```json
{
  "username": "buyer01",
  "password": "correct-horse-battery"
}
```

Success (`200`):

```json
{
  "success": true,
  "message": "Login successful.",
  "data": {
    "token": "<SIGNED_JWT>",
    "tokenType": "Bearer",
    "expiresIn": "1h",
    "user": {
      "id": "e22a15b4-cad5-4e16-b26b-fd6ba109f203",
      "username": "buyer01",
      "email": "buyer@example.com",
      "role": "Buyer"
    }
  }
}
```

### `GET /api/auth/me`

Requires a valid token. Available to every authenticated role.

```http
Authorization: Bearer <SIGNED_JWT>
```

Success (`200`):

```json
{
  "success": true,
  "message": "Authenticated user profile.",
  "data": {
    "user": {
      "id": "e22a15b4-cad5-4e16-b26b-fd6ba109f203",
      "username": "buyer01",
      "email": "buyer@example.com",
      "role": "Buyer"
    }
  }
}
```

### `GET /api/auth/seller-panel`

Requires a valid token and the `Seller` or `Admin` role. Other authenticated roles receive `403`.

Success (`200`):

```json
{
  "success": true,
  "message": "Seller panel access granted.",
  "data": {
    "user": {
      "id": "e22a15b4-cad5-4e16-b26b-fd6ba109f203",
      "username": "seller01",
      "email": "seller@example.com",
      "role": "Seller"
    },
    "panel": "seller"
  }
}
```

### `GET /api/auth/admin-dashboard`

Requires a valid token and the `Admin` role exclusively. Other authenticated roles receive `403`.

Success (`200`):

```json
{
  "success": true,
  "message": "Admin dashboard access granted.",
  "data": {
    "user": {
      "id": "e22a15b4-cad5-4e16-b26b-fd6ba109f203",
      "username": "admin01",
      "email": "admin@example.com",
      "role": "Admin"
    },
    "dashboard": "admin"
  }
}
```

## Testing with Postman or Thunder Client

1. Start the service with `npm start`.
2. Send `POST http://localhost:5000/api/auth/register` with JSON body and `Content-Type: application/json`.
3. Send `POST http://localhost:5000/api/auth/login` with the new account credentials and copy `data.token`.
4. Call `/api/auth/me`, `/api/auth/seller-panel`, or `/api/auth/admin-dashboard` with `Authorization: Bearer <SIGNED_JWT>`.
5. To exercise Seller or Admin routes, set a valid `ROLE_PROVISIONING_KEY` in `.env` and add the `X-Role-Provisioning-Key` header to that role's registration request.

Run the automated integration tests with:

```bash
npm test
```

## Operational security notes

- Use a unique, randomly generated JWT secret and separate role-provisioning key in production.
- Configure `CORS_ORIGIN` to the actual trusted frontend origins instead of `*`.
- Terminate TLS at a trusted ingress or reverse proxy and use secure deployment secrets.
- The in-memory adapter and single-instance rate-limit store are not suitable for horizontally scaled production deployments. Use a durable database, audited privileged-role provisioning workflow, and a shared rate-limit store before production use.

## Acceptance criteria and evidence

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Registration validation, unique username/email, password hashing, and Buyer default | `controllers/authController.js`, `models/userModel.js` | `npm test`: default role and duplicate registration tests |
| Only provisioned Sellers/Admins receive privileged roles | `controllers/authController.js` | `npm test`: rejects Seller registration without key; permits provisioned Seller/Admin |
| Username/email login and one-hour configurable JWT | `controllers/authController.js`, `config/jwtConfig.js` | `npm test`: successful username and email login; token checked by protected API |
| Bearer token verification, profile route, Seller/Admin role policy | `middleware/authMiddleware.js`, `middleware/roleMiddleware.js`, `routes/authRoutes.js` | `npm test`: unauthenticated and unauthorized responses; authorized Seller/Admin responses |
| Helmet, CORS, request rate limiting, request logging, centralized JSON errors | `server.js`, `middleware/rateLimiter.js`, `middleware/errorMiddleware.js` | Server startup smoke check; integration suite asserts standardized success and error structures |
| Installation, environment setup, API examples, and manual API-client workflow | This README | Follow the installation and demo steps above |

## Reproducible mentor demonstration

Use a clean terminal in the project directory:

```bash
npm ci
cp .env.example .env
```

Replace the example secrets in `.env` with random values (at least 32 characters each), then start the service:

```bash
npm start
```

In a second terminal, verify readiness:

```bash
curl --fail http://localhost:5000/
```

Create and authenticate a Buyer:

```bash
curl --fail -X POST http://localhost:5000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo-buyer","email":"demo-buyer@example.com","password":"demo-password-123"}'

curl --fail -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo-buyer","password":"demo-password-123"}'
```

Copy `data.token` from the login response, then use it as the Bearer token:

```bash
curl --fail http://localhost:5000/api/auth/me \
  -H 'Authorization: Bearer <SIGNED_JWT>'
```

Buyer access to Seller/Admin endpoints should return `403`. To demonstrate Seller and Admin access, register either role with the `X-Role-Provisioning-Key` header and the key configured in `.env`, log in as that user, and repeat the protected route calls. The process-local user store starts empty and resets when the service stops.

Run the automated validation suite:

```bash
npm test
npm audit --omit=dev
```

### Validation record

The implementation was validated with the following checks during this submission:

- `npm test` — passed; covered registration/default Buyer, duplicate rejection, login, protected route permissions, and privileged-role provisioning.
- `node --check` on application, middleware, model, configuration, route, and test JavaScript files — passed.
- `git diff --check` — passed.
- `npm audit --omit=dev` — reported zero vulnerabilities at the time of check.
- Live startup smoke check — passed; `GET /` returned HTTP 200 and the success readiness payload.

Re-run the commands above when reviewing a fresh checkout; the validation record documents checks performed, not a guarantee about future dependency versions or deployment configuration.

## Design decisions, limitations, and next steps

- **Small modular service:** CommonJS and the built-in Node test runner avoid extra tooling while keeping controller, model, middleware, routes, and configuration responsibilities separate.
- **Role provisioning:** public registration creates Buyers; an out-of-band shared provisioning key is required for Seller/Admin registration so callers cannot self-promote. In a larger system, replace this bootstrap mechanism with an audited, authenticated administrator workflow or invitation process.
- **Persistence:** the in-memory adapter has no durability, cross-process uniqueness, or multi-instance sharing. Replace it with a database that enforces unique indexes/constraints and use migrations.
- **Token lifecycle:** access JWTs are stateless and cannot be revoked before expiry. Add refresh-token rotation, revocation/session tracking, and key rotation if product requirements need them.
- **Rate limiting:** the current default limiter uses process-local storage. Deploy a shared store behind a trusted proxy and configure Express proxy trust explicitly for multi-instance deployments.
- **Operations:** configure restrictive production CORS origins, TLS, managed secrets, structured centralized logging, monitoring, and graceful shutdown before public deployment.
- **Validation scope:** integration tests cover core registration/authentication/RBAC paths but are not a substitute for database integration, load testing, deployment testing, or a formal security review.
