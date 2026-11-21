process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { after, test } from 'node:test';

const { BookingRepository, PaymentRepository, ServiceRepository, UserRepository } =
  await import('../src/repositories/index.js');
const { createAdminController } = await import('../src/controllers/admin.controller.js');
const adminRoutesModule = await import('../src/routes/admin.routes.js');
const { createAdminRoutes } = adminRoutesModule;
const { createServiceController } = await import('../src/controllers/service.controller.js');
const { createServiceRoutes } = await import('../src/routes/service.routes.js');
const { notFound } = await import('../src/middleware/notFound.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { default: defaultApp } = await import('../src/app.js');

const servers = [];

const adminUser = {
  _id: new ObjectId(),
  name: 'Canonical Admin',
  email: 'admin@example.com',
  role: 'admin',
  passwordHash: 'admin-password-hash',
  accessToken: 'admin-access-token',
  sessions: ['admin-session']
};

const adminActor = {
  id: adminUser._id,
  email: 'ADMIN@EXAMPLE.COM',
  role: 'admin',
  name: 'Untrusted Display Name'
};

const customerUser = {
  _id: new ObjectId(),
  name: 'Canonical Customer',
  email: 'customer@example.com',
  role: 'customer',
  passwordHash: 'customer-password-hash',
  refreshToken: 'customer-refresh-token'
};

const technicianUser = {
  _id: new ObjectId(),
  name: 'Canonical Technician',
  email: 'technician@example.com',
  role: 'technician'
};

const makeUser = (overrides = {}) => ({
  _id: new ObjectId(),
  name: 'Listed User',
  email: `listed-${new ObjectId().toHexString()}@example.com`,
  role: 'customer',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  passwordHash: 'hidden-password-hash',
  ...overrides
});

const makeService = (overrides = {}) => ({
  _id: new ObjectId(),
  title: 'Phone screen repair',
  category: 'Smartphone',
  description: 'Replace a damaged screen with a genuine display.',
  image: 'https://cdn.example.com/service.jpg',
  basePrice: 75,
  estimatedDuration: '1-2 hours',
  serviceMode: 'Home Visit',
  serviceArea: 'Downtown',
  technicianName: technicianUser.name,
  technicianEmail: technicianUser.email,
  approvalStatus: 'pending',
  isAvailable: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides
});

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
  status: 'requested',
  finalAmount: 75,
  paymentStatus: 'unpaid',
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  passwordHash: 'hidden-password-hash',
  accessToken: 'hidden-access-token',
  ...overrides
});

const makePayment = (overrides = {}) => ({
  _id: new ObjectId(),
  bookingId: new ObjectId(),
  serviceTitle: 'Phone screen repair',
  customerName: customerUser.name,
  customerEmail: customerUser.email,
  technicianName: technicianUser.name,
  technicianEmail: technicianUser.email,
  amount: 100,
  currency: 'usd',
  transactionId: `txn_${new ObjectId().toHexString()}`,
  stripeSessionId: `cs_${new ObjectId().toHexString()}`,
  paymentStatus: 'paid',
  paidAt: new Date('2026-03-01T00:00:00.000Z'),
  createdAt: new Date('2026-03-01T00:00:00.000Z'),
  updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  passwordHash: 'hidden-password-hash',
  authSecret: 'hidden-auth-secret',
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
      return new RegExp(expected.$regex, expected.$options || '').test(String(actual ?? ''));
    }
    if (expected.$in !== undefined) {
      return expected.$in.some((value) => String(value) === String(actual));
    }
    if (expected.$eq !== undefined) {
      return String(actual) === String(expected.$eq);
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
      const leftValue = left[field];
      const rightValue = right[field];

      if (String(leftValue) === String(rightValue)) {
        continue;
      }

      const result = leftValue > rightValue ? 1 : -1;
      return direction === -1 ? -result : result;
    }
    return 0;
  });
};

