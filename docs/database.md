# Database Documentation

## Connection And Initialization

- MongoDB is accessed only by the backend.
- `MONGODB_URI` is required; the database name is derived from the URI path with `fixmate` as the default.
- Initialization runs before the HTTP server listens. Startup fails fast if collections or indexes cannot be prepared.
- Collection names are defined in `src/db/collections.js`; index definitions live in `src/db/indexes.js`; initialization is orchestrated by `src/db/initialize.js` and `src/db/index.js`.

## Collections

### `users`

| Field | Type / notes |
|---|---|
| `_id` | ObjectId |
| `name` | Required trimmed string |
| `email` | Required normalized lowercase email |
| `image` | Optional HTTP(S) URL |
| `role` | `customer`, `technician` or `admin`; default `customer` |
| `phone`, `area`, `bio` | Optional trimmed strings; default `''` |
| `createdAt`, `updatedAt` | Dates |

Canonical actor lookup is by normalized email. Admin projections exclude secrets. Public creation strips client-supplied roles and applies a safe public role.

### `services`

| Field | Type / notes |
|---|---|
| `_id` | ObjectId |
| `title`, `description`, `estimatedDuration`, `serviceArea` | Required trimmed strings |
| `category` | `Smartphone`, `Laptop & PC`, `AC`, `Refrigerator`, `TV`, `Washing Machine`, `Electrical` |
| `image` | HTTP(S) URL |
| `basePrice` | Positive finite number |
| `serviceMode` | `Home Visit` or `Shop Drop-off` |
| `technicianName`, `technicianEmail` | Snapshot of owning technician identity |
| `approvalStatus` | `pending`, `approved` or `rejected`; default `pending` |
| `isAvailable` | Boolean; default `true` |
| `createdAt`, `updatedAt` | Dates |

Public reads require `approvalStatus: "approved"` and `isAvailable: true`. Technician updates reset approval to `pending`.

### `bookings`

| Field | Type / notes |
|---|---|
| `_id` | ObjectId |
| `serviceId` | ObjectId referencing `services._id` |
| `serviceTitle`, `serviceImage`, `category`, `basePrice`, `technicianName`, `technicianEmail` | Service snapshots |
| `customerName`, `customerEmail`, `customerPhone`, `address` | Customer snapshots/details |
| `preferredDate` | `YYYY-MM-DD`, real calendar date, today or future |
| `problemDescription` | Trimmed string, minimum 20 characters |
| `status` | `requested`, `accepted`, `rejected`, `in-progress`, `completed`, `cancelled`; default `requested` |
| `finalAmount` | Positive finite number; defaults to service `basePrice` |
| `paymentStatus` | `unpaid` or `paid`; default `unpaid` |
| `createdAt`, `updatedAt` | Dates |

Bookings snapshot service and customer details so later service edits/deletions do not rewrite history. Active statuses are `requested`, `accepted` and `in-progress`.

### `payments`

| Field | Type / notes |
|---|---|
| `_id` | ObjectId |
| `bookingId` | ObjectId referencing `bookings._id` |
| `serviceTitle`, `customerName`, `customerEmail`, `technicianName`, `technicianEmail` | Snapshots |
| `amount` | Positive finite number |
| `currency` | `usd` |
| `transactionId` | Stripe payment intent ID or session ID |
| `stripeSessionId` | `cs_test_*` or `cs_live_*`, maximum 255 characters |
| `paymentStatus` | `paid` |
| `paidAt`, `createdAt`, `updatedAt` | Dates |

Payment records are persisted by checkout verification and webhook fulfillment. Response projections intentionally omit `transactionId`, `stripeSessionId` and customer email.

## Relationships

```text
users (technician) ──< services.technicianEmail
services ──< bookings.serviceId
users (customer) ──< bookings.customerEmail
bookings ──< payments.bookingId
```

## Indexes

