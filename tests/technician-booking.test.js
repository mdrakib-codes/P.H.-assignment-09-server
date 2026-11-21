process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { after, test } from 'node:test';

const { BookingRepository } = await import('../src/repositories/booking.repository.js');
const { ServiceRepository } = await import('../src/repositories/service.repository.js');
const { UserRepository } = await import('../src/repositories/user.repository.js');
const { createTechnicianController } = await import('../src/controllers/technician.controller.js');
const { createTechnicianBookingRoutes } = await import('../src/routes/technician.routes.js');
const { notFound } = await import('../src/middleware/notFound.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { CASE_INSENSITIVE_EMAIL_COLLATION } = await import('../src/db/collations.js');

const servers = [];

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

const technician = {
  _id: new ObjectId(),
  name: 'Canonical Technician',
  email: 'technician@example.com',
  role: 'technician',
  passwordHash: 'secret-password-hash',
  tokens: ['secret-session-token']
};

const otherTechnician = {
  _id: new ObjectId(),
  name: 'Other Technician',
  email: 'other@example.com',
  role: 'technician'
};

const technicianActor = {
  id: technician._id,
  email: 'TECHNICIAN@EXAMPLE.COM',
  role: 'technician',
  name: 'Untrusted Display Name'
};

const makeBooking = (overrides = {}) => ({
  _id: new ObjectId(),
  serviceId: new ObjectId(),
  serviceTitle: 'Phone screen repair',
  serviceImage: 'https://cdn.example.com/service.jpg',
  category: 'Smartphone',
  basePrice: 75,
  technicianName: technician.name,
  technicianEmail: technician.email,
  customerName: 'Canonical Customer',
  customerEmail: 'customer@example.com',
  customerPhone: '555-1000',
  address: '12 Main Street',
  preferredDate: '2026-12-01',
  problemDescription: 'The screen is cracked and the touch panel is unresponsive.',
  status: 'requested',
  finalAmount: 75,
  paymentStatus: 'unpaid',
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-01T00:00:00.000Z'),
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

const makeCollection = (
  documents = [],
  { findOneOverride, beforeFindOneAndUpdate } = {}
) => {
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
    documents,
    async insertOne(document) {
      calls.push({ type: 'insertOne', document });
      documents.push(document);
      return { acknowledged: true, insertedId: document._id };
    },
    async findOne(filter, options) {
      calls.push({ type: 'findOne', filter, options });

      if (findOneOverride) {
        return findOneOverride(filter, options);
      }

      const found = documents.find((document) =>
        matchesWithCollation(document, filter, options)
      );
      return found ? project(found, options?.projection) : null;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push({ type: 'findOneAndUpdate', filter, update, options });
      if (beforeFindOneAndUpdate) {
        await beforeFindOneAndUpdate();
      }
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
  bookings = [],
  users = [technician],
  actor = technicianActor,
  attachActor = true,
  findOneOverride
} = {}) => {
  const bookingCollection = makeCollection(bookings, { findOneOverride });
  const userCollection = makeCollection(users);
  const serviceCollection = makeCollection([]);
  const bookingsRepository = new BookingRepository({
    collectionFactory: () => bookingCollection
  });
  const usersRepository = new UserRepository({
    collectionFactory: () => userCollection
  });
  const servicesRepository = new ServiceRepository({
    collectionFactory: () => serviceCollection
  });
  const controller = createTechnicianController({
    bookings: bookingsRepository,
    users: usersRepository,
    services: servicesRepository,
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
  app.use('/api/bookings', createTechnicianBookingRoutes({ controller, requireActor }));
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

const request = async (url, options = {}) => {
  const response = await fetch(url, options);
  return {
    status: response.status,
    body: await response.json()
  };
};

const patchStatus = (baseUrl, id, body, headers = {}) =>
  request(`${baseUrl}/${id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('technician sees only assigned bookings', async () => {
  const assigned = makeBooking();
  const { baseUrl } = await startServer({
    bookings: [
      assigned,
      makeBooking({
        technicianEmail: otherTechnician.email,
        customerEmail: 'other-customer@example.com'
      })
    ]
  });

  const { status, body } = await request(`${baseUrl}/technician`);

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.total, 1);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].technicianEmail, technician.email);
  assert.equal(String(body.items[0]._id), assigned._id.toHexString());
});

test('assigned list and status update match mixed-case legacy technician emails', async () => {
  const booking = makeBooking({
    technicianEmail: 'TECHNICIAN@Example.COM',
    status: 'requested'
  });
  const { baseUrl, bookingCollection } = await startServer({ bookings: [booking] });

  const list = await request(`${baseUrl}/technician`);
  const update = await patchStatus(baseUrl, booking._id.toHexString(), {
    status: 'accepted'
  });

  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(String(list.body.items[0]._id), booking._id.toHexString());
  assert.equal(update.status, 200);
  assert.equal(update.body.booking.status, 'accepted');

  const findCall = bookingCollection.calls.find((call) => call.type === 'find');
  const ownerCall = bookingCollection.calls.find((call) => call.type === 'findOne');
  const updateCall = bookingCollection.calls.find(
    (call) => call.type === 'findOneAndUpdate'
  );
  assert.deepEqual(findCall.options.collation, CASE_INSENSITIVE_EMAIL_COLLATION);
  assert.deepEqual(ownerCall.options.collation, CASE_INSENSITIVE_EMAIL_COLLATION);
  assert.deepEqual(updateCall.options.collation, CASE_INSENSITIVE_EMAIL_COLLATION);
});

test('assigned booking list supports filters and ignores client identity inputs', async () => {
  const { baseUrl } = await startServer({
    bookings: [
      makeBooking({ status: 'requested', paymentStatus: 'unpaid' }),
      makeBooking({ status: 'accepted', paymentStatus: 'unpaid' }),
      makeBooking({ status: 'completed', paymentStatus: 'paid' })
    ]
  });
  const query = new URLSearchParams({
    status: 'accepted',
    paymentStatus: 'unpaid',
    technicianEmail: otherTechnician.email
  });

  const { status, body } = await request(
    `${baseUrl}/technician?${query}`,
    { headers: { 'x-technician-email': otherTechnician.email } }
  );

  assert.equal(status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.items[0].status, 'accepted');
  assert.equal(body.items[0].paymentStatus, 'unpaid');
});

test('valid technician status transitions succeed', async () => {
  const scenarios = [
    {
      initial: 'requested',
      update: { status: 'accepted' },
      expected: 'accepted',
      finalAmount: 75
    },
    {
      initial: 'accepted',
      update: { status: 'in-progress' },
      expected: 'in-progress',
      finalAmount: 75
    },
    {
      initial: 'in-progress',
      update: { status: 'completed', finalAmount: 90 },
      expected: 'completed',
      finalAmount: 90
    }
  ];

  for (const scenario of scenarios) {
    const booking = makeBooking({ status: scenario.initial });
    const { baseUrl } = await startServer({ bookings: [booking] });

    const { status, body } = await patchStatus(
      baseUrl,
      booking._id.toHexString(),
      scenario.update
    );

    assert.equal(status, 200, scenario.initial);
    assert.equal(body.booking.status, scenario.expected);
    assert.equal(body.booking.finalAmount, scenario.finalAmount);
    assert.equal(body.booking.paymentStatus, 'unpaid');
  }
});

test('invalid status transitions return 409', async () => {
  const scenarios = [
    { initial: 'requested', update: { status: 'completed' } },
    { initial: 'accepted', update: { status: 'completed' } },
    { initial: 'completed', update: { status: 'in-progress' } },
    { initial: 'rejected', update: { status: 'accepted' } },
    { initial: 'cancelled', update: { status: 'accepted' } }
  ];

  for (const scenario of scenarios) {
    const booking = makeBooking({ status: scenario.initial });
    const { baseUrl } = await startServer({ bookings: [booking] });

    const { status, body } = await patchStatus(
      baseUrl,
      booking._id.toHexString(),
      scenario.update
    );

    assert.equal(status, 409, scenario.initial);
    assert.equal(body.error.code, 'INVALID_STATUS_TRANSITION');
  }
});

test('technicians cannot cancel a requested booking through status update', async () => {
  const booking = makeBooking({ status: 'requested' });
  const { baseUrl, bookings } = await startServer({ bookings: [booking] });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    { status: 'cancelled' }
  );

  assert.equal(status, 409);
  assert.equal(body.error.code, 'INVALID_STATUS_TRANSITION');
  assert.equal(bookings[0].status, 'requested');
});

test('rejected bookings remain terminal', async () => {
  const booking = makeBooking({ status: 'rejected' });
  const { baseUrl, bookings } = await startServer({ bookings: [booking] });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    { status: 'accepted' }
  );

  assert.equal(status, 409);
  assert.equal(body.error.code, 'INVALID_STATUS_TRANSITION');
  assert.equal(bookings[0].status, 'rejected');
});

test('completion requires a positive finalAmount', async () => {
  const missingAmount = makeBooking({ status: 'in-progress' });
  const missingServer = await startServer({ bookings: [missingAmount] });
  const missingResponse = await patchStatus(
    missingServer.baseUrl,
    missingAmount._id.toHexString(),
    { status: 'completed' }
  );

  assert.equal(missingResponse.status, 400);
  assert.equal(missingResponse.body.error.code, 'FINAL_AMOUNT_REQUIRED');

  for (const finalAmount of [0, -5]) {
    const booking = makeBooking({ status: 'in-progress' });
    const { baseUrl } = await startServer({ bookings: [booking] });

    const { status, body } = await patchStatus(
      baseUrl,
      booking._id.toHexString(),
      { status: 'completed', finalAmount }
    );

    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_BOOKING_UPDATE');
  }
});

test('finalAmount is rejected for non-completion transitions', async () => {
  const booking = makeBooking({ status: 'requested' });
  const { baseUrl, bookings } = await startServer({ bookings: [booking] });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    { status: 'accepted', finalAmount: 90 }
  );

  assert.equal(status, 400);
  assert.equal(body.error.code, 'FINAL_AMOUNT_NOT_ALLOWED');
  assert.equal(bookings[0].status, 'requested');
  assert.equal(bookings[0].finalAmount, 75);
});

test('non-owner receives 404 when updating another technician booking', async () => {
  const booking = makeBooking({
    technicianEmail: otherTechnician.email,
    technicianName: otherTechnician.name
  });
  const { baseUrl, bookings } = await startServer({ bookings: [booking] });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    { status: 'accepted' }
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(bookings[0].status, 'requested');
});

test('stale status updates return 409 STATUS_CONFLICT', async () => {
  const booking = makeBooking({ status: 'accepted' });
  const { baseUrl, bookings } = await startServer({
    bookings: [booking],
    findOneOverride: () => ({ ...booking, status: 'requested' })
  });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    { status: 'accepted' }
  );

  assert.equal(status, 409);
  assert.equal(body.error.code, 'STATUS_CONFLICT');
  assert.equal(bookings[0].status, 'accepted');
});

test('concurrent customer cancellation and technician update leave one winner', async () => {
  const booking = makeBooking({ status: 'requested' });
  const barrier = createBarrier(2);
  const bookingCollection = makeCollection([booking], {
    beforeFindOneAndUpdate: () => barrier.wait()
  });
  const repository = new BookingRepository({
    collectionFactory: () => bookingCollection
  });

  const [cancelResult, statusResult] = await Promise.allSettled([
    repository.cancelById(booking._id.toHexString(), booking.customerEmail),
    repository.updateStatus(
      booking._id.toHexString(),
      { status: 'accepted' },
      technicianActor.email
    )
  ]);

  const results = [cancelResult, statusResult];
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.statusCode, 409);
  assert.ok(
    ['BOOKING_CANNOT_BE_CANCELLED', 'STATUS_CONFLICT'].includes(rejected[0].reason.code)
  );
  assert.ok(['cancelled', 'accepted'].includes(bookingCollection.documents[0].status));
  assert.equal(fulfilled[0].value.status, bookingCollection.documents[0].status);
  assert.equal(
    bookingCollection.calls.filter((call) => call.type === 'findOneAndUpdate').length,
    2
  );
});

test('status update rejects protected booking fields', async () => {
  const booking = makeBooking();
  const { baseUrl, bookings } = await startServer({ bookings: [booking] });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    {
      status: 'accepted',
      customerEmail: 'attacker@example.com',
      customerName: 'Attacker',
      technicianEmail: 'attacker@example.com',
      serviceTitle: 'Fake Service',
      paymentStatus: 'paid'
    }
  );

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_BOOKING_UPDATE');
  assert.equal(bookings[0].status, 'requested');
  assert.equal(bookings[0].paymentStatus, 'unpaid');
});

test('status update validates the ObjectId', async () => {
  const { baseUrl } = await startServer({ bookings: [makeBooking()] });

  const { status, body } = await patchStatus(baseUrl, 'not-an-object-id', {
    status: 'accepted'
  });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_OBJECT_ID');
});

test('missing actor fails closed even when identity headers are present', async () => {
  const booking = makeBooking();
  const { baseUrl } = await startServer({
    bookings: [booking],
    attachActor: false
  });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    { status: 'accepted' },
    { 'x-technician-email': technician.email }
  );

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('malformed actor fails closed with 401', async () => {
  const booking = makeBooking();
  const { baseUrl } = await startServer({
    bookings: [booking],
    actor: {
      ...technicianActor,
      email: 'not-an-email'
    }
  });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    { status: 'accepted' }
  );

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('wrong actor role fails closed with 403', async () => {
  const booking = makeBooking();
  const { baseUrl } = await startServer({
    bookings: [booking],
    actor: {
      ...technicianActor,
      role: 'customer'
    }
  });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    { status: 'accepted' }
  );

  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('database role mismatch fails closed with 403', async () => {
  const booking = makeBooking();
  const { baseUrl } = await startServer({
    bookings: [booking],
    users: [{ ...technician, role: 'customer' }]
  });

  const { status, body } = await patchStatus(
    baseUrl,
    booking._id.toHexString(),
    { status: 'accepted' }
  );

  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});
