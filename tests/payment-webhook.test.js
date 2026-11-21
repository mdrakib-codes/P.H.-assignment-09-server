process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { after, test } from 'node:test';

const { BookingRepository, PaymentRepository, UserRepository } =
  await import('../src/repositories/index.js');
const { createPaymentController } =
  await import('../src/controllers/payment.controller.js');
const { createPaymentRoutes } = await import('../src/routes/payment.routes.js');
const { createPaymentWebhookRoutes } =
  await import('../src/routes/payment-webhook.routes.js');
const { notFound } = await import('../src/middleware/notFound.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

const servers = [];
const webhookSecret = 'whsec_test';
const validSignature = 'valid_signature';

const createBarrier = (count) => {
  let waiting = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });

  return {
    async wait() {
      waiting += 1;
      if (waiting >= count) {
        release();
      }
      await ready;
    },
    get waiting() {
      return waiting;
    }
  };
};

const customerUser = {
  _id: new ObjectId(),
  name: 'Canonical Customer',
  email: 'customer@example.com',
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

const makeSession = ({
  id = 'cs_test_success',
  bookingId,
  amount = 7550,
  currency = 'usd',
  paymentStatus = 'paid',
  customerEmail = customerUser.email,
  paymentIntent = 'pi_test_123'
} = {}) => ({
  id,
  object: 'checkout.session',
  mode: 'payment',
  payment_status: paymentStatus,
  amount_total: amount,
  currency,
  payment_intent: paymentIntent,
  created: 1762329600,
  metadata: {
    bookingId: String(bookingId),
    customerEmail
  }
});

const makeEvent = (session, type = 'checkout.session.completed') => ({
  id: `evt_${new ObjectId().toHexString()}`,
  type,
  data: { object: session }
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

const makeCollection = (documents = [], options = {}) => {
  const calls = [];
  const uniqueFields = options.uniqueFields ?? [];
  const beforeInsert = options.beforeInsert ?? null;
  let pendingUpdateError = options.failUpdateOnce === true;

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
      if (beforeInsert) {
        await beforeInsert();
      }

      for (const field of uniqueFields) {
        if (
          document[field] !== undefined &&
          documents.some((existing) => String(existing[field]) === String(document[field]))
        ) {
          const error = new Error('duplicate key');
          error.code = 11000;
          throw error;
        }
      }

      documents.push(document);
      return { acknowledged: true, insertedId: document._id };
    },
    async findOne(filter, findOptions) {
      calls.push({ type: 'findOne', filter, options: findOptions });
      const found = documents.find((document) => matches(document, filter));
      return found ? project(found, findOptions?.projection) : null;
    },
    async findOneAndUpdate(filter, update, findOptions) {
      calls.push({ type: 'findOneAndUpdate', filter, update, options: findOptions });

      if (pendingUpdateError) {
        pendingUpdateError = false;
        throw new Error('booking update failed');
      }

      const index = documents.findIndex((document) => matches(document, filter));

      if (index === -1) {
        return null;
      }

      documents[index] = {
        ...documents[index],
        ...(update?.$set ?? {})
      };
      return project(documents[index], findOptions?.projection);
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

const createStripeStub = ({ event = null, retrieveSession = null } = {}) => {
  const calls = { construct: [], retrieve: [] };

  return {
    calls,
    webhooks: {
      constructEvent(rawBody, signature, secret) {
        calls.construct.push({
          rawBody: Buffer.isBuffer(rawBody) ? rawBody.toString() : String(rawBody),
          signature,
          secret
        });

        if (signature !== validSignature || secret !== webhookSecret) {
          throw new Error('invalid signature');
        }

        JSON.parse(rawBody.toString());
        return typeof event === 'function' ? event(rawBody) : event;
      }
    },
    checkout: {
      sessions: {
        async create() {
          throw new Error('not used');
        },
        async retrieve(sessionId) {
          calls.retrieve.push(sessionId);
          return retrieveSession;
        }
      }
    }
  };
};

const startServer = async ({
  users = [customerUser, technicianUser],
  bookings = [],
  stripeClient = createStripeStub(),
  actor = customerActor,
  bookingCollectionOptions = {},
  paymentCollectionOptions = {}
} = {}) => {
  const userCollection = makeCollection([...users]);
  const bookingCollection = makeCollection([...bookings], bookingCollectionOptions);
  const paymentCollection = makeCollection([], paymentCollectionOptions);
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
    clientOrigin: 'http://localhost:3000'
  });
  const requireActor = (req, res, next) => {
    req.actor = actor;
    return next();
  };
  const app = express();

  app.use(
    '/api/payments/webhook',
    createPaymentWebhookRoutes({
      controller,
      stripeClient,
      webhookSecret
    })
  );
  app.use(express.json());
  app.use('/api/payments', createPaymentRoutes({ controller, requireActor }));
  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);

  return {
    webhookUrl: `http://127.0.0.1:${server.address().port}/api/payments/webhook`,
    verifyUrl: `http://127.0.0.1:${server.address().port}/api/payments/verify`,
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

const postRaw = (url, body, signature = validSignature) =>
  request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'stripe-signature': signature })
    },
    body
  });