| Collection | Index | Definition | Notes |
|---|---|---|---|
| `users` | `user_email_uidx` | `{ email: 1 }` | Unique |
| `users` | `user_role_idx` | `{ role: 1 }` | Role filtering |
| `services` | `services_public_listing_idx` | `{ approvalStatus: 1, isAvailable: 1, serviceMode: 1, createdAt: -1 }` | Public listing |
| `services` | `services_category_idx` | `{ category: 1, approvalStatus: 1, isAvailable: 1 }` | Category filtering |
| `services` | `services_technician_email_idx` | `{ technicianEmail: 1, createdAt: -1 }` | Technician lists |
| `bookings` | `bookings_customer_email_idx` | `{ customerEmail: 1, createdAt: -1 }` | Customer lists |
| `bookings` | `bookings_technician_email_status_idx` | `{ technicianEmail: 1, status: 1, createdAt: -1 }` | Technician lists |
| `bookings` | `bookings_service_active_idx` | `{ serviceId: 1, customerEmail: 1, status: 1 }` | Active-booking checks |
| `bookings` | `bookings_active_customer_service_uidx` | `{ customerEmail: 1, serviceId: 1 }` | Unique partial for active statuses |
| `bookings` | `bookings_status_payment_idx` | `{ status: 1, paymentStatus: 1 }` | Status/payment filtering |
| `bookings` | `bookings_created_at_idx` | `{ createdAt: -1 }` | Recent bookings |
| `payments` | `payments_booking_id_uidx` | `{ bookingId: 1 }` | Unique partial where `bookingId` is ObjectId |
| `payments` | `payments_stripe_session_id_uidx` | `{ stripeSessionId: 1 }` | Unique partial where value is string |
| `payments` | `payments_transaction_id_idx` | `{ transactionId: 1 }` | Transaction lookup |
| `payments` | `payments_created_at_idx` | `{ createdAt: -1 }` | Recent payments |

`bookings_active_customer_service_uidx` uses:

```js
{
  unique: true,
  partialFilterExpression: {
    status: { $in: ['requested', 'accepted', 'in-progress'] }
  },
  collation: { locale: 'en', strength: 2 }
}
```

## Active-Booking Protection

The application checks for an existing active booking before insert, but the database unique partial index is the authoritative concurrency guard. Duplicate key error `11000` is translated to `409 DUPLICATE_ACTIVE_BOOKING`.

Both checks are required: the pre-check gives a clear response, while the unique index prevents two simultaneous requests from both succeeding.

## Duplicate-Booking Migration

Script: `scripts/migrate-active-booking-duplicates.js`. Procedure: `docs/active-booking-migration.md`.

Key behavior:

- Dry-run is the default.
- Apply requires `--apply --confirm CANCEL_DUPLICATE_BOOKINGS`.
- Suspicious records abort the migration.
- Canonical selection priority: `in-progress`, then `accepted`, then `requested`; ties use earliest valid `createdAt`, then lowest `_id`.
- Only duplicate records are conditionally updated to `cancelled`; there are no broad updates.
- The script refuses Atlas URIs (`mongodb+srv://` or `*.mongodb.net`).
- Re-detection after apply must show zero groups, suspicious records and skipped records.
- Never add this migration to server startup.
- Pause booking writes from cleanup through index verification. If index creation fails, keep writes paused until resolved.

This migration is operator-only. It must be rehearsed on non-production data before any approved production procedure.

## Demo Seed Data

Script: `scripts/seed-demo-data.js`. Dataset module: `src/seeds/demo.seed.js`. Procedure: [seed-data.md](seed-data.md).

Key behavior:

- Creates one admin, two technicians, three customers, 14 approved services across all categories, six bookings in all supported booking statuses and zero payment records.
- Uses fixed ObjectIds and stable relationships; reruns skip existing seed records instead of rewriting them.
- Never runs during server startup.
- Dry-run is the default.
- Apply requires `--apply --confirm SEED_DEMO_DATA --allow-development`.
- Rejects `NODE_ENV=production` and Atlas URIs.
- Validates every document with application Zod schemas before preflight or writes.
- Aborts on `_id` conflicts, natural-key conflicts and validation errors.
- Uses `$setOnInsert` upserts only; it never deletes, drops, replaces or overwrites existing data.
- Rechecks after apply and reports success only when the full dataset is present.

Seeded users are canonical profile records only. No passwords, sessions, accounts or BetterAuth records are created.

## Test Evidence

- `tests/database-foundation.test.js`: collections, indexes, bounded initialization ping and shutdown behavior.
- `tests/active-booking-migration.test.js`: duplicate detection, dry-run/apply guards, canonical selection and re-detection.
- `tests/seed.test.js`: dataset validity, deterministic IDs, dry-run/apply guards, conflict aborts, idempotency and CLI safety.
- `tests/booking-api.test.js`: duplicate active booking rejection including impossible-date protection.
- `tests/repository.test.js`: repository behavior and error mapping.
