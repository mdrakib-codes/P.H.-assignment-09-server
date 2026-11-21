# API Documentation

## Base URL

Local default: `http://localhost:5000/api`

The default Express app mounts only health, public service and Stripe webhook routes. Private route factories are implemented but intentionally unmounted until real authentication is available.

## Response Envelopes

Success:

```json
{ "success": true, "message": "Operation completed.", "data": {} }
```

Actual payload keys are spread directly into the response alongside `success` and `message`; there is no universal `data` wrapper.

Error:

```json
{
  "success": false,
  "message": "Request could not be completed.",
  "error": { "code": "ERROR_CODE", "details": [] }
}
```

A paginated response has this shape:

```json
{
  "success": true,
  "message": "Items retrieved successfully.",
  "items": [],
  "total": 0,
  "page": 1,
  "limit": 20,
  "totalPages": 0
}
```

## Common Status Codes

| Code | Meaning |
|---|---|
| `400` | Invalid input/query/path/malformed JSON |
| `401` | Missing or invalid actor |
| `403` | Role/ownership mismatch or disallowed CORS origin |
| `404` | Resource not found or hidden for ownership privacy |
| `409` | Conflict, duplicate, invalid state or payment reconciliation conflict |
| `413` | Payload exceeds the configured body limit (1 MB JSON, 6 MB multipart upload) |
| `422` | Raw schema validation error |
| `429` | Rate limit exceeded; numeric `Retry-After` header |
| `500` | Sanitized unexpected/internal error |
| `503` | Health readiness or provider configuration failure |

Server errors are sanitized to `500 INTERNAL_SERVER_ERROR` with no details. `GET /api/health` preserves `503 SERVICE_UNAVAILABLE` with readiness details.

## Mount Status

| Group | Full base path | Default mount |
|---|---|---|
| Health | `/api/health` | Yes |
| Public services | `/api/services` | Yes |
| Stripe webhook | `/api/payments/webhook` | Yes |
| Customer bookings | `/api/bookings` | No; private factory |
| Technician services | `/api/services` | No; private factory |
| Technician bookings | `/api/bookings` | No; private factory |
| Admin | `/api/admin` | No; private factory |
| User profile | `/api/users` | No; private factory |
| ImgBB upload | `/api/uploads` | No; private factory |
| Payment checkout/verify | `/api/payments` | No; private factory |

Unmounted private routes return `404 ROUTE_NOT_FOUND` in the default app. Exception: `GET /api/services/technician` matches public `GET /api/services/:id` first and returns `400 INVALID_OBJECT_ID`.

## Actor Contract For Private Routes

Private route factories require an injected `requireActor` middleware. A valid actor must contain an ObjectId/24-hex `id`, normalized `email`, role (`customer`, `technician` or `admin`) and non-empty `name`. Missing/invalid actor returns `401 UNAUTHORIZED`.

Controllers then verify the actor against the canonical `users` collection by email: role, normalized email and database ID must match. Mismatch returns `403 FORBIDDEN`. Identity headers, request body and query parameters are never trusted for role or ownership.

The profile endpoint and upload endpoint accept any canonical role and derive authorization only from the verified actor's canonical database `_id`. They do not accept an id, email, role or other identity field from the request.

## Mounted Endpoints

### `GET /api/health`

- Access: public.
- Input: none.
- `200`: `{ success: true, message: "FixMate server is ready.", status: "ok", database: "connected", state, timestamp }`
- `503`: `{ success: false, message: "FixMate server is not ready.", error: { code: "SERVICE_UNAVAILABLE", details: { status: "unavailable", database, state, timestamp } } }`
- Behavior: pings MongoDB with a bounded timeout.

### `GET /api/health/live`

- Access: public.
- Input: none.
- `200`: `{ success: true, message: "FixMate server is alive.", status: "ok", timestamp }`
- Behavior: liveness only; no database check.

### `GET /api/services`

- Access: public.
- Query: `page` (default 1, max 1000), `limit` (default 20, max 100), `search` (max 100), `category`, `serviceMode`, `sort` (`newest`, `price-asc`, `price-desc`; default `newest`). Unknown query keys are rejected.
- `200`: paginated public service projections.
- Errors: `400 INVALID_QUERY`.
- Behavior: only `approvalStatus: "approved"` and `isAvailable: true` services are returned. Search is escaped and case-insensitive across title/category/description.

### `GET /api/services/:id`

- Access: public.
- Path: `id` must be an ObjectId or 24-hex string.
- `200`: `{ success: true, message: "Service retrieved successfully.", service: { ...publicService, technician: { name, image, area, bio } } }`
- Errors: `400 INVALID_OBJECT_ID`; `404 NOT_FOUND` if missing, unapproved or unavailable.

### `POST /api/payments/webhook`

