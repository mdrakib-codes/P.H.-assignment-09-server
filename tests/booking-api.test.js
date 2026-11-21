process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { after, test } from 'node:test';

const { BookingRepository } = await import('../src/repositories/booking.repository.js');
const { ServiceRepository } = await import('../src/repositories/service.repository.js');
const { UserRepository } = await import('../src/repositories/user.repository.js');
const { createBookingController } = await import('../src/controllers/booking.controller.js');
const { createBookingRoutes } = await import('../src/routes/booking.routes.js');
const { notFound } = await import('../src/middleware/notFound.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { ACTIVE_BOOKING_STATUSES } = await import('../src/validators/index.js');
const { CASE_INSENSITIVE_EMAIL_COLLATION } = await import('../src/db/collations.js');

const servers = [];
const ACTIVE_STATUSES = new Set(ACTIVE_BOOKING_STATUSES);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

const service = {
  _id: new ObjectId(),
  title: 'Phone screen repair',
  category: 'Smartphone',
  description: 'Replace a damaged screen with a genuine display.',
  image: 'https://cdn.example.com/service.jpg',
  basePrice: 75,
  estimatedDuration: '1-2 hours',
  serviceMode: 'Home Visit',
  serviceArea: 'Downtown',
  technicianName: 'Ada Technician',
  technicianEmail: 'ada@example.com',
  approvalStatus: 'approved',
  isAvailable: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z')
};

const customer = {
  _id: new ObjectId(),
  name: 'Canonical Customer',
  email: 'customer@example.com',
  role: 'customer',
  phone: '555-0000',
  passwordHash: 'secret-password-hash',
  tokens: ['secret-session-token']
};

const customerActor = {
  id: customer._id,
  email: 'Customer@Example.COM',
  role: 'customer',
  name: 'Untrusted Display Name'
};

const makeBooking = (overrides = {}) => ({
  _id: new ObjectId(),
  serviceId: service._id,
  serviceTitle: service.title,
  serviceImage: service.image,
  category: service.category,
  basePrice: service.basePrice,
  technicianName: service.technicianName,
  technicianEmail: service.technicianEmail,
  customerName: customer.name,
  customerEmail: customer.email,
  customerPhone: '555-1000',
  address: '12 Main Street',
  preferredDate: tomorrow,
  problemDescription: 'The screen is cracked and the touch panel is unresponsive.',
  status: 'requested',
  finalAmount: 75,
  paymentStatus: 'unpaid',
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  ...overrides
});

const validBody = (overrides = {}) => ({
  serviceId: service._id.toHexString(),
  customerPhone: '555-1000',
  address: '12 Main Street',
  preferredDate: tomorrow,
  problemDescription: 'The screen is cracked and the touch panel is unresponsive.',
  ...overrides
});

const matchesField = (actual, expected) => {
  if (
    expected &&
    typeof expected === 'object' &&
    !(expected instanceof Date) &&
    !(expected instanceof ObjectId)
  ) {
    if (expected.$regex !== undefined) {
      return new RegExp(expected.$regex, expected.$options || '').test(
        String(actual ?? '')
      );
    }
    if (expected.$in !== undefined) {
      return expected.$in.some((value) => String(value) === String(actual));
    }
  }

  return String(actual) === String(expected);
};

const matches = (document, filter = {}) =>
  Object.entries(filter).every(([field, expected]) =>
    field === '$or'
      ? expected.some((condition) => matches(document, condition))
      : matchesField(document[field], expected)
  );

const normalizeEmailKey = (value) => String(value ?? '').trim().toLowerCase();

const matchesWithCollation = (document, filter = {}, options = {}) => {
  if (!options.collation || options.collation.strength > 2) {
    return matches(document, filter);
  }

  return Object.entries(filter).every(([field, expected]) =>
    field.endsWith('Email') && typeof expected === 'string'
      ? normalizeEmailKey(document[field]) === normalizeEmailKey(expected)
      : matches(document, { [field]: expected })
  );
};

const isActiveBookingFilter = (filter) =>
  Boolean(filter?.customerEmail && filter?.serviceId && filter?.status?.$in);

const makeDuplicateKeyError = () => {
  const error = new Error('E11000 duplicate key error');
  error.code = 11000;
  return error;
};

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

const createGate = () => {
  let waiting = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });

  return {
    async wait() {
      waiting += 1;
      await ready;
    },
    open() {
      release();
    },
    get waiting() {
      return waiting;
    }
  };
};

