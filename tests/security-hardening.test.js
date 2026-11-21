process.env.NODE_ENV ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';
process.env.STRIPE_SECRET_KEY ||= 'sk_test_security_hardening';
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_security_hardening';

import assert from 'node:assert/strict';
import express from 'express';
import Stripe from 'stripe';
import { after, test } from 'node:test';

const { createRateLimiter } = await import('../src/middleware/rateLimit.js');
const { createSecurityHeaders } = await import('../src/middleware/securityHeaders.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { notFound } = await import('../src/middleware/notFound.js');
const { createPaymentWebhookRoutes } = await import('../src/routes/payment-webhook.routes.js');
const { ServiceRepository } = await import('../src/repositories/index.js');
const { redactSecrets, redactUrl } = await import('../src/utils/redact.js');
const {
  adminPaymentQuerySchema,
  bookingQuerySchema,
  serviceQuerySchema,
  stripeSessionIdSchema,
  technicianServiceQuerySchema
} = await import('../src/validators/index.js');
const { validateEnv } = await import('../src/validators/env.validator.js');
const { default: app } = await import('../src/app.js');

const servers = [];

const startServer = async (targetApp) => {
  const server = targetApp.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        })
    )
  );
});

test('rate limiter blocks excess requests and resets after the window', async () => {
  const limiter = createRateLimiter({ windowMs: 600, max: 1, maxEntries: 100 });
  const targetApp = express();
  targetApp.get('/limited', limiter, (req, res) => res.json({ ok: true }));
  const baseUrl = await startServer(targetApp);

  const first = await fetch(`${baseUrl}/limited`);
  const second = await fetch(`${baseUrl}/limited`);
  const secondBody = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(secondBody.success, false);
  assert.equal(secondBody.error.code, 'RATE_LIMIT_EXCEEDED');
  assert.match(secondBody.message, /too many requests/i);
  const retryAfter = Number(second.headers.get('retry-after'));
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0);
  assert.equal(secondBody.error.details, undefined);

  await new Promise((resolve) => setTimeout(resolve, 700));
  const afterReset = await fetch(`${baseUrl}/limited`);
  assert.equal(afterReset.status, 200);
});

test('rate limiter ignores spoofed forwarded IPs when proxy trust is disabled', async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, maxEntries: 100 });
  const targetApp = express();
  targetApp.get('/limited', limiter, (req, res) => res.json({ ip: req.ip }));
  const baseUrl = await startServer(targetApp);

  const first = await fetch(`${baseUrl}/limited`, {
    headers: { 'x-forwarded-for': '203.0.113.10' }
  });
  const second = await fetch(`${baseUrl}/limited`, {
    headers: { 'x-forwarded-for': '203.0.113.11' }
  });
  const third = await fetch(`${baseUrl}/limited`);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429);
});

test('rate limiter separates client identities when proxy trust is configured', async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, maxEntries: 100 });
  const targetApp = express();
  targetApp.set('trust proxy', 1);
  targetApp.get('/limited', limiter, (req, res) => res.json({ ip: req.ip }));
  const baseUrl = await startServer(targetApp);

  const clientAFirst = await fetch(`${baseUrl}/limited`, {
    headers: { 'x-forwarded-for': '203.0.113.20' }
  });
  const clientASecond = await fetch(`${baseUrl}/limited`, {
    headers: { 'x-forwarded-for': '203.0.113.20' }
  });
  const clientBFirst = await fetch(`${baseUrl}/limited`, {
    headers: { 'x-forwarded-for': '203.0.113.21' }
  });
  const clientBSecond = await fetch(`${baseUrl}/limited`, {
    headers: { 'x-forwarded-for': '203.0.113.21' }
  });
  const clientAThird = await fetch(`${baseUrl}/limited`, {
    headers: { 'x-forwarded-for': '203.0.113.20' }
  });

  assert.equal(clientAFirst.status, 200);
  assert.equal(clientASecond.status, 200);
  assert.equal(clientBFirst.status, 200);
  assert.equal(clientBSecond.status, 200);
  assert.equal(clientAThird.status, 429);
});

test('webhook retries remain compatible with the webhook rate limit and signatures', async () => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const targetApp = express();
  targetApp.use(
    '/api/payments/webhook',
    createRateLimiter({ windowMs: 60000, max: 10, maxEntries: 100 }),
    createPaymentWebhookRoutes({
      controller: {
        handleWebhookEvent: async () => ({ received: true, ignored: true })
      },
      stripeClient: stripe,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET
    })
  );
  const baseUrl = await startServer(targetApp);
  const payload = JSON.stringify({
    id: 'evt_security_hardening',
    object: 'event',
    type: 'customer.created',
    data: { object: { id: 'cus_security_hardening' } }
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature
      },
      body: payload
    });
    const body = await response.json();

    assert.equal(response.status, 200, `attempt ${attempt + 1}`);
    assert.equal(body.received, true);
    assert.equal(body.ignored, true);
  }
});

