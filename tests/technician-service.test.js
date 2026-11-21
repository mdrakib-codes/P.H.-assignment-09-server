process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { after, test } from 'node:test';

const { ServiceRepository } = await import('../src/repositories/service.repository.js');
const { BookingRepository } = await import('../src/repositories/booking.repository.js');
const { UserRepository } = await import('../src/repositories/user.repository.js');
const { createTechnicianController } = await import('../src/controllers/technician.controller.js');
const { createTechnicianServiceRoutes } = await import('../src/routes/technician.routes.js');
const { createServiceController } = await import('../src/controllers/service.controller.js');
const { createServiceRoutes } = await import('../src/routes/service.routes.js');
const { notFound } = await import('../src/middleware/notFound.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

const servers = [];

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
  technicianName: technician.name,
  technicianEmail: technician.email,
  approvalStatus: 'pending',
  isAvailable: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides
});

const validServiceBody = (overrides = {}) => ({
  title: 'Phone screen repair',
  category: 'Smartphone',
  description: 'Replace a damaged screen with a genuine display.',
  image: 'https://cdn.example.com/service.jpg',
  basePrice: 75,
  estimatedDuration: '1-2 hours',
  serviceMode: 'Home Visit',
  serviceArea: 'Downtown',
  ...overrides
});

const makeBookingSnapshot = (overrides = {}) => ({
  _id: new ObjectId(),
  serviceId: new ObjectId(),
  serviceTitle: 'Phone screen repair',
  technicianEmail: technician.email,
  customerEmail: 'customer@example.com',
  status: 'requested',
  finalAmount: 75,
  paymentStatus: 'unpaid',
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

const makeCollection = (documents = [], { findOneOverride } = {}) => {
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
      return documents[index];
    },
    async findOneAndDelete(filter, options) {
      calls.push({ type: 'findOneAndDelete', filter, options });
      const index = documents.findIndex((document) => matches(document, filter));

      if (index === -1) {
        return null;
      }

      const [deleted] = documents.splice(index, 1);
      return deleted;
    },
    find(filter, options) {
      calls.push({ type: 'find', filter, options });
      return cursorFor(documents.filter((document) => matches(document, filter)));
    },
    async countDocuments(filter) {
      calls.push({ type: 'countDocuments', filter });
      return documents.filter((document) => matches(document, filter)).length;
    }
  };
};

