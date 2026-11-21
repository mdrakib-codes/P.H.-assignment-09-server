# Demo Seed Data

## Purpose

The demo seed creates realistic local/demo data for manual verification. It is an operator-only script and is never invoked by server startup.

Script: `scripts/seed-demo-data.js`.
Dataset module: `src/seeds/demo.seed.js`.

## Dataset

| Collection | Seeded records |
|---|---|
| `users` | 6: one admin, two technicians and three customers |
| `services` | 14 approved available services covering all seven categories |
| `bookings` | 6 bookings: `requested`, `accepted`, `in-progress`, `completed`, `rejected` and `cancelled` |
| `payments` | 0; no fake Stripe transaction or payment record is created |

Service ownership references the two seeded technicians. Booking service snapshots reference seeded services, and booking customer/technician emails reference seeded users.

Example demo identities:

| Role | Email |
|---|---|
| Admin | `admin@fixmate.demo` |
| Technician | `technician.maya@fixmate.demo` |
| Technician | `technician.noah@fixmate.demo` |
| Customer | `customer.olivia@fixmate.demo` |

These users are canonical `users` profile records only. This repository does not implement BetterAuth, passwords, session records, account records or login routes. No demo password is claimed, and no authentication credential is stored by the seed.

## Commands

Dry-run is the default and reports the plan without writing:

```bash
node scripts/seed-demo-data.js
```

Apply requires all three flags:

```bash
node scripts/seed-demo-data.js --apply --confirm SEED_DEMO_DATA --allow-development
```

`--allow-development` is an explicit acknowledgement that the target is a development/demo database. It does not weaken the environment checks.

## Safety Behavior

- Never runs during `npm start`, `npm run dev` or HTTP startup.
- Rejects `NODE_ENV=production`.
- Rejects Atlas URIs (`mongodb+srv://` or `*.mongodb.net`).
- Dry-run is the default; writes require `--apply`.
- Apply also requires `--confirm SEED_DEMO_DATA` and `--allow-development`.
- Validates every document with the same Zod schemas used by the application before preflight or writes.
- Uses fixed ObjectIds so repeated runs are stable and relationships remain consistent.
- Checks `_id` and natural keys (`email`, service title plus technician email, and active booking customer plus service) before writing.
- Aborts on any validation or conflict error before inserting records.
- Uses `updateOne(..., { $setOnInsert: document }, { upsert: true })` only for missing records; it never deletes, drops, replaces or overwrites existing data.
- Rechecks after apply and reports success only when all seed records are present with no conflicts.
- Never logs `MONGODB_URI`; database error text is passed through secret redaction.

Booking preferred dates are generated relative to the run date so they remain valid calendar dates. A rerun skips previously seeded bookings rather than rewriting their stored dates.

## Limitations

- No live MongoDB or Atlas database was accessed while implementing or testing this seed.
- Login-ready demo credentials require a future BetterAuth integration that creates secure account records outside this repository.
- The seed is intended for development/demo databases only.

## Test Evidence

`tests/seed.test.js` covers dataset validity, deterministic IDs, dry-run non-destruction, apply guards, conflict aborts, idempotency, payment exclusion, CLI guards and injected-module execution.