test('default app sets required security headers without HSTS in test mode', async () => {
  const baseUrl = await startServer(app);
  const response = await fetch(`${baseUrl}/api/health/live`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('permissions-policy') || '', /camera=\(\)/);
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.equal(response.headers.get('strict-transport-security'), null);
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('HSTS is emitted only for production HTTPS through a trusted proxy', async () => {
  const secureApp = express();
  secureApp.set('trust proxy', 1);
  secureApp.use(createSecurityHeaders({ isProduction: true, trustProxy: true }));
  secureApp.get('/', (req, res) => res.json({ ok: true }));
  const secureUrl = await startServer(secureApp);

  const secure = await fetch(`${secureUrl}/`, {
    headers: { 'x-forwarded-proto': 'https' }
  });
  assert.match(
    secure.headers.get('strict-transport-security') || '',
    /max-age=15552000; includeSubDomains/
  );

  const untrustedApp = express();
  untrustedApp.use(createSecurityHeaders({ isProduction: true, trustProxy: false }));
  untrustedApp.get('/', (req, res) => res.json({ ok: true }));
  const untrustedUrl = await startServer(untrustedApp);

  const spoofed = await fetch(`${untrustedUrl}/`, {
    headers: { 'x-forwarded-proto': 'https' }
  });
  assert.equal(spoofed.headers.get('strict-transport-security'), null);
});

test('default app rejects oversized JSON bodies', async () => {
  const baseUrl = await startServer(app);
  const response = await fetch(`${baseUrl}/api/services`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1) })
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(body.message, 'Request payload is too large.');
});

test('query schemas reject unknown parameters and bound pagination', () => {
  assert.equal(serviceQuerySchema.safeParse({ unexpected: '1' }).success, false);
  assert.equal(serviceQuerySchema.safeParse({ page: '0' }).success, false);
  assert.equal(serviceQuerySchema.safeParse({ limit: '101' }).success, false);
  assert.equal(adminPaymentQuerySchema.safeParse({ extra: '1' }).success, false);

  const maximum = serviceQuerySchema.safeParse({ page: '1000', limit: '100' });
  assert.equal(maximum.success, true);
  assert.equal(maximum.data.page, 1000);
  assert.equal(maximum.data.limit, 100);

  const valid = serviceQuerySchema.safeParse({
    search: 'phone',
    category: 'Smartphone',
    serviceMode: 'Home Visit',
    sort: 'price-asc',
    page: '1',
    limit: '10'
  });
  assert.equal(valid.success, true);

  const ignoredBookingIdentity = bookingQuerySchema.parse({
    status: 'accepted',
    customerEmail: 'other@example.com',
    technicianEmail: 'other@example.com'
  });
  assert.equal(ignoredBookingIdentity.customerEmail, undefined);
  assert.equal(ignoredBookingIdentity.technicianEmail, undefined);
  assert.equal(ignoredBookingIdentity.status, 'accepted');

  const ignoredTechnicianIdentity = technicianServiceQuerySchema.parse({
    approvalStatus: 'pending',
    technicianEmail: 'other@example.com'
  });
  assert.equal(ignoredTechnicianIdentity.technicianEmail, undefined);

  const ignoredPaymentInput = adminPaymentQuerySchema.parse({
    amount: '999999',
    revenue: '1',
    limit: '2'
  });
  assert.equal(ignoredPaymentInput.amount, undefined);
  assert.equal(ignoredPaymentInput.revenue, undefined);
  assert.equal(ignoredPaymentInput.limit, 2);
});

test('public service listing rejects unknown query parameters and accepts bounded maximums', async () => {
  const collection = {
    find() {
      return {
        sort() {
          return this;
        },
        skip() {
          return this;
        },
        limit() {
          return this;
        },
        async toArray() {
          return [];
        }
      };
    },
    async countDocuments() {
      return 0;
    }
  };
  const repository = new ServiceRepository({ collectionFactory: () => collection });

  await assert.rejects(
    () => repository.findPublicServices({ unexpected: '1' }),
    (error) => error.statusCode === 400 && error.code === 'INVALID_QUERY'
  );

  const maximum = await repository.findPublicServices({ page: '1000', limit: '100' });
  assert.equal(maximum.page, 1000);
  assert.equal(maximum.limit, 100);
});