const startServer = async ({
  services = [],
  users = [technician],
  bookings = [],
  actor = technicianActor,
  attachActor = true,
  includePublic = false
} = {}) => {
  const serviceCollection = makeCollection(services);
  const userCollection = makeCollection(users);
  const bookingCollection = makeCollection(bookings);
  const servicesRepository = new ServiceRepository({
    collectionFactory: () => serviceCollection
  });
  const usersRepository = new UserRepository({
    collectionFactory: () => userCollection
  });
  const bookingsRepository = new BookingRepository({
    collectionFactory: () => bookingCollection
  });
  const controller = createTechnicianController({
    services: servicesRepository,
    users: usersRepository,
    bookings: bookingsRepository,
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
  app.use('/api/services', createTechnicianServiceRoutes({ controller, requireActor }));

  if (includePublic) {
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
    baseUrl: `http://127.0.0.1:${server.address().port}/api/services`,
    services,
    bookings,
    serviceCollection,
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

const jsonRequest = (url, method, body, headers = {}) =>
  request(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('technician can create a service with database-derived identity and safe defaults', async () => {
  const { baseUrl, services } = await startServer();

  const { status, body } = await jsonRequest(baseUrl, 'POST', validServiceBody());

  assert.equal(status, 201);
  assert.equal(body.success, true);
  assert.equal(body.message, 'Service created successfully.');
  assert.equal(body.service.title, 'Phone screen repair');
  assert.equal(body.service.technicianEmail, technician.email);
  assert.equal(body.service.technicianName, technician.name);
  assert.equal(body.service.approvalStatus, 'pending');
  assert.equal(body.service.isAvailable, true);
  assert.equal(services.length, 1);
  assert.equal(services[0].technicianEmail, technician.email);
});

test('service creation rejects client-supplied identity and server-controlled fields', async () => {
  const { baseUrl } = await startServer();

  const { status, body } = await jsonRequest(
    baseUrl,
    'POST',
    validServiceBody({
      technicianEmail: 'attacker@example.com',
      technicianName: 'Attacker',
      technicianId: new ObjectId().toHexString(),
      approvalStatus: 'approved',
      isAvailable: false,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      _id: new ObjectId().toHexString()
    })
  );

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_SERVICE_INPUT');
});

test('service creation rejects invalid fields and values', async () => {
  const { baseUrl } = await startServer();

  const invalidCategory = await jsonRequest(
    baseUrl,
    'POST',
    validServiceBody({ category: 'Unknown' })
  );
  const invalidPrice = await jsonRequest(
    baseUrl,
    'POST',
    validServiceBody({ basePrice: -1 })
  );
  const unknownField = await jsonRequest(
    baseUrl,
    'POST',
    validServiceBody({ unknownField: 'value' })
  );

  assert.equal(invalidCategory.status, 400);
  assert.equal(invalidCategory.body.error.code, 'INVALID_SERVICE_INPUT');
  assert.equal(invalidPrice.status, 400);
  assert.equal(invalidPrice.body.error.code, 'INVALID_SERVICE_INPUT');
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.body.error.code, 'INVALID_SERVICE_INPUT');
});

test('technician list returns only own services and ignores client identity inputs', async () => {
  const { baseUrl } = await startServer({
    services: [
      makeService({ title: 'Own pending one', approvalStatus: 'pending' }),
      makeService({ title: 'Own pending two', approvalStatus: 'pending' }),
      makeService({ title: 'Own approved', approvalStatus: 'approved' }),
      makeService({
        title: 'Other pending',
        technicianEmail: otherTechnician.email,
        technicianName: otherTechnician.name,
        approvalStatus: 'pending'
      })
    ]
  });
  const query = new URLSearchParams({
    approvalStatus: 'pending',
    technicianEmail: otherTechnician.email,
    page: '1',
    limit: '1'
  });

  const { status, body } = await request(
    `${baseUrl}/technician?${query}`,
    { headers: { 'x-technician-email': otherTechnician.email } }
  );

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.total, 2);
  assert.equal(body.page, 1);
  assert.equal(body.limit, 1);
  assert.equal(body.totalPages, 2);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].technicianEmail, technician.email);
  assert.ok(!body.items.some((service) => service.title === 'Other pending'));
});

test('owner can update a service and every edit resets approval to pending', async () => {
  const service = makeService({
    approvalStatus: 'approved',
    isAvailable: false
  });
  const { baseUrl, services } = await startServer({ services: [service] });

  const { status, body } = await jsonRequest(
    `${baseUrl}/${service._id.toHexString()}`,
    'PATCH',
    { title: 'Updated title', basePrice: 90 },
    {}
  );

  assert.equal(status, 200);
  assert.equal(body.service.title, 'Updated title');
  assert.equal(body.service.basePrice, 90);
  assert.equal(body.service.approvalStatus, 'pending');
  assert.equal(body.service.isAvailable, false);
  assert.equal(services[0].approvalStatus, 'pending');
  assert.equal(services[0].isAvailable, false);
});

test('service update rejects protected fields and unknown fields', async () => {
  const service = makeService();
  const { baseUrl } = await startServer({ services: [service] });

  const protectedUpdate = await jsonRequest(
    `${baseUrl}/${service._id.toHexString()}`,
    'PATCH',
    {
      approvalStatus: 'approved',
      isAvailable: false,
      technicianEmail: otherTechnician.email,
      technicianName: 'Attacker'
    }
  );
  const unknownField = await jsonRequest(
    `${baseUrl}/${service._id.toHexString()}`,
    'PATCH',
    { title: 'Valid', extra: 1 }
  );

  assert.equal(protectedUpdate.status, 400);
  assert.equal(protectedUpdate.body.error.code, 'INVALID_SERVICE_UPDATE');
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.body.error.code, 'INVALID_SERVICE_UPDATE');
});

test('service update validates the ObjectId', async () => {
  const { baseUrl } = await startServer({ services: [makeService()] });

  const { status, body } = await jsonRequest(
    `${baseUrl}/not-an-object-id`,
    'PATCH',
    { title: 'Updated title' }
  );

  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_OBJECT_ID');
});