- Access: Stripe signature only; no user actor.
- Mount: raw JSON parser before `express.json()`.
- Input: raw JSON body and `stripe-signature` header.
- `200`: `{ success: true, message: "Webhook processed successfully.", received: true, ignored: <boolean> }`
- Errors: `400 INVALID_WEBHOOK_BODY`, `MISSING_STRIPE_SIGNATURE`, `INVALID_STRIPE_SIGNATURE`, `INVALID_WEBHOOK_EVENT`; `429 RATE_LIMIT_EXCEEDED`; `503` when webhook configuration is missing.
- Behavior: only `checkout.session.completed` and `checkout.session.async_payment_succeeded` are fulfilled. Unsupported or unpaid sessions are ignored.

## Private User Profile Endpoints

### `PATCH /api/users/profile`

- Access: any canonical verified actor (`customer`, `technician` or `admin`); own profile only.
- Mount: implemented as a private factory and intentionally unmounted from the default app pending BetterAuth integration.
- Body: strict optional `{ name?, image?, phone?, area?, bio? }`; at least one field is required. `image` is the profile photo URL.
- Validation: strings are trimmed; `image` must be an HTTP(S) URL; unknown and protected fields such as `role`, `email`, `_id`, `createdAt`, `updatedAt`, status and authentication fields are rejected.
- `200`: `{ success: true, message: "Profile updated successfully.", user }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_PROFILE_UPDATE`, `INVALID_UPDATE`; `404 NOT_FOUND`.
- Behavior: updates only supplied fields, sets `updatedAt` on the server and returns the safe projection `_id`, `name`, `email`, `image`, `role`, `phone`, `area`, `bio`, `createdAt`, `updatedAt`.

## Private ImgBB Upload Endpoint

### `POST /api/uploads/imgbb`

- Access: any canonical verified actor; actor is verified before the multipart body is parsed.
- Mount: implemented as a private factory and intentionally unmounted from the default app pending BetterAuth integration.
- Input: `multipart/form-data` with exactly one file field named `image`.
- Accepted formats: JPEG (`.jpg`, `.jpeg`), PNG (`.png`), WebP (`.webp`) and GIF (`.gif`).
- Validation: declared MIME type, file extension and magic-byte signature must agree; other fields/files are rejected; filename path separators are stripped; maximum file size is 5 MB and multipart body limit is 6 MB.
- `200`: `{ success: true, message: "Image uploaded successfully.", image: { url, width?, height?, size? } }`
- Errors: `400 INVALID_UPLOAD_INPUT`; `401 UNAUTHORIZED`; `403 FORBIDDEN`; `404 ROUTE_NOT_FOUND` in the default app; `413 PAYLOAD_TOO_LARGE`; `503` sanitized provider configuration/rate-limit failure; `502`/`500` sanitized upstream failure.
- Behavior: the ImgBB key is read only from validated server environment configuration, sent only in the outbound form, and never returned in responses or logs. Provider calls use a 10-second timeout. Tests inject a mocked provider and make no external calls.

## Private Customer Booking Endpoints

### `POST /api/bookings`

- Actor: canonical `customer`; snapshots customer name/email from `users`.
- Body: strict `{ serviceId, customerPhone, address, preferredDate, problemDescription }`.
  - `preferredDate`: `YYYY-MM-DD`, real date, today or future.
  - `problemDescription`: trimmed, minimum 20 characters.
- `201`: `{ success: true, message: "Booking created successfully.", booking }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`, `403 SELF_BOOKING_NOT_ALLOWED`; `400 INVALID_BOOKING_INPUT`; `404 NOT_FOUND`; `409 DUPLICATE_ACTIVE_BOOKING`.
- Behavior: creates `status: "requested"`, `finalAmount = service.basePrice`, `paymentStatus: "unpaid"`.

### `GET /api/bookings/my`

- Actor: canonical `customer`.
- Query: pagination, `status`, `paymentStatus`; email overrides are stripped.
- `200`: paginated bookings for the canonical customer email.
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_QUERY`.

### `PATCH /api/bookings/:id/cancel`

- Actor: canonical `customer`.
- Path: booking ObjectId. No body.
- `200`: `{ success: true, message: "Booking cancelled successfully.", booking }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_OBJECT_ID`; `404 NOT_FOUND`; `409 BOOKING_CANNOT_BE_CANCELLED`.
- Behavior: only an owned `requested` booking can be cancelled.

## Private Technician Service Endpoints

### `POST /api/services`

- Actor: canonical `technician`.
- Body: strict `{ title, category, description, image, basePrice, estimatedDuration, serviceMode, serviceArea }`.
- `201`: `{ success: true, message: "Service created successfully.", service }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_SERVICE_INPUT`.
- Behavior: forces `approvalStatus: "pending"` and `isAvailable: true`.

### `GET /api/services/technician`

- Actor: canonical `technician`.
- Query: pagination, `approvalStatus`; `technicianEmail` overrides are stripped.
- `200`: paginated private service projections for the canonical technician.
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_QUERY`.

### `PATCH /api/services/:id/availability`

