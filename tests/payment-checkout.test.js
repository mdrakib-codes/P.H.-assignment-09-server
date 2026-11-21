process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { after, test } from 'node:test';

const { BookingRepository, PaymentRepository, UserRepository } =
  await import('../src/repositories/index.js');
const { createPaymentController } =
  await import('../src/controllers/payment.controller.js');
const paymentRoutesModule = await import('../src/routes/payment.routes.js');
const { createPaymentRoutes } = paymentRoutesModule;
const { notFound } = await import('../src/middleware/notFound.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { default: defaultApp } = await import('../src/app.js');

const servers = [];

const customerUser = {
  _id: new ObjectId(),
  name: 'Canonical Customer',
  email: 'customer@example.com',
  role: 'customer'
};

const otherCustomerUser = {
  _id: new ObjectId(),
  name: 'Other Customer',
  email: 'other@example.com',
  role: 'customer'
};

const technicianUser = {
  _id: new ObjectId(),
  name: 'Canonical Technician',
  email: 'technician@example.com',
  role: 'technician'
};

const customerActor = {
  id: customerUser._id,
  email: customerUser.email,
  role: 'customer',
  name: 'Untrusted Display Name'
};

const makeBooking = (overrides = {}) => ({
  _id: new ObjectId(),
  serviceId: new ObjectId(),
  serviceTitle: 'Phone screen repair',
  serviceImage: 'https://cdn.example.com/service.jpg',
  category: 'Smartphone',
  basePrice: 75,
  technicianName: technicianUser.name,
  technicianEmail: technicianUser.email,
  customerName: customerUser.name,
  customerEmail: customerUser.email,
  customerPhone: '555-1000',
  address: '12 Main Street',
  preferredDate: '2026-12-01',
  problemDescription: 'The screen is cracked and the touch panel is unresponsive.',
  status: 'completed',
  finalAmount: 75.5,
  paymentStatus: 'unpaid',
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  ...overrides
});

const matches = (document, filter = {}) =>
  Object.entries(filter).every(([field, expected]) =>
    String(document[field]) === String(expected)
  );

const project = (document, projection) => {
  if (!projection) {
    return document;
  }

  const result = { ...document };
  for (const [field, value] of Object.entries(projection)) {
    if (value === 0) {
      delete result[field];
    }
  }
  return result;
};

const makeCollection = (documents = []) => {
  const calls = [];

  const cursorFor = (selected) => {
    let sortDefinition = null;
    let skipCount = 0;
    let limitCount = null;

    const cursor = {
      sort(value) {
        sortDefinition = value;
        return cursor;
      },
      skip(value) {
        skipCount = value;
        return cursor;
      },
      limit(value) {
        limitCount = value;
        return cursor;
      },
      async toArray() {
        const sorted = sortDefinition
          ? [...selected].sort((left, right) => {
              for (const [field, direction] of Object.entries(sortDefinition)) {
                if (String(left[field]) !== String(right[field])) {
                  const result = left[field] > right[field] ? 1 : -1;
                  return direction === -1 ? -result : result;
                }
              }
              return 0;
            })
          : selected;

        return sorted
          .slice(skipCount, limitCount === null ? undefined : skipCount + limitCount)
          .map((document) => project(document, cursor.projection));
      }
    };

    return cursor;
  };

  return {
    calls,
    documents,
    async insertOne(document) {
      calls.push({ type: 'insertOne', document });
      documents.push(document);
      return { acknowledged: true, insertedId: document._id };
    },
    async findOne(filter, options) {
      calls.push({ type: 'findOne', filter, options });
      const found = documents.find((document) => matches(document, filter));
      return found ? project(found, options?.projection) : null;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push({ type: 'findOneAndUpdate', filter, update, options });
      const index = documents.findIndex((document) => matches(document, filter));

      if (index === -1) {
        return null;
      }

      documents[index] = {
        ...documents[index],
        ...(update?.$set ?? {})
      };
      return project(documents[index], options?.projection);
    },
    find(filter, options) {
      calls.push({ type: 'find', filter, options });
      const cursor = cursorFor(documents.filter((document) => matches(document, filter)));
      cursor.projection = options?.projection;
      return cursor;
    },
    async countDocuments(filter) {
      calls.push({ type: 'countDocuments', filter });
      return documents.filter((document) => matches(document, filter)).length;
    }
  };
};

const createStripeStub = ({ failCreate = false } = {}) => {
  const calls = { create: [], retrieve: [] };
  const sessions = new Map();

  return {
    calls,
    sessions,
    checkout: {
      sessions: {
        async create(params, options) {
          calls.create.push({ params, options });

          if (failCreate) {
            throw new Error('stripe is unavailable');
          }

          const key = options?.idempotencyKey || new ObjectId().toHexString();

          if (sessions.has(key)) {
            return sessions.get(key);
          }

          const session = {
            id: `cs_test_${new ObjectId().toHexString()}`,
            url: 'https://checkout.stripe.test/session'
          };
          sessions.set(key, session);
          return session;
        },
        async retrieve(sessionId) {
          calls.retrieve.push(sessionId);
          return null;
        }
      }
    }
  };
};

const startServer = async ({
  users = [customerUser, otherCustomerUser, technicianUser],
  bookings = [],
  actor = customerActor,
  attachActor = true,
  stripeClient = createStripeStub(),
  clientOrigin = 'http://localhost:3000'
} = {}) => {
  const userCollection = makeCollection([...users]);
  const bookingCollection = makeCollection([...bookings]);
  const paymentCollection = makeCollection([]);
  const usersRepository = new UserRepository({
    collectionFactory: () => userCollection
  });
  const bookingsRepository = new BookingRepository({
    collectionFactory: () => bookingCollection
  });
  const paymentsRepository = new PaymentRepository({
    collectionFactory: () => paymentCollection
  });
  const controller = createPaymentController({
    stripeClient,
    payments: paymentsRepository,
    bookings: bookingsRepository,
    users: usersRepository,
    clientOrigin,
    getActor: (req) => req.actor
  });
  const requireActor = (req, res, next) => {
    if (attachActor) {
      req.actor = actor;
    }
    return next();
  };
  const app = express();

  app.use(express.json());
  app.use('/api/payments', createPaymentRoutes({ controller, requireActor }));
  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/payments`,
    stripeClient,
    bookingCollection,
    paymentCollection
  };
};

const request = async (url, options = {}) => {
  const response = await fetch(url, options);
  return {
    status: response.status,
    body: await response.json()
  };
};

const postJson = (url, body, headers = {}) =>
  request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('payment route factory requires injected requireActor and has no default router', () => {
  const controller = createPaymentController();

  assert.throws(
    () => createPaymentRoutes({ controller }),
    (error) => error instanceof TypeError && /requireActor/.test(error.message)
  );
  assert.equal('default' in paymentRoutesModule, false);
});

test('default application does not mount private payment routes', async () => {
  const server = defaultApp.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/payments`;

  const checkout = await postJson(`${baseUrl}/create-checkout-session`, {
    bookingId: new ObjectId().toHexString()
  });
  const verify = await request(`${baseUrl}/verify?session_id=cs_test_unmounted`);

  assert.equal(checkout.status, 404);
  assert.equal(checkout.body.error.code, 'ROUTE_NOT_FOUND');
  assert.equal(verify.status, 404);
  assert.equal(verify.body.error.code, 'ROUTE_NOT_FOUND');
});