const waitUntil = async (predicate, timeoutMs = 2_000) => {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for a test gate.');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const countActiveBookings = (bookings) =>
  bookings.filter((booking) => ACTIVE_STATUSES.has(booking.status)).length;

const project = (document, projection) => {
  if (!projection) {
    return document;
  }

  const included = Object.entries(projection)
    .filter(([, value]) => value === 1)
    .map(([key]) => key);

  if (included.length > 0) {
    return included.reduce((result, key) => {
      if (key in document) {
        result[key] = document[key];
      }
      return result;
    }, {});
  }

  const result = { ...document };
  for (const [key, value] of Object.entries(projection)) {
    if (value === 0) {
      delete result[key];
    }
  }
  return result;
};

const sortDocuments = (documents, sort) => {
  const entries = Object.entries(sort);

  return [...documents].sort((left, right) => {
    for (const [field, direction] of entries) {
      if (left[field] === right[field]) {
        continue;
      }
      const result = left[field] > right[field] ? 1 : -1;
      return direction === -1 ? -result : result;
    }
    return 0;
  });
};

const makeCollection = (documents = [], options = {}) => {
  const calls = [];
  const {
    uniqueActiveBooking = false,
    staleActivePrecheck = false,
    beforeFindActive = null,
    beforeInsert = null
  } = options;

  const hasActiveDuplicate = (document) =>
    ACTIVE_STATUSES.has(document.status) &&
    documents.some(
      (existing) =>
        existing !== document &&
        ACTIVE_STATUSES.has(existing.status) &&
        normalizeEmailKey(existing.customerEmail) === normalizeEmailKey(document.customerEmail) &&
        String(existing.serviceId) === String(document.serviceId)
    );

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
          ? sortDocuments(selected, sortDefinition)
          : selected;
        return sorted.slice(
          skipCount,
          limitCount === null ? undefined : skipCount + limitCount
        );
      }
    };

    return cursor;
  };

  return {
    calls,
    async insertOne(document) {
      if (beforeInsert) {
        await beforeInsert(document);
      }
      if (uniqueActiveBooking && hasActiveDuplicate(document)) {
        throw makeDuplicateKeyError();
      }
      calls.push({ type: 'insertOne', document });
      documents.push(document);
      return { acknowledged: true, insertedId: document._id };
    },
    async findOne(filter, queryOptions) {
      calls.push({ type: 'findOne', filter, options: queryOptions });
      if (beforeFindActive && isActiveBookingFilter(filter)) {
        await beforeFindActive();
      }
      if (staleActivePrecheck && isActiveBookingFilter(filter)) {
        return null;
      }
      const found = documents.find((document) =>
        matchesWithCollation(document, filter, queryOptions)
      );
      return found ? project(found, queryOptions?.projection) : null;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push({ type: 'findOneAndUpdate', filter, update, options });
      const index = documents.findIndex((document) =>
        matchesWithCollation(document, filter, options)
      );

      if (index === -1) {
        return null;
      }

      documents[index] = {
        ...documents[index],
        ...(update?.$set ?? {})
      };
      return documents[index];
    },
    find(filter, options) {
      calls.push({ type: 'find', filter, options });
      return cursorFor(
        documents.filter((document) => matchesWithCollation(document, filter, options))
      );
    },
    async countDocuments(filter, options) {
      calls.push({ type: 'countDocuments', filter, options });
      return documents.filter((document) =>
        matchesWithCollation(document, filter, options)
      ).length;
    }
  };
};

