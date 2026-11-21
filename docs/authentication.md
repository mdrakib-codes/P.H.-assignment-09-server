# Authentication Status

## Current State

BetterAuth is intentionally postponed. This backend does not implement:

- user sign-up or sign-in routes;
- BetterAuth MongoDB adapter setup;
- JWT issuance or verification;
- cookie/session verification;
- `verifyToken`, `verifyCustomer`, `verifyTechnician` or `verifyAdmin` middleware;
- fake login endpoints or temporary identity headers;
- frontend authentication flows.

No production private API is mounted. The default app mounts only health, public services and the Stripe webhook.

Demo seed users are canonical `users` profile records only. The seed creates no passwords, sessions, accounts, verifications or login credentials, and no demo password should be claimed until BetterAuth integration exists.

## Private Route Guard Contract

Private routes are implemented as factories requiring an injected `requireActor` function:

- `createBookingRoutes`
- `createTechnicianServiceRoutes`
- `createTechnicianBookingRoutes`
- `createAdminRoutes`
- `createPaymentRoutes`

The factory fails closed if no `requireActor` is supplied. Tests inject a controlled middleware that sets `req.actor`; production code does not provide one.

A valid actor must contain:

- `id`: ObjectId or 24-hex string;
- `email`: normalized email;
- `role`: `customer`, `technician` or `admin`;
- `name`: non-empty string.

Missing or malformed actor returns `401 UNAUTHORIZED`.

## Canonical Identity Checks

Controllers call `requireCanonicalActor`, which verifies `req.actor` against the canonical `users` collection:

- a matching user must exist by normalized email;
- actor role must match the user role;
- actor ID must equal `users._id`;
- email normalization must match.

Mismatch returns `403 FORBIDDEN`. Role-specific controllers then apply additional ownership checks:

- customers can only view/cancel/pay for their own bookings;
- technicians can only edit their own services and assigned bookings;
- admins cannot change their own role;
- payment verification also checks Stripe metadata email against the canonical customer.

Identity headers, request body fields and query fields are never trusted for identity or role. Query overrides such as `customerEmail`, `technicianEmail`, `amount` and `revenue` are stripped.

## Why Private Routes Are Unmounted

Mounting private routes without real authentication would expose them or require a fake actor. Both are unacceptable. The routes therefore remain unmounted until a trusted authentication layer exists.

In the default app, unmounted private paths return `404 ROUTE_NOT_FOUND`. The one caveat is `GET /api/services/technician`, which is matched by public `GET /api/services/:id` and returns `400 INVALID_OBJECT_ID`.

## Future Integration Requirements

To expose private routes safely, an approved follow-up must:

1. Implement real BetterAuth authentication with MongoDB persistence.
2. Verify the authenticated session/cookie/JWT on the backend.
3. Map the authenticated user to a canonical `users` record.
4. Provide a trusted `requireActor` middleware that populates `req.actor` only from verified server-side identity.
5. Mount the private factories with that middleware.
6. Align frontend cookie/CORS/credentials behavior with `src/config/cors.js`.
7. Add live integration tests for login, role changes, protected routes and ownership boundaries.
8. Keep the existing canonical identity checks; do not replace them with client-supplied identity.

No fake identity bypass should be added for convenience.

## Test Evidence

- `tests/route-boundary.test.js`: verifies mounted surface, unmounted private routers and factory fail-closed behavior.
- `tests/booking-api.test.js`: customer role and ownership checks.
- `tests/technician-service.test.js`: technician service ownership.
- `tests/technician-booking.test.js`: assigned technician checks.
- `tests/admin-api.test.js`: admin role checks and self-role-change prevention.
- `tests/payment-checkout.test.js`: canonical customer actor checks for checkout.
- `tests/payment-webhook.test.js`: customer ownership and metadata checks for verification.