test('non-owner receives 404 when updating another technician service', async () => {
  const service = makeService({
    technicianEmail: otherTechnician.email,
    technicianName: otherTechnician.name
  });
  const { baseUrl } = await startServer({ services: [service] });

  const { status, body } = await jsonRequest(
    `${baseUrl}/${service._id.toHexString()}`,
    'PATCH',
    { title: 'Stolen title' }
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(service.title, 'Phone screen repair');
});

test('owner can delete a service while booking snapshots remain unchanged', async () => {
  const service = makeService();
  const bookingSnapshot = makeBookingSnapshot({ serviceId: service._id });
  const { baseUrl, services, bookings } = await startServer({
    services: [service],
    bookings: [bookingSnapshot]
  });
  const bookingsBefore = bookings.map((booking) => ({ ...booking }));

  const { status, body } = await request(
    `${baseUrl}/${service._id.toHexString()}`,
    { method: 'DELETE' }
  );

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(services.length, 0);
  assert.deepEqual(bookings, bookingsBefore);
  assert.equal(bookings[0].serviceTitle, bookingSnapshot.serviceTitle);
  assert.equal(bookings[0].technicianEmail, bookingSnapshot.technicianEmail);
});

test('non-owner receives 404 when deleting another technician service', async () => {
  const service = makeService({
    technicianEmail: otherTechnician.email,
    technicianName: otherTechnician.name
  });
  const { baseUrl, services } = await startServer({ services: [service] });

  const { status, body } = await request(
    `${baseUrl}/${service._id.toHexString()}`,
    { method: 'DELETE' }
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(services.length, 1);
});

test('owner can toggle availability without changing approval status', async () => {
  const service = makeService({
    approvalStatus: 'approved',
    isAvailable: true
  });
  const { baseUrl } = await startServer({ services: [service] });

  const { status, body } = await jsonRequest(
    `${baseUrl}/${service._id.toHexString()}/availability`,
    'PATCH',
    { isAvailable: false }
  );

  assert.equal(status, 200);
  assert.equal(body.service.isAvailable, false);
  assert.equal(body.service.approvalStatus, 'approved');
});

test('availability update accepts only a boolean isAvailable field', async () => {
  const service = makeService();
  const { baseUrl } = await startServer({ services: [service] });

  const availabilityUrl = `${baseUrl}/${service._id.toHexString()}/availability`;
  const extraField = await jsonRequest(
    availabilityUrl,
    'PATCH',
    { isAvailable: false, approvalStatus: 'approved' }
  );
  const wrongValue = await jsonRequest(availabilityUrl, 'PATCH', {
    isAvailable: 'false'
  });

  assert.equal(extraField.status, 400);
  assert.equal(extraField.body.error.code, 'INVALID_AVAILABILITY');
  assert.equal(wrongValue.status, 400);
  assert.equal(wrongValue.body.error.code, 'INVALID_AVAILABILITY');
});

test('non-owner receives 404 when changing another technician service availability', async () => {
  const service = makeService({
    technicianEmail: otherTechnician.email,
    technicianName: otherTechnician.name
  });
  const { baseUrl } = await startServer({ services: [service] });

  const { status, body } = await jsonRequest(
    `${baseUrl}/${service._id.toHexString()}/availability`,
    'PATCH',
    { isAvailable: false }
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(service.isAvailable, true);
});

test('public service listing still exposes only approved and available services', async () => {
  const { baseUrl } = await startServer({
    includePublic: true,
    services: [
      makeService({ title: 'Visible', approvalStatus: 'approved', isAvailable: true }),
      makeService({ title: 'Pending', approvalStatus: 'pending', isAvailable: true }),
      makeService({ title: 'Unavailable', approvalStatus: 'approved', isAvailable: false })
    ]
  });

  const { status, body } = await request(baseUrl);

  assert.equal(status, 200);
  assert.equal(body.total, 1);
  assert.deepEqual(body.items.map((service) => service.title), ['Visible']);
});

test('missing actor fails closed even when identity headers are present', async () => {
  const { baseUrl } = await startServer({ attachActor: false });

  const { status, body } = await jsonRequest(
    baseUrl,
    'POST',
    validServiceBody(),
    { 'x-technician-email': technician.email }
  );

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('malformed actor fails closed with 401', async () => {
  const { baseUrl } = await startServer({
    actor: {
      ...technicianActor,
      email: 'not-an-email'
    }
  });

  const { status, body } = await jsonRequest(baseUrl, 'POST', validServiceBody());

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('wrong actor role fails closed with 403', async () => {
  const { baseUrl } = await startServer({
    actor: {
      ...technicianActor,
      role: 'customer'
    }
  });

  const { status, body } = await jsonRequest(baseUrl, 'POST', validServiceBody());

  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('database role mismatch fails closed with 403', async () => {
  const { baseUrl } = await startServer({
    users: [{ ...technician, role: 'customer' }]
  });

  const { status, body } = await jsonRequest(baseUrl, 'POST', validServiceBody());

  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('missing canonical database user fails closed with 403', async () => {
  const { baseUrl } = await startServer({ users: [] });

  const { status, body } = await jsonRequest(baseUrl, 'POST', validServiceBody());

  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('actor id mismatch fails closed with 403', async () => {
  const { baseUrl } = await startServer({
    actor: { ...technicianActor, id: new ObjectId() }
  });

  const { status, body } = await jsonRequest(baseUrl, 'POST', validServiceBody());

  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('actor email mismatch fails closed even with the canonical role and id', async () => {
  const { baseUrl } = await startServer({
    actor: { ...technicianActor, email: otherTechnician.email }
  });

  const { status, body } = await jsonRequest(baseUrl, 'POST', validServiceBody());

  assert.equal(status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');
});

test('canonical actor id accepts a validated hex string without conversion', async () => {
  const { baseUrl } = await startServer({
    actor: { ...technicianActor, id: technician._id.toHexString() }
  });

  const { status, body } = await jsonRequest(baseUrl, 'POST', validServiceBody());

  assert.equal(status, 201);
  assert.equal(body.service.technicianEmail, technician.email);
});