const verifyPayment = (url, sessionId) => request(`${url}?session_id=${sessionId}`);

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('webhook route factory rejects missing controller', () => {
  assert.throws(
    () => createPaymentWebhookRoutes({ stripeClient: createStripeStub(), webhookSecret }),
    /webhook controller/
  );
});

test('webhook requests fail closed when webhook secret is unavailable', async () => {
  const booking = makeBooking();
  const stripeClient = createStripeStub({ event: makeEvent(makeSession({ bookingId: booking._id })) });
  const paymentCollection = makeCollection([]);
  const bookingCollection = makeCollection([booking]);
  const controller = createPaymentController({
    stripeClient,
    payments: new PaymentRepository({ collectionFactory: () => paymentCollection }),
    bookings: new BookingRepository({ collectionFactory: () => bookingCollection }),
    users: new UserRepository({ collectionFactory: () => makeCollection([customerUser]) })
  });
  const app = express();

  app.use(
    '/api/payments/webhook',
    createPaymentWebhookRoutes({
      controller,
      stripeClient,
      webhookSecret: ''
    })
  );
  app.use(errorHandler);

  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await postRaw(
    `http://127.0.0.1:${server.address().port}/api/payments/webhook`,
    JSON.stringify(makeEvent(makeSession({ bookingId: booking._id })))
  );

  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'INTERNAL_SERVER_ERROR');
});

test('valid signed event records payment and marks booking paid', async () => {
  const booking = makeBooking();
  const session = makeSession({ bookingId: booking._id });
  const stripeClient = createStripeStub({ event: makeEvent(session) });
  const { webhookUrl, paymentCollection, bookingCollection } = await startServer({
    bookings: [booking],
    stripeClient
  });

  const response = await postRaw(webhookUrl, JSON.stringify(makeEvent(session)));

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.ignored, false);
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(String(paymentCollection.documents[0].bookingId), String(booking._id));
  assert.equal(paymentCollection.documents[0].stripeSessionId, session.id);
  assert.equal(paymentCollection.documents[0].paymentStatus, 'paid');
  assert.equal(bookingCollection.documents[0].paymentStatus, 'paid');
  assert.equal(stripeClient.calls.construct[0].secret, webhookSecret);
});

test('missing invalid and malformed signatures are rejected', async () => {
  const booking = makeBooking();
  const session = makeSession({ bookingId: booking._id });
  const stripeClient = createStripeStub({ event: makeEvent(session) });
  const { webhookUrl, paymentCollection } = await startServer({
    bookings: [booking],
    stripeClient
  });

  const missing = await postRaw(webhookUrl, JSON.stringify(makeEvent(session)), null);
  const invalid = await postRaw(webhookUrl, JSON.stringify(makeEvent(session)), 'bad');
  const malformed = await postRaw(webhookUrl, '{');

  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'MISSING_STRIPE_SIGNATURE');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_STRIPE_SIGNATURE');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'INVALID_STRIPE_SIGNATURE');
  assert.equal(paymentCollection.documents.length, 0);
});

test('unsupported and unpaid events are ignored safely', async () => {
  const booking = makeBooking();
  const session = makeSession({ bookingId: booking._id, paymentStatus: 'unpaid' });
  const stripeClient = createStripeStub({
    event: (rawBody) => JSON.parse(rawBody.toString())
  });
  const { webhookUrl, paymentCollection, bookingCollection } = await startServer({
    bookings: [booking],
    stripeClient
  });

  const unsupported = await postRaw(
    webhookUrl,
    JSON.stringify(makeEvent(session, 'payment_intent.created'))
  );
  const unpaid = await postRaw(webhookUrl, JSON.stringify(makeEvent(session)));

  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.body.ignored, true);
  assert.equal(unpaid.status, 200);
  assert.equal(unpaid.body.ignored, true);
  assert.equal(paymentCollection.documents.length, 0);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'unpaid');
});