const evaluateExpression = (document, expression) => {
  if (typeof expression === 'string' && expression.startsWith('$')) {
    return document[expression.slice(1)];
  }

  if (expression?.$cond) {
    const [condition, whenTrue, whenFalse] = expression.$cond;
    return evaluateExpression(document, condition)
      ? evaluateExpression(document, whenTrue)
      : evaluateExpression(document, whenFalse);
  }

  if (expression?.$eq) {
    const [left, right] = expression.$eq;
    return String(evaluateExpression(document, left)) === String(evaluateExpression(document, right));
  }

  return expression;
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
          ? sortDocuments(selected, sortDefinition)
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
    },
    aggregate(pipeline) {
      calls.push({ type: 'aggregate', pipeline });
      let selected = [...documents];

      for (const stage of pipeline) {
        if (stage.$match) {
          selected = selected.filter((document) => matches(document, stage.$match));
        }

        if (stage.$addFields) {
          selected = selected.map((document) => {
            const additions = Object.fromEntries(
              Object.entries(stage.$addFields).map(([field, expression]) => [
                field,
                evaluateExpression(document, expression)
              ])
            );
            return { ...document, ...additions };
          });
        }

        if (stage.$sort) {
          selected = sortDocuments(selected, stage.$sort);
        }

        if (stage.$project) {
          selected = selected.map((document) => project(document, stage.$project));
        }

        if (stage.$skip !== undefined) {
          selected = selected.slice(stage.$skip);
        }

        if (stage.$limit !== undefined) {
          selected = selected.slice(0, stage.$limit);
        }
      }

      return {
        async toArray() {
          return selected;
        }
      };
    }
  };
};

const startServer = async ({
  users = [adminUser, customerUser, technicianUser],
  services = [],
  bookings = [],
  payments = [],
  actor = adminActor,
  attachActor = true,
  includePublicServices = false,
  getActor = (req) => req.actor
} = {}) => {
  const userCollection = makeCollection(users);
  const serviceCollection = makeCollection(services);
  const bookingCollection = makeCollection(bookings);
  const paymentCollection = makeCollection(payments);

  const usersRepository = new UserRepository({ collectionFactory: () => userCollection });
  const servicesRepository = new ServiceRepository({ collectionFactory: () => serviceCollection });
  const bookingsRepository = new BookingRepository({ collectionFactory: () => bookingCollection });
  const paymentsRepository = new PaymentRepository({ collectionFactory: () => paymentCollection });

  const controller = createAdminController({
    users: usersRepository,
    services: servicesRepository,
    bookings: bookingsRepository,
    payments: paymentsRepository,
    getActor
  });
  const requireActor = (req, res, next) => {
    if (attachActor) {
      req.actor = actor;
    }
    return next();
  };
  const app = express();

  app.use(express.json());
  app.use('/api/admin', createAdminRoutes({ controller, requireActor }));

  if (includePublicServices) {
    const publicController = createServiceController({
      services: servicesRepository,
      users: usersRepository
    });
    app.use('/api/services', createServiceRoutes(publicController));
  }

  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/admin`,
    publicUrl: `http://127.0.0.1:${server.address().port}/api/services`,
    repositories: {
      users: usersRepository,
      services: servicesRepository,
      bookings: bookingsRepository,
      payments: paymentsRepository
    },
    collections: {
      users: userCollection,
      services: serviceCollection,
      bookings: bookingCollection,
      payments: paymentCollection
    }
  };
};

const request = async (url, options = {}) => {
  const response = await fetch(url, options);
  return {
    status: response.status,
    body: await response.json()
  };
};

const get = (url, headers = {}) => request(url, { headers });