test('missing or malformed actor fails closed with 401 even with identity headers', async () => {
  const missing = await startServer({ attachActor: false });
  const missingResponse = await postJson(
    `${missing.baseUrl}/create-checkout-session`,
    { bookingId: new ObjectId().toHexString() },
    {
      'x-user-email': customerUser.email,
      'x-user-role': 'customer'
    }
  );

  assert.equal(missingResponse.status, 401);
  assert.equal(missingResponse.body.error.code, 'UNAUTHORIZED');

  const malformed = await startServer({
    actor: { ...customerActor, email: 'not-an-email' }
  });
  const malformedResponse = await postJson(
    `${malformed.baseUrl}/create-checkout-session`,
    { bookingId: new ObjectId().toHexString() }
  );

  assert.equal(malformedResponse.status, 401);
  assert.equal(malformedResponse.body.error.code, 'UNAUTHORIZED');
});

test('wrong role and database role mismatch fail closed with 403', async () => {
  const wrongRole = await startServer({
    actor: { ...customerActor, role: 'technician' }
  });
  const wrongRoleResponse = await postJson(
    `${wrongRole.baseUrl}/create-checkout-session`,
    { bookingId: new ObjectId().toHexString() }
  );

  assert.equal(wrongRoleResponse.status, 403);
  assert.equal(wrongRoleResponse.body.error.code, 'FORBIDDEN');

  const mismatch = await startServer({
    users: [{ ...customerUser, role: 'technician' }],
    actor: customerActor
  });
  const mismatchResponse = await postJson(
    `${mismatch.baseUrl}/create-checkout-session`,
    { bookingId: new ObjectId().toHexString() }
  );

  assert.equal(mismatchResponse.status, 403);
  assert.equal(mismatchResponse.body.error.code, 'FORBIDDEN');
});