const startServer = async ({
  services = [service],
  users = [customer],
  bookings = [],
  actor = customerActor,
  attachActor = true,
  bookingCollectionOptions = {}
} = {}) => {
  const bookingCollection = makeCollection(bookings, bookingCollectionOptions);
  const controller = createBookingController({
    bookings: new BookingRepository({
      collectionFactory: () => bookingCollection
    }),
    services: new ServiceRepository({
      collectionFactory: () => makeCollection(services)
    }),
    users: new UserRepository({
      collectionFactory: () => makeCollection(users)
    }),
    getActor: (req) => req.actor
  });
  const requireActor = (req, res, next) => {
    if (attachActor) {
      req.actor = actor;
    }
    next();
  };
  const app = express();

  app.use(express.json());
  app.use('/api/bookings', createBookingRoutes({ controller, requireActor }));
  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/bookings`,
    bookings,
    bookingCollection
  };
};

const postBooking = (baseUrl, body) =>
  fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

const cancelBooking = (baseUrl, id) =>
  fetch(`${baseUrl}/${id}/cancel`, { method: 'PATCH' });

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('customer can create a booking with database-derived snapshots and initial state', async () => {
  const { baseUrl, bookings } = await startServer();

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.booking.serviceTitle, service.title);
  assert.equal(body.booking.serviceImage, service.image);
  assert.equal(body.booking.category, service.category);
  assert.equal(body.booking.basePrice, service.basePrice);
  assert.equal(body.booking.technicianName, service.technicianName);
  assert.equal(body.booking.technicianEmail, service.technicianEmail);
  assert.equal(body.booking.customerName, customer.name);
  assert.equal(body.booking.customerEmail, customer.email);
  assert.equal(body.booking.customerPhone, '555-1000');
  assert.equal(body.booking.address, '12 Main Street');
  assert.equal(body.booking.preferredDate, tomorrow);
  assert.equal(body.booking.status, 'requested');
  assert.equal(body.booking.finalAmount, service.basePrice);
  assert.equal(body.booking.paymentStatus, 'unpaid');
  assert.equal(String(body.booking.serviceId), service._id.toHexString());
  assert.equal(bookings.length, 1);
});

test('booking creation rejects an invalid service id', async () => {
  const { baseUrl } = await startServer();

  const response = await postBooking(baseUrl, validBody({ serviceId: 'bad-id' }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_BOOKING_INPUT');
});

test('booking creation rejects a missing service', async () => {
  const { baseUrl } = await startServer({ services: [] });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('booking creation rejects an unapproved service', async () => {
  const { baseUrl } = await startServer({
    services: [{ ...service, approvalStatus: 'pending' }]
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('booking creation rejects an unavailable service', async () => {
  const { baseUrl } = await startServer({
    services: [{ ...service, isAvailable: false }]
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('booking creation rejects a past preferred date', async () => {
  const { baseUrl } = await startServer();

  const response = await postBooking(
    baseUrl,
    validBody({ preferredDate: '2000-01-01' })
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_BOOKING_INPUT');
});

test('booking creation rejects an impossible preferred date', async () => {
  const { baseUrl, bookings, bookingCollection } = await startServer();

  const response = await postBooking(
    baseUrl,
    validBody({ preferredDate: '2027-02-30' })
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_BOOKING_INPUT');
  assert.equal(bookings.length, 0);
  assert.equal(
    bookingCollection.calls.some((call) => call.type === 'insertOne'),
    false
  );
});

test('booking creation rejects a problem description shorter than 20 characters', async () => {
  const { baseUrl } = await startServer();

  const response = await postBooking(
    baseUrl,
    validBody({ problemDescription: 'Too short' })
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_BOOKING_INPUT');
});

test('booking creation requires phone and address', async () => {
  const { baseUrl } = await startServer();

  const missingPhone = await postBooking(
    baseUrl,
    validBody({ customerPhone: undefined })
  );
  const missingAddress = await postBooking(
    baseUrl,
    validBody({ address: undefined })
  );

  assert.equal(missingPhone.status, 400);
  assert.equal((await missingPhone.json()).error.code, 'INVALID_BOOKING_INPUT');
  assert.equal(missingAddress.status, 400);
  assert.equal((await missingAddress.json()).error.code, 'INVALID_BOOKING_INPUT');
});

test('technician actor is rejected when creating a booking', async () => {
  const { baseUrl } = await startServer({
    actor: {
      id: new ObjectId(),
      email: 'tech@example.com',
      role: 'technician',
      name: 'Technician'
    }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('admin actor is rejected when creating a booking', async () => {
  const { baseUrl } = await startServer({
    actor: {
      id: new ObjectId(),
      email: 'admin@example.com',
      role: 'admin',
      name: 'Admin'
    }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('technician self-booking is rejected using the verified actor email', async () => {
  const selfBookingCustomer = {
    ...customer,
    email: service.technicianEmail
  };
  const { baseUrl } = await startServer({
    users: [selfBookingCustomer],
    actor: {
      ...customerActor,
      id: selfBookingCustomer._id,
      email: 'ADA@Example.COM'
    }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'SELF_BOOKING_NOT_ALLOWED');
});

test('client-supplied identity, snapshots, amount, status, or payment status is rejected', async () => {
  const { baseUrl } = await startServer();

  const response = await postBooking(
    baseUrl,
    validBody({
      customerEmail: 'attacker@example.com',
      customerName: 'Attacker',
      technicianEmail: 'attacker@example.com',
      technicianName: 'Fake Technician',
      serviceTitle: 'Fake Service',
      serviceImage: 'https://attacker.example.com/fake.jpg',
      category: 'Electrical',
      basePrice: 1,
      finalAmount: 999,
      status: 'completed',
      paymentStatus: 'paid'
    })
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_BOOKING_INPUT');
});

test('existing active booking for the same customer and service returns 409', async () => {
  const { baseUrl, bookings } = await startServer({
    bookings: [makeBooking({ status: 'requested' })],
    bookingCollectionOptions: { uniqueActiveBooking: true }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.error.code, 'DUPLICATE_ACTIVE_BOOKING');
  assert.match(body.message, /active booking/i);
  assert.equal(bookings.length, 1);
  assert.equal(countActiveBookings(bookings), 1);
});

test('concurrent duplicate creation leaves exactly one active booking', async () => {
  const barrier = createBarrier(2);
  const { baseUrl, bookings } = await startServer({
    bookingCollectionOptions: {
      uniqueActiveBooking: true,
      beforeFindActive: () => barrier.wait()
    }
  });

  const settled = await Promise.allSettled([
    postBooking(baseUrl, validBody()),
    postBooking(baseUrl, validBody())
  ]);
  const results = await Promise.all(
    settled.map(async (entry) => {
      assert.equal(entry.status, 'fulfilled');
      return {
        status: entry.value.status,
        body: await entry.value.json()
      };
    })
  );
  const successes = results.filter((result) => result.status === 201);
  const conflicts = results.filter((result) => result.status === 409);

  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].body.error.code, 'DUPLICATE_ACTIVE_BOOKING');
  assert.equal(bookings.length, 1);
  assert.equal(countActiveBookings(bookings), 1);
});

test('terminal bookings do not block a new active booking for the same pair', async () => {
  for (const status of ['cancelled', 'rejected', 'completed']) {
    const historical = makeBooking({
      status,
      paymentStatus: status === 'completed' ? 'paid' : 'unpaid'
    });
    const { baseUrl, bookings } = await startServer({
      bookings: [historical],
      bookingCollectionOptions: { uniqueActiveBooking: true }
    });

    const response = await postBooking(baseUrl, validBody());
    const body = await response.json();

    assert.equal(response.status, 201, status);
    assert.equal(body.booking.status, 'requested');
    assert.equal(bookings.length, 2, status);
    assert.equal(bookings[0].status, status);
    assert.equal(countActiveBookings(bookings), 1, status);
  }
});

test('different customers and different services can book independently', async () => {
  const firstCustomer = await startServer({
    users: [{ ...customer, email: 'first@example.com' }],
    actor: { ...customerActor, email: 'first@example.com' },
    bookingCollectionOptions: { uniqueActiveBooking: true }
  });
  const secondCustomer = await startServer({
    users: [{ ...customer, email: 'second@example.com' }],
    actor: { ...customerActor, email: 'second@example.com' },
    bookingCollectionOptions: { uniqueActiveBooking: true }
  });

  const firstResponse = await postBooking(firstCustomer.baseUrl, validBody());
  const secondResponse = await postBooking(secondCustomer.baseUrl, validBody());

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  assert.equal(firstCustomer.bookings.length, 1);
  assert.equal(secondCustomer.bookings.length, 1);

  const otherService = {
    ...service,
    _id: new ObjectId(),
    title: 'Tablet screen repair'
  };
  const sameCustomer = await startServer({
    services: [service, otherService],
    bookingCollectionOptions: { uniqueActiveBooking: true }
  });

  const firstServiceResponse = await postBooking(
    sameCustomer.baseUrl,
    validBody()
  );
  const secondServiceResponse = await postBooking(
    sameCustomer.baseUrl,
    validBody({ serviceId: otherService._id.toHexString() })
  );

  assert.equal(firstServiceResponse.status, 201);
  assert.equal(secondServiceResponse.status, 201);
  assert.equal(sameCustomer.bookings.length, 2);
  assert.equal(countActiveBookings(sameCustomer.bookings), 2);
});

test('cancelling an active booking during creation allows the new booking to insert', async () => {
  const gate = createGate();
  const existing = makeBooking({ status: 'requested' });
  const { baseUrl, bookings } = await startServer({
    bookings: [existing],
    bookingCollectionOptions: {
      uniqueActiveBooking: true,
      staleActivePrecheck: true,
      beforeInsert: () => gate.wait()
    }
  });

  const creation = postBooking(baseUrl, validBody());
  await waitUntil(() => gate.waiting === 1);

  const cancellation = await cancelBooking(baseUrl, existing._id.toHexString());
  assert.equal(cancellation.status, 200);

  gate.open();
  const response = await creation;
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.booking.status, 'requested');
  assert.equal(bookings.length, 2);
  assert.equal(bookings[0].status, 'cancelled');
  assert.equal(bookings[1].status, 'requested');
  assert.equal(countActiveBookings(bookings), 1);
});

test('historical payment metadata does not block reuse and remains unchanged', async () => {
  const historical = makeBooking({
    status: 'completed',
    paymentStatus: 'paid',
    stripeSessionId: 'cs_test_historical',
    transactionId: 'txn_historical'
  });
  const { baseUrl, bookings } = await startServer({
    bookings: [historical],
    bookingCollectionOptions: { uniqueActiveBooking: true }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.booking.status, 'requested');
  assert.equal(bookings.length, 2);
  assert.equal(bookings[0].status, 'completed');
  assert.equal(bookings[0].paymentStatus, 'paid');
  assert.equal(bookings[0].stripeSessionId, 'cs_test_historical');
  assert.equal(bookings[0].transactionId, 'txn_historical');
  assert.deepEqual(bookings[0].createdAt, historical.createdAt);
});

test('mixed-case active duplicate emails are rejected by the pre-check', async () => {
  const historical = makeBooking({
    customerEmail: 'Customer@Example.COM',
    status: 'accepted'
  });
  const { baseUrl, bookings } = await startServer({
    bookings: [historical],
    bookingCollectionOptions: { uniqueActiveBooking: true }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.error.code, 'DUPLICATE_ACTIVE_BOOKING');
  assert.equal(bookings.length, 1);
  assert.equal(historical.customerEmail, 'Customer@Example.COM');
});

test('unique active index simulation rejects mixed-case duplicate inserts', async () => {
  let seedInserted = false;
  const { baseUrl, bookings } = await startServer({
    bookingCollectionOptions: {
      uniqueActiveBooking: true,
      beforeInsert: async () => {
        if (!seedInserted) {
          bookings.push(
            makeBooking({
              customerEmail: 'CUSTOMER@EXAMPLE.COM',
              status: 'in-progress'
            })
          );
          seedInserted = true;
        }
      }
    }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.error.code, 'DUPLICATE_ACTIVE_BOOKING');
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].customerEmail, 'CUSTOMER@EXAMPLE.COM');
});

test('mixed-case terminal bookings do not block reuse', async () => {
  const historical = makeBooking({
    customerEmail: 'Customer@Example.COM',
    status: 'cancelled'
  });
  const { baseUrl, bookings } = await startServer({
    bookings: [historical],
    bookingCollectionOptions: { uniqueActiveBooking: true }
  });

  const response = await postBooking(baseUrl, validBody());

  assert.equal(response.status, 201);
  assert.equal(bookings.length, 2);
  assert.equal(bookings[0].customerEmail, 'Customer@Example.COM');
  assert.equal(bookings[0].status, 'cancelled');
  assert.equal(bookings[1].customerEmail, customer.email);
});

test('booking creation rejects a customer whose database role is not customer', async () => {
  const { baseUrl } = await startServer({
    users: [{ ...customer, role: 'admin' }]
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('booking creation rejects an actor id that does not match the canonical user', async () => {
  const { baseUrl } = await startServer({
    actor: { ...customerActor, id: new ObjectId() }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('booking creation rejects an actor email that does not match the canonical user', async () => {
  const { baseUrl } = await startServer({
    actor: { ...customerActor, email: 'other@example.com' }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('missing verified actor fails closed with 401', async () => {
  const { baseUrl } = await startServer({ attachActor: false });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('malformed verified actor fails closed with 401', async () => {
  const { baseUrl } = await startServer({
    actor: {
      id: new ObjectId(),
      email: 'not-an-email',
      role: 'customer',
      name: 'Customer'
    }
  });

  const response = await postBooking(baseUrl, validBody());
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('customer list returns only their own normalized bookings', async () => {
  const { baseUrl } = await startServer({
    bookings: [
      makeBooking({ customerEmail: customer.email, status: 'requested' }),
      makeBooking({ customerEmail: 'other@example.com', status: 'accepted' })
    ]
  });

  const response = await fetch(`${baseUrl}/my`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.total, 1);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].customerEmail, customer.email);
  assert.equal(body.items[0].status, 'requested');
});

test('customer list and cancellation match mixed-case legacy booking emails', async () => {
  const booking = makeBooking({
    customerEmail: 'CUSTOMER@Example.COM',
    status: 'requested'
  });
  const { baseUrl, bookingCollection } = await startServer({ bookings: [booking] });

  const listResponse = await fetch(`${baseUrl}/my`);
  const listBody = await listResponse.json();
  const cancelResponse = await cancelBooking(baseUrl, booking._id.toHexString());
  const cancelBody = await cancelResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listBody.total, 1);
  assert.equal(cancelResponse.status, 200);
  assert.equal(cancelBody.booking.status, 'cancelled');

  const findCall = bookingCollection.calls.find((call) => call.type === 'find');
  const updateCall = bookingCollection.calls.find(
    (call) => call.type === 'findOneAndUpdate'
  );
  assert.deepEqual(findCall.options.collation, CASE_INSENSITIVE_EMAIL_COLLATION);
  assert.deepEqual(updateCall.options.collation, CASE_INSENSITIVE_EMAIL_COLLATION);
});

test('booking allowlist drops unknown and internal fields from list and mutation responses', async () => {
  const booking = makeBooking({
    internalNote: 'booking-secret',
    passwordHash: 'booking-hash',
    stripeSessionId: 'cs_internal',
    transactionId: 'txn_internal'
  });
  const { baseUrl } = await startServer({ bookings: [booking] });

  const listResponse = await fetch(`${baseUrl}/my`);
  const listBody = await listResponse.json();
  const cancelResponse = await fetch(
    `${baseUrl}/${booking._id.toHexString()}/cancel`,
    { method: 'PATCH' }
  );
  const cancelBody = await cancelResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(cancelResponse.status, 200);

  for (const output of [listBody.items[0], cancelBody.booking]) {
    assert.equal(output.internalNote, undefined);
    assert.equal(output.passwordHash, undefined);
    assert.equal(output.stripeSessionId, undefined);
    assert.equal(output.transactionId, undefined);
  }
});

test('customer list supports status and paymentStatus filters', async () => {
  const { baseUrl } = await startServer({
    bookings: [
      makeBooking({ status: 'requested', paymentStatus: 'unpaid' }),
      makeBooking({ status: 'accepted', paymentStatus: 'unpaid' }),
      makeBooking({ status: 'completed', paymentStatus: 'paid' })
    ]
  });
  const query = new URLSearchParams({ status: 'accepted', paymentStatus: 'unpaid' });

  const response = await fetch(`${baseUrl}/my?${query}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.items[0].status, 'accepted');
  assert.equal(body.items[0].paymentStatus, 'unpaid');
});

