# FixMate Backend

FixMate is a service-booking platform backend built as a standalone Express API with MongoDB persistence and Stripe checkout/webhook integration. This repository contains only the backend. The Next.js frontend and BetterAuth integration are intentionally postponed and are not implemented here.

Current stage: S9-E final backend audit, documentation, demo seed data and completion verification. The isolated test suite passes locally. Live MongoDB/Atlas, Stripe, deployment and browser verification have not been performed and remain external requirements.

## Technology Stack

- Node.js `>=20`, ESM
- Express `5.x`
- MongoDB driver `7.x`
- Zod `4.x`
- Stripe SDK `23.x`
- dotenv, cors
- Node built-in test runner

## Repository Layout

```text
fixmate-server/
├── docs/
│   ├── active-booking-migration.md
│   ├── api.md
│   ├── authentication.md
│   ├── compliance.md
│   ├── database.md
│   ├── environment.md
│   ├── seed-data.md
│   └── stripe.md
├── scripts/
│   ├── migrate-active-booking-duplicates.js
│   └── seed-demo-data.js
├── src/
│   ├── app.js
│   ├── config/
│   ├── controllers/
│   ├── db/
│   ├── middleware/
│   ├── repositories/
│   ├── routes/
│   ├── seeds/
│   ├── server/
│   ├── utils/
│   └── validators/
├── tests/
├── server.js
├── package.json
└── .env.example
```

## Installation

```bash
npm install
cp .env.example .env
```

Edit `.env` with safe local values. `MONGODB_URI` is required. `.env` is ignored by Git; never commit credentials. See [docs/environment.md](docs/environment.md) for every supported variable.

## Development Commands

```bash
npm run dev     # node --watch server.js
npm start       # node server.js
npm test        # node --test "tests/*.test.js"
node scripts/seed-demo-data.js                                             # dry-run
node scripts/seed-demo-data.js --apply --confirm SEED_DEMO_DATA --allow-development
```

Tests use isolated in-memory fixtures and Stripe SDK mocks. They do not require live MongoDB, Atlas, Stripe or production services. Do not place real credentials in `.env` when running tests.

## API Overview

The default app mounts only:

| Endpoint | Status |
|---|---|
| `GET /api/health` | Public |
| `GET /api/health/live` | Public |
| `GET /api/services` | Public |
| `GET /api/services/:id` | Public |
| `POST /api/payments/webhook` | Mounted Stripe webhook; signature-verified |

The following implemented private route factories exist but are intentionally **not mounted** in the default app until real authentication middleware is available:

- Customer bookings: `POST /api/bookings`, `GET /api/bookings/my`, `PATCH /api/bookings/:id/cancel`
- Technician services: `POST /api/services`, `GET /api/services/technician`, `PATCH /api/services/:id`, `PATCH /api/services/:id/availability`, `DELETE /api/services/:id`
- Technician bookings: `GET /api/bookings/technician`, `PATCH /api/bookings/:id/status`
- Admin: `GET /api/admin/users`, `PATCH /api/admin/users/:id/role`, `GET /api/admin/services`, `PATCH /api/admin/services/:id/approval`, `GET /api/admin/bookings`, `GET /api/admin/payments`
- Profile: `PATCH /api/users/profile`
- ImgBB upload: `POST /api/uploads/imgbb`
- Payments: `POST /api/payments/create-checkout-session`, `GET /api/payments/verify`

See [docs/api.md](docs/api.md) for complete endpoint contracts.

## Database Setup

The server uses four collections: `users`, `services`, `bookings`, `payments`. Collection/index initialization runs during startup before HTTP listening. Invalid indexes or duplicate active bookings can therefore fail startup before traffic is accepted.

See [docs/database.md](docs/database.md) for fields, indexes, active-booking protection and migration safety. The duplicate-booking migration is operator-only and must never be run against live production as part of this workflow.

## Demo Seed Data

The operator-only seed creates one admin, two technicians, three customers, 14 approved services across all categories, six bookings in different statuses and no payment records. It defaults to a dry-run and requires `--apply --confirm SEED_DEMO_DATA --allow-development` to write. It rejects production and Atlas targets, validates every document, aborts on conflicts, uses deterministic IDs and never overwrites existing records.

See [docs/seed-data.md](docs/seed-data.md) for accounts, commands, safety behavior and the BetterAuth credential limitation.

## Stripe Setup

Production requires both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Checkout amounts are derived from `bookings.finalAmount`; client amount/currency fields are rejected. Webhook events are verified using the raw request body and `stripe-signature`.

`/payment/success` and `/payment/cancel` are frontend redirects, not backend endpoints. Backend verification uses `GET /api/payments/verify?session_id=...`.

See [docs/stripe.md](docs/stripe.md) for details and local test procedures.

## ImgBB Setup

The server reads `IMGBB_API_KEY` from validated environment configuration. Keep it out of client code and version control. The upload route is private and unmounted until real authentication is available; when deployed, missing configuration and upstream failures fail closed with sanitized responses. See [docs/environment.md](docs/environment.md) and [docs/api.md](docs/api.md).

## Security Notes

- CORS uses an exact allowlist built from `CLIENT_ORIGIN`/`CLIENT_ORIGINS`.
- Security headers are always applied; HSTS is emitted only in production behind a trusted HTTPS proxy.
- Rate limiting is in-memory and per process; shared/external rate limiting is required for multi-instance deployments.
- Secrets in logs and URLs are redacted.
- Private controllers re-verify actor role, canonical email and database ID from `users`; they never trust identity headers, body or query values.
- JSON bodies are limited to 1 MB and multipart upload bodies to 6 MB; malformed JSON, oversized payloads and unknown routes return consistent JSON errors.
- ImgBB uploads validate MIME type, extension and magic bytes; the API key stays server-side and provider tests are mocked.

## Authentication Status

BetterAuth is intentionally postponed. No login, JWT issuance, cookie/session verification or fake authentication bypass exists in this backend. Private route factories require a verified `req.actor` injector and remain unmounted from the default app. See [docs/authentication.md](docs/authentication.md).

## Deployment Considerations

Before deployment, an approved external procedure must verify:

- MongoDB/Atlas connectivity, index creation and unique-index enforcement.
- Production CORS origins and `TRUST_PROXY`.
- Stripe test/live keys, webhook endpoint and signing secret.
- ImgBB key, outbound HTTPS access and upload size/mime policy when the route is mounted.
- Shared rate limiting if running multiple server instances.
- HTTPS proxy behavior for HSTS and secure redirects.
- Any approved duplicate-booking migration against a non-production database first.
- Deployment URLs, uptime and absence of production CORS/404/504 errors.

No live production verification is claimed by this repository or this stage.

## Documentation

- [API documentation](docs/api.md)
- [Environment configuration](docs/environment.md)
- [Database and migration](docs/database.md)
- [Demo seed data](docs/seed-data.md)
- [Stripe workflow](docs/stripe.md)
- [Authentication status](docs/authentication.md)
- [Assignment compliance](docs/compliance.md)
- [Active booking migration procedure](docs/active-booking-migration.md)