test('actor identity mismatch fails closed with 403', async () => {
  const idMismatch = await startServer({
    actor: { ...customerActor, id: new ObjectId() }
  });
  const idMismatchResponse = await postJson(
    `${idMismatch.baseUrl}/create-checkout-session`,
    { bookingId: new ObjectId().toHexString() }
  );

  assert.equal(idMismatchResponse.status, 403);
  assert.equal(idMismatchResponse.body.error.code, 'FORBIDDEN');

  const emailMismatch = await startServer({
    actor: { ...customerActor, email: otherCustomerUser.email }
  });
  const emailMismatchResponse = await postJson(
    `${emailMismatch.baseUrl}/create-checkout-session`,
    { bookingId: new ObjectId().toHexString() }
  );

  assert.equal(emailMismatchResponse.status, 403);
  assert.equal(emailMismatchResponse.body.error.code, 'FORBIDDEN');
});

test('customer cannot start checkout for another customer booking', async () => {
  const booking = makeBooking({
    customerEmail: otherCustomerUser.email,
    customerName: otherCustomerUser.name
  });
  const { baseUrl } = await startServer({ bookings: [booking] });

  const response = await postJson(`${baseUrl}/create-checkout-session`, {
    bookingId: booking._id.toHexString()
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

test('checkout validates booking id and missing booking', async () => {
  const { baseUrl } = await startServer();

  const invalid = await postJson(`${baseUrl}/create-checkout-session`, {
    bookingId: 'not-an-id'
  });
  const missing = await postJson(`${baseUrl}/create-checkout-session`, {
    bookingId: new ObjectId().toHexString()
  });

  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_CHECKOUT_INPUT');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('non-completed and already-paid bookings are rejected', async () => {
  const accepted = makeBooking({ status: 'accepted' });
  const paid = makeBooking({ paymentStatus: 'paid' });
  const acceptedServer = await startServer({ bookings: [accepted] });
  const paidServer = await startServer({ bookings: [paid] });

  const acceptedResponse = await postJson(
    `${acceptedServer.baseUrl}/create-checkout-session`,
    { bookingId: accepted._id.toHexString() }
  );
  const paidResponse = await postJson(
    `${paidServer.baseUrl}/create-checkout-session`,
    { bookingId: paid._id.toHexString() }
  );

  assert.equal(acceptedResponse.status, 409);
  assert.equal(acceptedResponse.body.error.code, 'PAYMENT_NOT_ALLOWED');
  assert.equal(paidResponse.status, 409);
  assert.equal(paidResponse.body.error.code, 'PAYMENT_NOT_ALLOWED');
});

test('client amount currency and status fields are rejected', async () => {
  const booking = makeBooking();
  const stripeClient = createStripeStub();
  const { baseUrl } = await startServer({ bookings: [booking], stripeClient });

  const response = await postJson(`${baseUrl}/create-checkout-session`, {
    bookingId: booking._id.toHexString(),
    amount: 1,
    currency: 'eur',
    status: 'completed',
    paymentStatus: 'paid'
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_CHECKOUT_INPUT');
  assert.equal(stripeClient.calls.create.length, 0);
});

test('checkout uses database finalAmount USD metadata and configured origin', async () => {
  const booking = makeBooking({ finalAmount: 75.5 });
  const stripeClient = createStripeStub();
  const { baseUrl } = await startServer({
    bookings: [booking],
    stripeClient,
    clientOrigin: 'https://fixmate.example/'
  });

  const response = await postJson(`${baseUrl}/create-checkout-session`, {
    bookingId: booking._id.toHexString()
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.message, 'Checkout session created successfully.');
  assert.ok(response.body.checkoutUrl);
  assert.equal(response.body.sessionId, undefined);
  assert.equal(response.body.stripeSessionId, undefined);
  assert.equal(stripeClient.calls.create.length, 1);
  assert.equal(stripeClient.calls.create[0].params.mode, 'payment');
  assert.equal(stripeClient.calls.create[0].params.line_items[0].price_data.unit_amount, 7550);
  assert.equal(stripeClient.calls.create[0].params.line_items[0].price_data.currency, 'usd');
  assert.equal(
    stripeClient.calls.create[0].params.success_url,
    'https://fixmate.example/payment/success?session_id={CHECKOUT_SESSION_ID}'
  );
  assert.equal(
    stripeClient.calls.create[0].params.cancel_url,
    'https://fixmate.example/payment/cancel'
  );
  assert.equal(stripeClient.calls.create[0].params.metadata.bookingId, String(booking._id));
  assert.equal(stripeClient.calls.create[0].params.metadata.customerEmail, customerUser.email);
});

test('Stripe checkout failure is handled safely', async () => {
  const booking = makeBooking();
  const stripeClient = createStripeStub({ failCreate: true });
  const { baseUrl } = await startServer({ bookings: [booking], stripeClient });

  const response = await postJson(`${baseUrl}/create-checkout-session`, {
    bookingId: booking._id.toHexString()
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'INTERNAL_SERVER_ERROR');
  assert.doesNotMatch(JSON.stringify(response.body), /stripe is unavailable|sk_test_|whsec_/i);
});

test('repeated checkout uses Stripe idempotency and returns the same session', async () => {
  const booking = makeBooking();
  const stripeClient = createStripeStub();
  const { baseUrl } = await startServer({ bookings: [booking], stripeClient });

  const first = await postJson(`${baseUrl}/create-checkout-session`, {
    bookingId: booking._id.toHexString()
  });
  const second = await postJson(`${baseUrl}/create-checkout-session`, {
    bookingId: booking._id.toHexString()
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.ok(first.body.checkoutUrl);
  assert.equal(first.body.checkoutUrl, second.body.checkoutUrl);
  assert.equal(first.body.sessionId, undefined);
  assert.equal(first.body.stripeSessionId, undefined);
  assert.equal(second.body.sessionId, undefined);
  assert.equal(second.body.stripeSessionId, undefined);
  assert.equal(stripeClient.sessions.size, 1);
  assert.equal(
    stripeClient.calls.create[0].options.idempotencyKey,
    stripeClient.calls.create[1].options.idempotencyKey
  );
});

test('concurrent checkout requests reuse the same Stripe session', async () => {
  const booking = makeBooking();
  const stripeClient = createStripeStub();
  const { baseUrl } = await startServer({ bookings: [booking], stripeClient });

  const [first, second] = await Promise.all([
    postJson(`${baseUrl}/create-checkout-session`, {
      bookingId: booking._id.toHexString()
    }),
    postJson(`${baseUrl}/create-checkout-session`, {
      bookingId: booking._id.toHexString()
    })
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.checkoutUrl, second.body.checkoutUrl);
  assert.equal(stripeClient.sessions.size, 1);
  assert.equal(
    stripeClient.calls.create[0].options.idempotencyKey,
    stripeClient.calls.create[1].options.idempotencyKey
  );
});
