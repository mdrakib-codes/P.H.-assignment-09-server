# Environment Documentation

Source of truth: `.env.example`, `src/validators/env.validator.js` and `src/config/env.js`. Validation runs when `src/config/env.js` is imported. Invalid configuration throws `Invalid environment configuration: ...` before the HTTP server starts.

Never commit `.env`. Never place real credentials in test fixtures. The examples below are placeholders only.

## Supported Variables

| Variable | Required | Default | Validation / effect | Safe example |
|---|---|---|---|---|
| `NODE_ENV` | No | `development` | `development`, `test` or `production`; controls CORS defaults, rate-limit default, HSTS, ping timeout and logging | `development` |
| `PORT` | No | `5000` | Integer `1..65535`; HTTP listen port | `5000` |
| `CLIENT_ORIGIN` | Conditional | Dev fallback only | Exactly one `http(s)` origin; no comma; no path/search/hash except `/`; required in production when no origins are configured; first allowed origin is used for Stripe redirects | `http://localhost:3000` |
| `CLIENT_ORIGINS` | No | Empty | Comma-separated exact origins, each validated like `CLIENT_ORIGIN`; deduplicated with `CLIENT_ORIGIN` | `https://app.example.com,https://admin.example.com` |
| `MONGODB_URI` | Yes | None | Non-empty MongoDB URI; rejects placeholders such as `<...>` and `cluster.example.com`; must parse as `mongodb://` or `mongodb+srv://`; database name derived from URI path and defaults to `fixmate` | `mongodb+srv://USERNAME:PASSWORD@CLUSTER/fixmate?retryWrites=true&w=majority` |
| `MONGODB_DNS_SERVERS` | No | Empty | Comma-separated IP addresses only; passed to `dns.setServers()` before MongoDB connection | `8.8.8.8,8.8.4.4` |
| `STRIPE_SECRET_KEY` | Production yes | Empty | Creates Stripe SDK client; checkout/verify fail closed when unavailable | `sk_test_REPLACE_ME` |
| `STRIPE_WEBHOOK_SECRET` | Production yes | Empty | Required for webhook signature verification; missing secret fails closed | `whsec_REPLACE_ME` |
| `IMGBB_API_KEY` | Upload route yes | Empty | Server-side ImgBB key; trimmed; obvious placeholders are rejected; uploads fail closed when missing | `imgbb_REPLACE_ME` |
| `TRUST_PROXY` | No | `false` | `true`, `false`, `1` or `0`; controls `app.set('trust proxy', 1)` and secure/HSTS behavior | `false` |
| `RATE_LIMIT_ENABLED` | No | `true` only when `NODE_ENV=production` | Boolean-like; enables API rate limiters | `true` |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Integer `1000..3600000`; shared limiter window | `60000` |
| `RATE_LIMIT_MAX` | No | `600` | Integer `1..100000`; general `/api` limiter | `600` |
| `HEALTH_RATE_LIMIT_MAX` | No | `120` | Integer `1..100000`; `/api/health` limiter | `120` |
| `SERVICE_RATE_LIMIT_MAX` | No | `120` | Integer `1..100000`; `/api/services` limiter | `120` |
| `WEBHOOK_RATE_LIMIT_MAX` | No | `1000` | Integer `1..100000`; `/api/payments/webhook` limiter | `1000` |
| `RATE_LIMIT_MAX_ENTRIES` | No | `10000` | Integer `100..100000`; in-memory limiter map cap | `10000` |

## Safe Local Example

```dotenv
NODE_ENV=development
PORT=5000
CLIENT_ORIGIN=http://localhost:3000
MONGODB_URI=mongodb://127.0.0.1:27017/fixmate
STRIPE_SECRET_KEY=sk_test_REPLACE_ME
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME
IMGBB_API_KEY=imgbb_REPLACE_ME
TRUST_PROXY=false
RATE_LIMIT_ENABLED=false
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=600
HEALTH_RATE_LIMIT_MAX=120
SERVICE_RATE_LIMIT_MAX=120
WEBHOOK_RATE_LIMIT_MAX=1000
RATE_LIMIT_MAX_ENTRIES=10000
```

Replace placeholders with valid local values. MongoDB placeholder URIs such as `cluster.example.com` are rejected by validation.

## CORS Behavior

- Exact normalized origins only; wildcard origins are not used.
- Requests without an `Origin` header are allowed through without CORS headers.
- Disallowed origins receive `403 ORIGIN_NOT_ALLOWED`.
- Allowed methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`.
- Allowed headers: `Content-Type`, `Authorization`.
- `credentials: false`; `optionsSuccessStatus: 204`.
- In development, when no origins are configured, `http://localhost:3000` and `http://127.0.0.1:3000` are used.
- In production, explicit origins are required.

## MongoDB Configuration

- `MONGODB_URI` is required in every environment.
- `src/config/env.js` derives `mongodbDbName` from the URI path, defaulting to `fixmate`.
- Derived database names must match `/^[A-Za-z0-9_-]+$/`.
- `MONGODB_DNS_SERVERS` is optional and only affects DNS resolution before MongoDB connection.

## Stripe Configuration

- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are required in production.
- Test keys are sufficient for isolated automated tests; tests use mocks and do not contact Stripe.
- Webhook signature verification uses the raw request body; missing or invalid configuration fails closed.
- Never log or expose Stripe secrets. `src/utils/redact.js` removes Stripe key patterns and sensitive query keys from logs/URLs.

## ImgBB Configuration

- `IMGBB_API_KEY` is read only by the server from validated environment configuration.
- When the upload route is deployed, a missing or placeholder key makes uploads fail closed with a sanitized `503 INTERNAL_SERVER_ERROR` response.
- Outbound upload requests use a short timeout and never include the key in responses or logs.
- Automated tests inject a mocked provider and never contact ImgBB.

## Rate Limiting

- Limiters are in-memory and per process. Use a shared/external limiter for multi-instance deployments.
- Limits are disabled by default outside production unless `RATE_LIMIT_ENABLED=true`.
- Exceeded limits return `429 RATE_LIMIT_EXCEEDED` with a numeric `Retry-After` header.

## Trust Proxy And HTTPS

- `TRUST_PROXY=false` means Express does not trust forwarded proxy headers.
- Set `TRUST_PROXY=true` only behind a trusted HTTPS proxy/load balancer.
- HSTS is emitted only when `NODE_ENV=production`, `TRUST_PROXY` is enabled and `req.secure` is true.