test('Stripe session ID validation accepts live/test IDs and rejects malformed values', () => {
  assert.equal(stripeSessionIdSchema.parse('cs_test_ABC123'), 'cs_test_ABC123');
  assert.equal(stripeSessionIdSchema.parse('cs_live_ABC123'), 'cs_live_ABC123');

  for (const invalid of [
    'cs_test_ABC123 ',
    ' cs_test_ABC123',
    'cs_test_ABC 123',
    `cs_test_${'a'.repeat(300)}`,
    'cs_sandbox_ABC123',
    'pi_test_ABC123'
  ]) {
    assert.equal(stripeSessionIdSchema.safeParse(invalid).success, false);
  }
});

test('redaction removes representative secrets from messages and URLs', () => {
  const message = [
    'mongodb+srv://admin:hunter2@cluster0.example.net/fixmate',
    'sk_test_ABC123',
    'whsec_ABC456',
    'Bearer abc.def.ghi',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    'password=letmein',
    'api_key=key123',
    'session_id=cs_test_ABC123'
  ].join(' ');
  const redacted = redactSecrets(message);

  for (const secret of [
    'hunter2',
    'sk_test_ABC123',
    'whsec_ABC456',
    'abc.def.ghi',
    'signature',
    'letmein',
    'key123',
    'cs_test_ABC123'
  ]) {
    assert.equal(redacted.includes(secret), false, secret);
  }
  assert.match(redacted, /REDACTED/);

  const url = redactUrl('/api/missing?token=secret123&session_id=cs_test_ABC123&safe=1');
  assert.equal(url.includes('secret123'), false);
  assert.equal(url.includes('cs_test_ABC123'), false);
  assert.match(url, /safe=1/);
  assert.match(url, /token=/);
  assert.match(url, /session_id=/);
});

test('404 messages do not reflect sensitive query parameters', async () => {
  const targetApp = express();
  targetApp.use(notFound);
  const baseUrl = await startServer(targetApp);

  const response = await fetch(
    `${baseUrl}/api/missing?password=hunter2&session_id=cs_test_ABC123`
  );
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'ROUTE_NOT_FOUND');
  assert.equal(body.message.includes('hunter2'), false);
  assert.equal(body.message.includes('cs_test_ABC123'), false);
  assert.match(body.message, /\[REDACTED\]/);
});

test('error handler sanitizes unexpected 4xx errors and logs without secrets', async () => {
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.map((entry) => String(entry)).join(' '));

  try {
    const targetApp = express();
    targetApp.get('/boom', (req, res, next) => {
      next(new Error('failed sk_test_SECRET123 at password=hunter2'));
    });
    targetApp.get('/client-error', (req, res, next) => {
      next(Object.assign(new Error('internal token=abc123'), { status: 400 }));
    });
    targetApp.use(errorHandler);
    const baseUrl = await startServer(targetApp);

    const serverError = await fetch(`${baseUrl}/boom?token=urlsecret123`);
    const serverBody = await serverError.json();
    assert.equal(serverError.status, 500);
    assert.equal(serverBody.error.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(serverBody.message, 'Something went wrong.');
    assert.equal(JSON.stringify(serverBody).includes('sk_test_SECRET123'), false);
    assert.equal(JSON.stringify(serverBody).includes('stack'), false);

    const clientError = await fetch(`${baseUrl}/client-error`);
    const clientBody = await clientError.json();
    assert.equal(clientError.status, 400);
    assert.equal(clientBody.error.code, 'REQUEST_ERROR');
    assert.equal(clientBody.message, 'Request could not be completed.');
    assert.equal(JSON.stringify(clientBody).includes('token=abc123'), false);

    const logText = logs.join('\n');
    assert.equal(logText.includes('sk_test_SECRET123'), false);
    assert.equal(logText.includes('hunter2'), false);
    assert.equal(logText.includes('urlsecret123'), false);
    assert.match(logText, /token=\[REDACTED\]/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('rate-limit environment settings use safe defaults', () => {
  const development = validateEnv({
    NODE_ENV: 'development',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/fixmate_test'
  });
  const production = validateEnv({
    NODE_ENV: 'production',
    CLIENT_ORIGIN: 'https://app.example.com',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/fixmate_test',
    STRIPE_SECRET_KEY: 'sk_test_ABC123',
    STRIPE_WEBHOOK_SECRET: 'whsec_ABC456'
  });

  assert.equal(development.TRUST_PROXY, undefined);
  assert.equal(development.WEBHOOK_RATE_LIMIT_MAX, 1000);
  assert.equal(production.RATE_LIMIT_WINDOW_MS, 60000);
});
