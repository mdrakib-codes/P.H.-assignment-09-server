# Stripe Documentation

## Scope

Stripe integration supports server-authoritative checkout amount calculation, idempotent payment fulfillment, and webhook reconciliation. Automated tests use SDK mocks and do not contact Stripe.

Configuration is documented in [environment.md](environment.md). API contracts are documented in [api.md](api.md).

## Route Status

| Endpoint | Status |
|---|---|
| `POST /api/payments/webhook` | Mounted by default |
| `POST /api/payments/create-checkout-session` | Implemented as private factory; unmounted by default |
| `GET /api/payments/verify` | Implemented as private factory; unmounted by default |
| `/payment/success`, `/payment/cancel` | Frontend redirect URLs only; not backend endpoints |

## Required Configuration

- `STRIPE_SECRET_KEY`: required in production; creates the Stripe SDK client.
- `STRIPE_WEBHOOK_SECRET`: required in production; verifies `stripe-signature`.
- `CLIENT_ORIGIN` or `CLIENT_ORIGINS`: first allowed origin is used for redirect URLs.

Missing or unusable Stripe configuration fails closed. Provider errors are sanitized and never expose secrets.

## Checkout Session Creation

`POST /api/payments/create-checkout-session`

1. Verify the canonical customer actor against `users`.
2. Validate strict body `{ bookingId }`. Client amount, currency and status fields are rejected.
3. Load the booking and require ownership by canonical customer email.
4. Allow checkout only when `booking.status === "completed"` and `booking.paymentStatus === "unpaid"`.
5. If a valid payment already exists, return it with `alreadyFulfilled: true`; do not create another session.
6. Derive amount from `booking.finalAmount`: `Math.round(amount * 100)` cents, currency `usd`.
7. Create a Stripe `payment` mode session with metadata `{ bookingId, customerEmail }`.
8. Use idempotency key `fixmate-checkout-${bookingId}-${amountCents}`.
9. Return `{ success: true, message, checkoutUrl }`.

Redirect URLs:

```text
${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}
${origin}/payment/cancel
```

`origin` is the first configured allowed origin with trailing slashes removed.

## Payment Verification

`GET /api/payments/verify?session_id=cs_test_...`

- `session_id` must match `cs_test_*` or `cs_live_*`.
- If a payment already exists for the session, the server reuses it and reconciles the booking.
- Otherwise the session is retrieved from Stripe.
- Fulfillment validates:
  - session id/object/mode;
  - `payment_status === "paid"`;
  - metadata `bookingId` and canonical `customerEmail`;
  - booking ownership and `status === "completed"`;
  - `amount_total === booking.finalAmount * 100`;
  - `currency === "usd"`.

Repeated verification is safe and returns `alreadyFulfilled: true` when fulfillment already occurred.

## Webhook Handling

`POST /api/payments/webhook`

- Uses `express.raw({ type: 'application/json' })` before the JSON body parser.
- Requires `stripe-signature`.
- Verifies the raw Buffer with `stripe.webhooks.constructEvent()`.
- Empty/non-buffer body, missing signature or invalid signature returns `400`.
- Unsupported event types return `200` with `ignored: true`.
- Unpaid sessions are ignored.
- Supported events:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`

Response is intentionally minimal:

```json
{
  "success": true,
  "message": "Webhook processed successfully.",
  "received": true,
  "ignored": false
}
```

## Idempotency And Reconciliation

- Verify and webhook share the same fulfillment logic.
- One payment per booking is enforced by a unique partial index on `payments.bookingId`.
- One session is enforced by a unique partial index on `payments.stripeSessionId`.
- Duplicate key races are handled by reloading existing records.
- If the payment insert succeeds but the booking update fails, the response includes `409 PAYMENT_RECONCILIATION_REQUIRED`; a later valid webhook or verification can reconcile the booking.
- A different valid Stripe session for an already-paid booking returns `409 PAYMENT_SESSION_CONFLICT` and is never fulfilled.
- There is no separate Stripe event-ID deduplication table; safety comes from deterministic fulfillment checks and database uniqueness.
- The persisted `transactionId` is `session.payment_intent || session.id`.
- `paidAt` is derived from `session.created` seconds when valid.

## Response Redaction

Payment verification returns only:

- Payment: `bookingId`, `serviceTitle`, `amount`, `currency`, `paymentStatus`, `paidAt`.
- Booking: `_id`, `serviceTitle`, `status`, `finalAmount`, `paymentStatus`.

It does not return `stripeSessionId`, `transactionId` or customer email.

## Important Error Codes

| Code | Meaning |
|---|---|
| `INVALID_CHECKOUT_INPUT` | Invalid or extra checkout body fields |
| `PAYMENT_NOT_ALLOWED` | Booking state/payment status does not permit checkout |
| `INVALID_PAYMENT_AMOUNT` | Server-side amount is invalid |
| `INVALID_SESSION_ID` | Malformed `session_id` |
| `PAYMENT_SESSION_NOT_FOUND` | Stripe session does not exist |
| `INVALID_STRIPE_SESSION` | Session object/mode/id invalid |
| `PAYMENT_NOT_PAID` | Session is not paid |
| `INVALID_SESSION_METADATA` | Metadata missing or malformed |
| `PAYMENT_SESSION_MISMATCH` | Session does not match stored payment/booking |
| `PAYMENT_AMOUNT_MISMATCH` | Session amount differs from server amount |
| `PAYMENT_CURRENCY_MISMATCH` | Session currency is not `usd` |
| `PAYMENT_ALREADY_EXISTS` | Payment already recorded |
| `PAYMENT_SESSION_CONFLICT` | Different session used for paid booking |
| `PAYMENT_RECONCILIATION_REQUIRED` | Payment persisted but booking needs reconciliation |
| `INVALID_STRIPE_SIGNATURE` | Webhook signature verification failed |

## Local Testing

- Use Stripe test-mode placeholders and mocks for automated tests.
- Do not use live keys in `.env` during tests.
- External verification with Stripe CLI/test webhook endpoint remains required before deployment.
- Live payment behavior is not verified by this document or the local test suite.

## Test Evidence

- `tests/payment-checkout.test.js`
- `tests/payment-webhook.test.js`
- `tests/security-hardening.test.js`
- `tests/route-boundary.test.js`