const patchJson = (url, body, headers = {}) =>
  request(url, {
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

test('admin route factory requires injected requireActor and has no default router', () => {
  const controller = createAdminController();

  assert.throws(
    () => createAdminRoutes({ controller }),
    (error) => error instanceof TypeError && /requireActor/.test(error.message)
  );
  assert.equal('default' in adminRoutesModule, false);
});

test('default application does not mount admin routes', async () => {
  const server = defaultApp.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await get(
    `http://127.0.0.1:${server.address().port}/api/admin/users`
  );

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'ROUTE_NOT_FOUND');
});

test('missing or malformed actor fails closed with 401 even with identity headers', async () => {
  const missing = await startServer({ attachActor: false });
  const missingResponse = await get(`${missing.baseUrl}/users`, {
    'x-user-email': adminUser.email,
    'x-user-role': 'admin',
    'x-user-id': adminUser._id.toHexString()
  });

  assert.equal(missingResponse.status, 401);
  assert.equal(missingResponse.body.error.code, 'UNAUTHORIZED');

  const malformed = await startServer({ actor: { ...adminActor, email: 'not-an-email' } });
  const malformedResponse = await get(`${malformed.baseUrl}/users`);

  assert.equal(malformedResponse.status, 401);
  assert.equal(malformedResponse.body.error.code, 'UNAUTHORIZED');
});

test('wrong role and database role mismatch fail closed with 403', async () => {
  const wrongRole = await startServer({
    actor: { ...adminActor, role: 'customer', email: customerUser.email }
  });
  const wrongRoleResponse = await get(`${wrongRole.baseUrl}/users`);

  assert.equal(wrongRoleResponse.status, 403);
  assert.equal(wrongRoleResponse.body.error.code, 'FORBIDDEN');

  const mismatch = await startServer({
    actor: { ...adminActor, email: customerUser.email }
  });
  const mismatchResponse = await get(`${mismatch.baseUrl}/users`);

  assert.equal(mismatchResponse.status, 403);
  assert.equal(mismatchResponse.body.error.code, 'FORBIDDEN');

  const missingUser = await startServer({
    actor: { ...adminActor, email: 'missing@example.com' }
  });
  const missingUserResponse = await get(`${missingUser.baseUrl}/users`);

  assert.equal(missingUserResponse.status, 403);
  assert.equal(missingUserResponse.body.error.code, 'FORBIDDEN');
});

test('admin actor id mismatch fails closed with 403', async () => {
  const idMismatch = await startServer({
    actor: { ...adminActor, id: new ObjectId() }
  });
  const response = await get(`${idMismatch.baseUrl}/users`);

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
});

test('admin actor is read only from req.actor through injected getActor', async () => {
  const { baseUrl } = await startServer({
    getActor: (req) => req.actor,
    actor: adminActor
  });
  const response = await get(`${baseUrl}/users`, {
    'x-user-email': customerUser.email,
    'x-user-role': 'customer',
    'x-user-id': customerUser._id.toHexString()
  });

  assert.equal(response.status, 200);
  assert.ok(response.body.items.some((user) => user.email === adminUser.email));
});

test('user listing supports filters, pagination, and safe projection', async () => {
  const visibleUsers = [
    makeUser({ name: 'Alpha Admin', role: 'admin' }),
    makeUser({ name: 'Beta Technician', role: 'technician' }),
    makeUser({ name: 'Gamma Customer', role: 'customer' })
  ];
  const { baseUrl } = await startServer({ users: [adminUser, ...visibleUsers] });

  const all = await get(`${baseUrl}/users`);
  assert.equal(all.status, 200);
  assert.equal(all.body.message, 'Users retrieved successfully.');
  assert.equal(all.body.total, 4);
  assert.equal(all.body.page, 1);
  assert.equal(all.body.limit, 20);
  assert.ok(!('passwordHash' in all.body.items[0]));
  assert.ok(!('accessToken' in all.body.items[0]));
  assert.ok(!('sessions' in all.body.items[0]));

  const filtered = await get(`${baseUrl}/users?role=technician&search=Beta&limit=2`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.items[0].name, 'Beta Technician');
  assert.equal(filtered.body.limit, 2);

  const invalid = await get(`${baseUrl}/users?role=superadmin`);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_QUERY');
});

test('admin listings use allowlists that drop unknown and internal fields', async () => {
  const { baseUrl } = await startServer({
    users: [adminUser, makeUser({ internalNote: 'user-secret' })],
    services: [makeService({ internalNote: 'service-secret' })],
    bookings: [makeBooking({ internalNote: 'booking-secret' })],
    payments: [makePayment({ internalNote: 'payment-secret' })]
  });

  const [users, services, bookings, payments] = await Promise.all([
    get(`${baseUrl}/users`),
    get(`${baseUrl}/services`),
    get(`${baseUrl}/bookings`),
    get(`${baseUrl}/payments`)
  ]);

  for (const response of [users, services, bookings, payments]) {
    assert.equal(response.status, 200);
  }

  assert.equal(users.body.items[1].internalNote, undefined);
  assert.equal(services.body.items[0].internalNote, undefined);
  assert.equal(bookings.body.items[0].internalNote, undefined);
  assert.equal(bookings.body.items[0].passwordHash, undefined);
  assert.equal(payments.body.items[0].internalNote, undefined);
  assert.equal(payments.body.items[0].stripeSessionId, undefined);
  assert.equal(payments.body.items[0].transactionId, undefined);
  assert.equal(payments.body.items[0].customerEmail, undefined);
});

test('admin can change another user role but cannot change self or trust client identity', async () => {
  const { baseUrl } = await startServer();
  const targetId = customerUser._id.toHexString();

  const updated = await patchJson(`${baseUrl}/users/${targetId}/role`, {
    role: 'technician'
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.message, 'User role updated successfully.');
  assert.equal(updated.body.user.role, 'technician');
  assert.ok(!('passwordHash' in updated.body.user));
  assert.ok(!('refreshToken' in updated.body.user));

  const selfUpdate = await patchJson(
    `${baseUrl}/users/${adminUser._id.toHexString()}/role`,
    { role: 'customer' }
  );
  assert.equal(selfUpdate.status, 403);
  assert.equal(selfUpdate.body.error.code, 'SELF_ROLE_CHANGE_FORBIDDEN');

  const identityFields = await patchJson(`${baseUrl}/users/${targetId}/role`, {
    role: 'admin',
    email: customerUser.email,
    id: customerUser._id.toHexString(),
    name: 'Spoofed Name'
  });
  assert.equal(identityFields.status, 400);
  assert.equal(identityFields.body.error.code, 'INVALID_ROLE_UPDATE');

  const invalidRole = await patchJson(`${baseUrl}/users/${targetId}/role`, {
    role: 'superadmin'
  });
  assert.equal(invalidRole.status, 400);
  assert.equal(invalidRole.body.error.code, 'INVALID_ROLE_UPDATE');

  const invalidId = await patchJson(`${baseUrl}/users/not-an-id/role`, {
    role: 'technician'
  });
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.body.error.code, 'INVALID_OBJECT_ID');

  const missing = await patchJson(`${baseUrl}/users/${new ObjectId().toHexString()}/role`, {
    role: 'technician'
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('admin service listing shows every approval state with pending first by default', async () => {
  const approved = makeService({
    title: 'Approved laptop repair',
    approvalStatus: 'approved',
    createdAt: new Date('2026-02-03T00:00:00.000Z')
  });
  const rejected = makeService({
    title: 'Rejected TV repair',
    category: 'TV',
    approvalStatus: 'rejected',
    createdAt: new Date('2026-02-02T00:00:00.000Z')
  });
  const pending = makeService({
    title: 'Pending AC repair',
    category: 'AC',
    approvalStatus: 'pending',
    createdAt: new Date('2026-02-01T00:00:00.000Z')
  });
  const { baseUrl } = await startServer({ services: [approved, rejected, pending] });

  const all = await get(`${baseUrl}/services`);
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 3);
  assert.deepEqual(
    all.body.items.map((service) => service.approvalStatus),
    ['pending', 'approved', 'rejected']
  );

  const filtered = await get(
    `${baseUrl}/services?approvalStatus=rejected&category=TV&serviceMode=Home+Visit&search=TV`
  );
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.items[0]._id, rejected._id.toHexString());

  const newest = await get(`${baseUrl}/services?sort=newest`);
  assert.equal(newest.body.items[0]._id, approved._id.toHexString());

  const invalid = await get(`${baseUrl}/services?approvalStatus=unknown`);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_QUERY');
});

test('admin can approve or reject services with strict decision bodies', async () => {
  const pending = makeService();
  const { baseUrl, repositories } = await startServer({ services: [pending] });

  const approved = await patchJson(`${baseUrl}/services/${pending._id.toHexString()}/approval`, {
    approvalStatus: 'approved'
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.message, 'Service approval updated successfully.');
  assert.equal(approved.body.service.approvalStatus, 'approved');

  const rejected = await patchJson(`${baseUrl}/services/${pending._id.toHexString()}/approval`, {
    approvalStatus: 'rejected'
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.service.approvalStatus, 'rejected');

  const invalidDecision = await patchJson(
    `${baseUrl}/services/${pending._id.toHexString()}/approval`,
    { approvalStatus: 'maybe' }
  );
  assert.equal(invalidDecision.status, 400);
  assert.equal(invalidDecision.body.error.code, 'INVALID_APPROVAL_UPDATE');

  const extraFields = await patchJson(
    `${baseUrl}/services/${pending._id.toHexString()}/approval`,
    { approvalStatus: 'approved', technicianEmail: 'spoof@example.com' }
  );
  assert.equal(extraFields.status, 400);
  assert.equal(extraFields.body.error.code, 'INVALID_APPROVAL_UPDATE');

  const invalidId = await patchJson(`${baseUrl}/services/bad-id/approval`, {
    approvalStatus: 'approved'
  });
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.body.error.code, 'INVALID_OBJECT_ID');

  const missing = await patchJson(
    `${baseUrl}/services/${new ObjectId().toHexString()}/approval`,
    { approvalStatus: 'approved' }
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  await repositories.services.updateOwnedById(
    pending._id.toHexString(),
    { title: 'Technician edited title' },
    technicianUser.email
  );
  const afterEdit = await repositories.services.findById(pending._id.toHexString());
  assert.equal(afterEdit.approvalStatus, 'pending');
});

test('approved services are publicly visible only while available', async () => {
  const newlyApproved = makeService({ title: 'Pending screen repair' });
  const availableApproved = makeService({
    title: 'Already public service',
    approvalStatus: 'approved'
  });
  const unavailableApproved = makeService({
    title: 'Unavailable approved service',
    approvalStatus: 'approved',
    isAvailable: false
  });
  const { baseUrl, publicUrl } = await startServer({
    services: [newlyApproved, availableApproved, unavailableApproved],
    includePublicServices: true
  });

  const before = await get(publicUrl);
  assert.equal(before.status, 200);
  assert.deepEqual(
    before.body.items.map((service) => service._id),
    [availableApproved._id.toHexString()]
  );

  const approval = await patchJson(
    `${baseUrl}/services/${newlyApproved._id.toHexString()}/approval`,
    { approvalStatus: 'approved' }
  );
  assert.equal(approval.status, 200);

  const after = await get(publicUrl);
  assert.equal(after.body.total, 2);
  assert.ok(
    after.body.items.some((service) => service._id === newlyApproved._id.toHexString())
  );
  assert.ok(
    !after.body.items.some((service) => service._id === unavailableApproved._id.toHexString())
  );
});

test('admin booking listing supports filters, pagination, and safe projection', async () => {
  const requested = makeBooking({ status: 'requested' });
  const completed = makeBooking({
    status: 'completed',
    paymentStatus: 'paid',
    createdAt: new Date('2026-02-02T00:00:00.000Z')
  });
  const { baseUrl } = await startServer({ bookings: [requested, completed] });

  const all = await get(`${baseUrl}/bookings`);
  assert.equal(all.status, 200);
  assert.equal(all.body.message, 'Bookings retrieved successfully.');
  assert.equal(all.body.total, 2);
  assert.equal(all.body.items[0]._id, completed._id.toHexString());
  assert.ok(!('passwordHash' in all.body.items[0]));
  assert.ok(!('accessToken' in all.body.items[0]));

  const filtered = await get(`${baseUrl}/bookings?status=completed&paymentStatus=paid&limit=1`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.items[0]._id, completed._id.toHexString());

  const invalid = await get(`${baseUrl}/bookings?status=unknown`);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_QUERY');

  const mutationRoute = await patchJson(
    `${baseUrl}/bookings/${requested._id.toHexString()}/status`,
    { status: 'accepted' }
  );
  assert.equal(mutationRoute.status, 404);
  assert.equal(mutationRoute.body.error.code, 'ROUTE_NOT_FOUND');
});

test('admin payment listing returns all records with revenue independent of pagination', async () => {
  const first = makePayment({ amount: 100 });
  const second = makePayment({ amount: 50.5, createdAt: new Date('2026-03-02T00:00:00.000Z') });
  const third = makePayment({ amount: 25.5, createdAt: new Date('2026-03-03T00:00:00.000Z') });
  const { baseUrl } = await startServer({ payments: [first, second, third] });

  const pageOne = await get(`${baseUrl}/payments?page=1&limit=1`);
  assert.equal(pageOne.status, 200);
  assert.equal(pageOne.body.message, 'Payments retrieved successfully.');
  assert.equal(pageOne.body.total, 3);
  assert.equal(pageOne.body.totalPages, 3);
  assert.equal(pageOne.body.items.length, 1);
  assert.equal(pageOne.body.totalRevenue, 176);
  assert.ok(!('passwordHash' in pageOne.body.items[0]));
  assert.ok(!('authSecret' in pageOne.body.items[0]));

  const filtered = await get(`${baseUrl}/payments?paymentStatus=paid&currency=usd&limit=2`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.total, 3);
  assert.equal(filtered.body.totalRevenue, 176);

  const untrustedAmount = await get(`${baseUrl}/payments?amount=999999&revenue=1`);
  assert.equal(untrustedAmount.status, 200);
  assert.equal(untrustedAmount.body.totalRevenue, 176);

  const invalidStatus = await get(`${baseUrl}/payments?paymentStatus=unpaid`);
  assert.equal(invalidStatus.status, 400);
  assert.equal(invalidStatus.body.error.code, 'INVALID_QUERY');

  const invalidCurrency = await get(`${baseUrl}/payments?currency=eur`);
  assert.equal(invalidCurrency.status, 400);
  assert.equal(invalidCurrency.body.error.code, 'INVALID_QUERY');

  const mutationRoute = await request(`${baseUrl}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 1 })
  });
  assert.equal(mutationRoute.status, 404);
  assert.equal(mutationRoute.body.error.code, 'ROUTE_NOT_FOUND');
});
