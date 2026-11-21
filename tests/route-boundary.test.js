process.env.NODE_ENV ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';
process.env.STRIPE_SECRET_KEY ||= 'sk_test_route_boundary';
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_route_boundary';

import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { after, test } from 'node:test';

const { serviceRepository } = await import('../src/repositories/index.js');
const { default: app } = await import('../src/app.js');
const { createTechnicianServiceRoutes, createTechnicianBookingRoutes } =
  await import('../src/routes/technician.routes.js');

const servers = [];
const originalFindPublicServices = serviceRepository.findPublicServices;

const startServer = async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};

after(async () => {
  serviceRepository.findPublicServices = originalFindPublicServices;
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => server.close(() => resolve()))
    )
  );
});

test('default app keeps private routers unmounted while public routes remain available', async () => {
  serviceRepository.findPublicServices = async () => ({
    items: [],
    total: 0,
    page: 1,
    limit: 20,
    totalPages: 0
  });
  const baseUrl = await startServer();
  const privateRoutes = [
    ['GET', '/api/bookings/my', 404, 'ROUTE_NOT_FOUND'],
    ['POST', '/api/bookings', 404, 'ROUTE_NOT_FOUND'],
    ['PATCH', '/api/bookings/64b7f1c2a3d4e5f60718293a/cancel', 404, 'ROUTE_NOT_FOUND'],
    ['GET', '/api/bookings/technician', 404, 'ROUTE_NOT_FOUND'],
    ['PATCH', '/api/bookings/64b7f1c2a3d4e5f60718293a/status', 404, 'ROUTE_NOT_FOUND'],
    ['GET', '/api/services/technician', 400, 'INVALID_OBJECT_ID'],
    ['POST', '/api/services', 404, 'ROUTE_NOT_FOUND'],
    ['PATCH', '/api/services/64b7f1c2a3d4e5f60718293a/availability', 404, 'ROUTE_NOT_FOUND'],
    ['PATCH', '/api/services/64b7f1c2a3d4e5f60718293a', 404, 'ROUTE_NOT_FOUND'],
    ['DELETE', '/api/services/64b7f1c2a3d4e5f60718293a', 404, 'ROUTE_NOT_FOUND'],
    ['GET', '/api/admin/users', 404, 'ROUTE_NOT_FOUND'],
    ['PATCH', '/api/users/profile', 404, 'ROUTE_NOT_FOUND'],
    ['POST', '/api/uploads/imgbb', 404, 'ROUTE_NOT_FOUND'],
    ['GET', '/api/admin/services', 404, 'ROUTE_NOT_FOUND'],
    ['GET', '/api/admin/bookings', 404, 'ROUTE_NOT_FOUND'],
    ['GET', '/api/admin/payments', 404, 'ROUTE_NOT_FOUND'],
    ['POST', '/api/payments/create-checkout-session', 404, 'ROUTE_NOT_FOUND'],
    ['GET', '/api/payments/verify', 404, 'ROUTE_NOT_FOUND'],
    ['GET', '/payment/success?session_id=cs_test_route_boundary', 404, 'ROUTE_NOT_FOUND'],
    ['GET', '/payment/cancel?session_id=cs_test_route_boundary', 404, 'ROUTE_NOT_FOUND']
  ];

  for (const [method, path, status, code] of privateRoutes) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    const body = await response.json();
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(body.error.code, code, `${method} ${path}`);
  }

  const health = await fetch(`${baseUrl}/api/health/live`);
  const healthBody = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthBody.success, true);

  const services = await fetch(`${baseUrl}/api/services`);
  const servicesBody = await services.json();
  assert.equal(services.status, 200);
  assert.equal(servicesBody.success, true);
  assert.deepEqual(servicesBody.items, []);
});

test('default app webhook verifies signatures and returns only a minimal acknowledgement', async () => {
  const baseUrl = await startServer();
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const payload = JSON.stringify({
    id: 'evt_route_boundary',
    object: 'event',
    type: 'customer.created',
    data: { object: { id: 'cus_route_boundary' } }
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET
  });

  const valid = await fetch(`${baseUrl}/api/payments/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature
    },
    body: payload
  });
  const validBody = await valid.json();

  assert.equal(valid.status, 200);
  assert.equal(validBody.received, true);
  assert.equal(validBody.ignored, true);
  assert.deepEqual(Object.keys(validBody).sort(), [
    'message',
    'received',
    'ignored',
    'success'
  ].sort());
  assert.equal(validBody.payment, undefined);
  assert.equal(validBody.booking, undefined);

  const invalid = await fetch(`${baseUrl}/api/payments/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': 'invalid_signature'
    },
    body: payload
  });
  const invalidBody = await invalid.json();

  assert.equal(invalid.status, 400);
  assert.equal(invalidBody.error.code, 'INVALID_STRIPE_SIGNATURE');
});

test('technician route factories require verified actor middleware', () => {
  assert.throws(
    () => createTechnicianServiceRoutes({ controller: {} }),
    /requireActor middleware/
  );
  assert.throws(
    () => createTechnicianBookingRoutes({ controller: {} }),
    /requireActor middleware/
  );
});