test('failed payment event does not fulfill and a later success is honored', async () => {
  const booking = makeBooking();
  const failedSession = makeSession({ bookingId: booking._id, paymentStatus: 'unpaid' });
  const paidSession = makeSession({ bookingId: booking._id });
  const stripeClient = createStripeStub({
    event: (rawBody) => JSON.parse(rawBody.toString())
  });
  const { webhookUrl, paymentCollection, bookingCollection } = await startServer({
    bookings: [booking],
    stripeClient
  });

  const failed = await postRaw(
    webhookUrl,
    JSON.stringify(makeEvent(failedSession, 'checkout.session.async_payment_failed'))
  );

  assert.equal(failed.status, 200);
  assert.equal(failed.body.ignored, true);
  assert.equal(paymentCollection.documents.length, 0);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'unpaid');

  const success = await postRaw(webhookUrl, JSON.stringify(makeEvent(paidSession)));

  assert.equal(success.status, 200);
  assert.equal(success.body.success, true);
  assert.equal(success.body.ignored, false);
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'paid');
});

test('amount currency and unknown booking mismatches are rejected', async () => {
  const amountBooking = makeBooking();
  const currencyBooking = makeBooking();
  const amountMismatch = makeSession({ bookingId: amountBooking._id, amount: 1 });
  const currencyMismatch = makeSession({ bookingId: currencyBooking._id, currency: 'eur' });
  const unknownBooking = makeSession({ bookingId: new ObjectId() });
  const amountServer = await startServer({
    bookings: [amountBooking],
    stripeClient: createStripeStub({ event: makeEvent(amountMismatch) })
  });
  const currencyServer = await startServer({
    bookings: [currencyBooking],
    stripeClient: createStripeStub({ event: makeEvent(currencyMismatch) })
  });
  const unknownServer = await startServer({
    bookings: [],
    stripeClient: createStripeStub({ event: makeEvent(unknownBooking) })
  });

  const amountResponse = await postRaw(
    amountServer.webhookUrl,
    JSON.stringify(makeEvent(amountMismatch))
  );
  const currencyResponse = await postRaw(
    currencyServer.webhookUrl,
    JSON.stringify(makeEvent(currencyMismatch))
  );
  const unknownResponse = await postRaw(
    unknownServer.webhookUrl,
    JSON.stringify(makeEvent(unknownBooking))
  );

  assert.equal(amountResponse.status, 409);
  assert.equal(amountResponse.body.error.code, 'PAYMENT_AMOUNT_MISMATCH');
  assert.equal(currencyResponse.status, 409);
  assert.equal(currencyResponse.body.error.code, 'PAYMENT_CURRENCY_MISMATCH');
  assert.equal(unknownResponse.status, 404);
  assert.equal(unknownResponse.body.error.code, 'NOT_FOUND');
  assert.equal(amountServer.paymentCollection.documents.length, 0);
  assert.equal(currencyServer.paymentCollection.documents.length, 0);
  assert.equal(unknownServer.paymentCollection.documents.length, 0);
});

test('duplicate webhook delivery is idempotent', async () => {
  const booking = makeBooking();
  const session = makeSession({ bookingId: booking._id });
  const { webhookUrl, paymentCollection, bookingCollection } = await startServer({
    bookings: [booking],
    stripeClient: createStripeStub({ event: makeEvent(session) })
  });

  const first = await postRaw(webhookUrl, JSON.stringify(makeEvent(session)));
  const second = await postRaw(webhookUrl, JSON.stringify(makeEvent(session)));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'paid');
  assert.equal(
    bookingCollection.calls.filter(
      (call) => call.type === 'findOneAndUpdate' && call.update?.$set?.paymentStatus === 'paid'
    ).length,
    1
  );
});