test('customer list ignores a client-supplied customerEmail query parameter', async () => {
  const { baseUrl } = await startServer({
    bookings: [makeBooking({ customerEmail: 'other@example.com' })]
  });

  const response = await fetch(
    `${baseUrl}/my?customerEmail=${encodeURIComponent('other@example.com')}`
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 0);
});

test('customer list rejects invalid query parameters', async () => {
  const { baseUrl } = await startServer();

  const response = await fetch(`${baseUrl}/my?limit=0`);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_QUERY');
});

test('customer list rejects wrong role and missing actor', async () => {
  const wrongRole = await startServer({
    actor: {
      id: new ObjectId(),
      email: 'tech@example.com',
      role: 'technician',
      name: 'Technician'
    }
  });
  const wrongRoleResponse = await fetch(`${wrongRole.baseUrl}/my`);
  assert.equal(wrongRoleResponse.status, 403);
  assert.equal((await wrongRoleResponse.json()).error.code, 'FORBIDDEN');

  const missingActor = await startServer({ attachActor: false });
  const missingActorResponse = await fetch(`${missingActor.baseUrl}/my`);
  assert.equal(missingActorResponse.status, 401);
  assert.equal((await missingActorResponse.json()).error.code, 'UNAUTHORIZED');
});

test('owner can cancel a requested booking', async () => {
  const booking = makeBooking({ status: 'requested' });
  const { baseUrl, bookings } = await startServer({ bookings: [booking] });

  const response = await cancelBooking(
    baseUrl,
    booking._id.toHexString()
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.booking.status, 'cancelled');
  assert.equal(bookings[0].status, 'cancelled');
  assert.ok(body.booking.updatedAt);
});