- Actor: owning technician.
- Body: strict `{ isAvailable: boolean }`.
- `200`: `{ success: true, message: "Service availability updated successfully.", service }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_OBJECT_ID`, `INVALID_AVAILABILITY`; `404 NOT_FOUND`.

### `PATCH /api/services/:id`

- Actor: owning technician.
- Body: strict optional subset of the eight service creation fields.
- `200`: `{ success: true, message: "Service updated successfully.", service }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_OBJECT_ID`, `INVALID_SERVICE_UPDATE`, `INVALID_UPDATE`; `404 NOT_FOUND`.
- Behavior: any update resets `approvalStatus` to `pending`.

### `DELETE /api/services/:id`

- Actor: owning technician.
- `200`: `{ success: true, message: "Service deleted successfully." }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_OBJECT_ID`; `404 NOT_FOUND`.

## Private Technician Booking Endpoints

### `GET /api/bookings/technician`

- Actor: canonical `technician`.
- Query: pagination, `status`, `paymentStatus`; email overrides are stripped.
- `200`: paginated bookings assigned to the canonical technician.
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_QUERY`.

### `PATCH /api/bookings/:id/status`

- Actor: assigned technician.
- Body: strict `{ status, finalAmount? }`.
- `200`: `{ success: true, message: "Booking status updated successfully.", booking }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_OBJECT_ID`, `INVALID_BOOKING_UPDATE`, `FINAL_AMOUNT_REQUIRED`, `FINAL_AMOUNT_NOT_ALLOWED`; `404 NOT_FOUND`; `409 INVALID_STATUS_TRANSITION`, `STATUS_CONFLICT`.
- Allowed transitions: `requested → accepted|rejected`, `accepted → in-progress`, `in-progress → completed`. `finalAmount` is allowed only with `completed`.

## Private Admin Endpoints

All admin endpoints require a verified actor and `requireAdmin`.

### `GET /api/admin/users`

- Query: pagination, `role`, `search`.
- `200`: paginated admin user projections.
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_QUERY`.

### `PATCH /api/admin/users/:id/role`

- Path: user ObjectId.
- Body: strict `{ role: "customer" | "technician" | "admin" }`.
- `200`: `{ success: true, message: "User role updated successfully.", user }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`, `403 SELF_ROLE_CHANGE_FORBIDDEN`; `400 INVALID_OBJECT_ID`, `INVALID_ROLE_UPDATE`; `404 NOT_FOUND`.

### `GET /api/admin/services`

- Query: pagination, `approvalStatus`, `search`, `category`, `serviceMode`, `sort` (`pending-first`, `newest`, `price-asc`, `price-desc`; default `pending-first`).
- `200`: paginated private service projections.
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_QUERY`.

### `PATCH /api/admin/services/:id/approval`

- Path: service ObjectId.
- Body: strict `{ approvalStatus: "approved" | "rejected" }`.
- `200`: `{ success: true, message: "Service approval updated successfully.", service }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_OBJECT_ID`, `INVALID_APPROVAL_UPDATE`; `404 NOT_FOUND`.

### `GET /api/admin/bookings`

- Query: pagination, `status`, `paymentStatus`; email overrides are stripped.
- `200`: paginated bookings.
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_QUERY`.

### `GET /api/admin/payments`

- Query: pagination, `paymentStatus`, `currency`; amount/revenue overrides are stripped.
- `200`: paginated payment projections plus `totalRevenue` over all matching payments.
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_QUERY`.

## Private Payment Endpoints

### `POST /api/payments/create-checkout-session`

- Actor: canonical `customer` who owns the booking.
- Body: strict `{ bookingId }`.
- New session `200`: `{ success: true, message: "Checkout session created successfully.", checkoutUrl }`
- Existing payment `200`: `{ success: true, message: "Payment already recorded.", payment, booking, alreadyFulfilled: true }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_CHECKOUT_INPUT`; `404 NOT_FOUND`; `409 PAYMENT_NOT_ALLOWED`, `INVALID_PAYMENT_AMOUNT`, `PAYMENT_SESSION_MISMATCH`, `PAYMENT_RECONCILIATION_REQUIRED`; provider failures sanitized.
- Behavior: only owned `completed`, `unpaid` bookings are payable. Amount always comes from `bookings.finalAmount`.

### `GET /api/payments/verify`

- Actor: canonical `customer`.
- Query: strict `session_id` matching `cs_test_*` or `cs_live_*`.
- `200`: `{ success: true, message: "Payment verified successfully.", payment, booking, alreadyFulfilled }`
- Errors: `401 UNAUTHORIZED`; `403 FORBIDDEN`; `400 INVALID_SESSION_ID`; `404 NOT_FOUND`, `PAYMENT_SESSION_NOT_FOUND`; payment conflict codes in the `409` range; provider failures sanitized.
- Behavior: verifies Stripe session metadata, amount, currency, booking status and customer ownership; idempotent with the webhook.