test('success verification followed by webhook does not duplicate', async () => {
  const booking = makeBooking();
  const session = makeSession({ bookingId: booking._id });
  const stripeClient = createStripeStub({
    event: makeEvent(session),
    retrieveSession: session
  });
  const { webhookUrl, verifyUrl, paymentCollection, bookingCollection } = await startServer({
    bookings: [booking],
    stripeClient
  });

  const verified = await verifyPayment(verifyUrl, session.id);
  const webhook = await postRaw(webhookUrl, JSON.stringify(makeEvent(session)));

  assert.equal(verified.status, 200);
  assert.equal(verified.body.alreadyFulfilled, false);
  assert.deepEqual(Object.keys(verified.body.payment).sort(), [
    'amount',
    'bookingId',
    'currency',
    'paidAt',
    'paymentStatus',
    'serviceTitle'
  ]);
  assert.equal(verified.body.payment.stripeSessionId, undefined);
  assert.equal(verified.body.payment.transactionId, undefined);
  assert.equal(verified.body.payment.customerEmail, undefined);
  assert.equal(verified.body.booking.customerEmail, undefined);
  assert.equal(webhook.status, 200);
  assert.equal(webhook.body.alreadyFulfilled, undefined);
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'paid');
  assert.equal(
    bookingCollection.calls.filter(
      (call) => call.type === 'findOneAndUpdate' && call.update?.$set?.paymentStatus === 'paid'
    ).length,
    1
  );
});

test('webhook followed by success verification does not duplicate', async () => {
  const booking = makeBooking();
  const session = makeSession({ bookingId: booking._id });
  const stripeClient = createStripeStub({
    event: makeEvent(session),
    retrieveSession: session
  });
  const { webhookUrl, verifyUrl, paymentCollection } = await startServer({
    bookings: [booking],
    stripeClient
  });

  const webhook = await postRaw(webhookUrl, JSON.stringify(makeEvent(session)));
  const verified = await verifyPayment(verifyUrl, session.id);

  assert.equal(webhook.status, 200);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.alreadyFulfilled, true);
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(stripeClient.calls.retrieve.length, 0);
});

test('payment insert succeeds while booking update fails and same session retry reconciles', async () => {
  const booking = makeBooking();
  const session = makeSession({ id: 'cs_test_partial', bookingId: booking._id });
  const stripeClient = createStripeStub({
    event: (rawBody) => JSON.parse(rawBody.toString())
  });
  const { webhookUrl, paymentCollection, bookingCollection } = await startServer({
    bookings: [booking],
    stripeClient,
    bookingCollectionOptions: { failUpdateOnce: true },
    paymentCollectionOptions: { uniqueFields: ['bookingId', 'stripeSessionId'] }
  });
  const event = JSON.stringify(makeEvent(session));

  const initial = await postRaw(webhookUrl, event);

  assert.equal(initial.status, 409);
  assert.equal(initial.body.error.code, 'PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(String(paymentCollection.documents[0].bookingId), String(booking._id));
  assert.equal(paymentCollection.documents[0].stripeSessionId, session.id);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'unpaid');

  const retry = await postRaw(webhookUrl, event);

  assert.equal(retry.status, 200);
  assert.equal(retry.body.success, true);
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(paymentCollection.calls.filter((call) => call.type === 'insertOne').length, 1);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'paid');
});

test('invalid amount and customer sessions cannot reconcile an existing payment', async () => {
  const booking = makeBooking();
  const validSession = makeSession({ id: 'cs_test_valid', bookingId: booking._id });
  const wrongAmount = makeSession({
    id: 'cs_test_wrong_amount',
    bookingId: booking._id,
    amount: 1
  });
  const wrongCustomer = makeSession({
    id: 'cs_test_wrong_customer',
    bookingId: booking._id,
    customerEmail: 'other@example.com'
  });
  const stripeClient = createStripeStub({
    event: (rawBody) => JSON.parse(rawBody.toString())
  });
  const { webhookUrl, paymentCollection, bookingCollection } = await startServer({
    bookings: [booking],
    stripeClient,
    bookingCollectionOptions: { failUpdateOnce: true },
    paymentCollectionOptions: { uniqueFields: ['bookingId', 'stripeSessionId'] }
  });

  const initial = await postRaw(webhookUrl, JSON.stringify(makeEvent(validSession)));
  const amountMismatch = await postRaw(webhookUrl, JSON.stringify(makeEvent(wrongAmount)));
  const customerMismatch = await postRaw(webhookUrl, JSON.stringify(makeEvent(wrongCustomer)));

  assert.equal(initial.status, 409);
  assert.equal(initial.body.error.code, 'PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal(amountMismatch.status, 409);
  assert.equal(amountMismatch.body.error.code, 'PAYMENT_AMOUNT_MISMATCH');
  assert.equal(customerMismatch.status, 409);
  assert.equal(customerMismatch.body.error.code, 'PAYMENT_SESSION_MISMATCH');
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(paymentCollection.documents[0].stripeSessionId, validSession.id);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'unpaid');

  const retry = await postRaw(webhookUrl, JSON.stringify(makeEvent(validSession)));

  assert.equal(retry.status, 200);
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'paid');
});