test('non-owner receives 404 when cancelling a booking', async () => {
  const booking = makeBooking({ customerEmail: 'other@example.com' });
  const { baseUrl } = await startServer({ bookings: [booking] });

  const response = await cancelBooking(baseUrl, booking._id.toHexString());
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('bookings outside requested status cannot be cancelled', async () => {
  for (const status of [
    'accepted',
    'in-progress',
    'completed',
    'rejected',
    'cancelled'
  ]) {
    const booking = makeBooking({ status });
    const { baseUrl } = await startServer({ bookings: [booking] });

    const response = await cancelBooking(baseUrl, booking._id.toHexString());
    const body = await response.json();

    assert.equal(response.status, 409, status);
    assert.equal(body.error.code, 'BOOKING_CANNOT_BE_CANCELLED', status);
  }
});

test('repeated cancellation returns 409', async () => {
  const booking = makeBooking({ status: 'requested' });
  const { baseUrl } = await startServer({ bookings: [booking] });

  const first = await cancelBooking(baseUrl, booking._id.toHexString());
  assert.equal(first.status, 200);

  const second = await cancelBooking(baseUrl, booking._id.toHexString());
  const body = await second.json();

  assert.equal(second.status, 409);
  assert.equal(body.error.code, 'BOOKING_CANNOT_BE_CANCELLED');
});

test('cancelling with an invalid booking id returns 400', async () => {
  const { baseUrl } = await startServer();

  const response = await cancelBooking(baseUrl, 'not-an-object-id');
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_OBJECT_ID');
});

test('cancelling with a missing verified actor fails closed with 401', async () => {
  const booking = makeBooking();
  const { baseUrl } = await startServer({
    bookings: [booking],
    attachActor: false
  });

  const response = await cancelBooking(baseUrl, booking._id.toHexString());
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});