test('different Stripe session conflict uses existing payment and never fulfills losing session', async () => {
  const booking = makeBooking();
  const winningSession = makeSession({
    id: 'cs_test_winning',
    bookingId: booking._id,
    paymentIntent: 'pi_winning'
  });
  const losingSession = makeSession({
    id: 'cs_test_losing',
    bookingId: booking._id,
    paymentIntent: 'pi_losing'
  });
  const stripeClient = createStripeStub({
    event: (rawBody) => JSON.parse(rawBody.toString())
  });
  const { webhookUrl, paymentCollection, bookingCollection } = await startServer({
    bookings: [booking],
    stripeClient,
    bookingCollectionOptions: { failUpdateOnce: true },
    paymentCollectionOptions: { uniqueFields: ['bookingId', 'stripeSessionId'] }
  });

  const first = await postRaw(webhookUrl, JSON.stringify(makeEvent(winningSession)));

  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, 'PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(paymentCollection.documents[0].stripeSessionId, winningSession.id);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'unpaid');

  const losing = await postRaw(webhookUrl, JSON.stringify(makeEvent(losingSession)));

  assert.equal(losing.status, 409);
  assert.equal(losing.body.error.code, 'PAYMENT_SESSION_CONFLICT');
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(paymentCollection.documents[0].stripeSessionId, winningSession.id);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'paid');

  const winningRetry = await postRaw(webhookUrl, JSON.stringify(makeEvent(winningSession)));
  const losingRetry = await postRaw(webhookUrl, JSON.stringify(makeEvent(losingSession)));

  assert.equal(winningRetry.status, 200);
  assert.equal(losingRetry.status, 409);
  assert.equal(losingRetry.body.error.code, 'PAYMENT_SESSION_CONFLICT');
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(paymentCollection.documents[0].stripeSessionId, winningSession.id);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'paid');
});

test('verify endpoint rejects malformed and oversized Stripe session IDs', async () => {
  const stripeClient = createStripeStub();
  const { verifyUrl } = await startServer({ stripeClient });
  const invalidIds = [
    '',
    'not-a-session',
    'cs_test_bad id',
    `cs_test_${'a'.repeat(256)}`
  ];

  for (const id of invalidIds) {
    const response = await request(`${verifyUrl}?session_id=${encodeURIComponent(id)}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_SESSION_ID');
  }

  assert.equal(stripeClient.calls.retrieve.length, 0);
});

test('verified webhook persists the Stripe transaction ID', async () => {
  const booking = makeBooking();
  const session = makeSession({
    bookingId: booking._id,
    paymentIntent: 'pi_txn_persisted'
  });
  const { webhookUrl, paymentCollection } = await startServer({
    bookings: [booking],
    stripeClient: createStripeStub({ event: makeEvent(session) })
  });

  const response = await postRaw(webhookUrl, JSON.stringify(makeEvent(session)));

  assert.equal(response.status, 200);
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(paymentCollection.documents[0].transactionId, 'pi_txn_persisted');
});

test('concurrent verification and webhook fulfill the payment only once', async () => {
  const booking = makeBooking();
  const session = makeSession({ bookingId: booking._id });
  const barrier = createBarrier(2);
  const stripeClient = createStripeStub({
    event: makeEvent(session),
    retrieveSession: session
  });
  const { webhookUrl, verifyUrl, paymentCollection, bookingCollection } = await startServer({
    bookings: [booking],
    stripeClient,
    paymentCollectionOptions: {
      uniqueFields: ['bookingId', 'stripeSessionId'],
      beforeInsert: () => barrier.wait()
    }
  });

  const [verified, webhook] = await Promise.all([
    verifyPayment(verifyUrl, session.id),
    postRaw(webhookUrl, JSON.stringify(makeEvent(session)))
  ]);

  assert.equal(verified.status, 200);
  assert.equal(webhook.status, 200);
  assert.equal(paymentCollection.documents.length, 1);
  assert.equal(paymentCollection.calls.filter((call) => call.type === 'insertOne').length, 2);
  assert.equal(bookingCollection.documents[0].paymentStatus, 'paid');
  assert.ok(
    bookingCollection.calls.some(
      (call) => call.type === 'findOneAndUpdate' && call.update?.$set?.paymentStatus === 'paid'
    )
  );
});
