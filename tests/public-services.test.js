process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { after, test } from 'node:test';

const { ServiceRepository } = await import('../src/repositories/service.repository.js');
const { UserRepository } = await import('../src/repositories/user.repository.js');
const { createServiceController } = await import('../src/controllers/service.controller.js');
const { createServiceRoutes } = await import('../src/routes/service.routes.js');
const { notFound } = await import('../src/middleware/notFound.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

const servers = [];

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
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
  technicianName: 'Ada Technician',
  technicianEmail: 'ada@example.com',
  approvalStatus: 'approved',
  isAvailable: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides
});

const makeTechnician = () => ({
  _id: new ObjectId(),
  name: 'Ada Technician',
  email: 'ada@example.com',
  image: 'https://cdn.example.com/technician.jpg',
  role: 'technician',
  phone: '555-9999',
  area: 'Downtown',
  bio: 'Ten years of repair experience.',
  passwordHash: 'secret-password-hash',
  tokens: ['secret-session-token'],
  resetToken: 'secret-reset-token'
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

const makeCollection = (documents = []) => ({
  find(filter) {
    const selected = documents.filter((document) => matches(document, filter));
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
  },
  async findOne(filter, options) {
    const found = documents.find((document) => matches(document, filter));
    return found ? project(found, options?.projection) : null;
  },
  async countDocuments(filter) {
    return documents.filter((document) => matches(document, filter)).length;
  }
});

const startServer = async ({ services = [], users = [] } = {}) => {
  const controller = createServiceController({
    services: new ServiceRepository({
      collectionFactory: () => makeCollection(services)
    }),
    users: new UserRepository({
      collectionFactory: () => makeCollection(users)
    })
  });

  const app = express();
  app.use(express.json());
  app.use('/api/services', createServiceRoutes(controller));
  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);

  return `http://127.0.0.1:${server.address().port}/api/services`;
};

test('public list returns only approved and available services', async () => {
  const baseUrl = await startServer({
    services: [
      makeService({ title: 'Visible service' }),
      makeService({ title: 'Pending service', approvalStatus: 'pending' }),
      makeService({ title: 'Unavailable service', isAvailable: false })
    ]
  });

  const response = await fetch(baseUrl);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => item.title),
    ['Visible service']
  );
  assert.equal(body.total, 1);
});

test('search matches service titles case-insensitively', async () => {
  const baseUrl = await startServer({
    services: [
      makeService({ title: 'Phone screen repair' }),
      makeService({
        title: 'Laptop keyboard replacement',
        category: 'Laptop & PC',
        description: 'Replace keys on a damaged laptop keyboard.'
      })
    ]
  });

  const response = await fetch(`${baseUrl}?search=SCREEN`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => item.title),
    ['Phone screen repair']
  );
});

test('search matches service categories', async () => {
  const baseUrl = await startServer({
    services: [
      makeService({ title: 'Screen repair', category: 'Smartphone' }),
      makeService({ title: 'Cooling check', category: 'AC' })
    ]
  });

  const response = await fetch(`${baseUrl}?search=smartphone`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => item.title),
    ['Screen repair']
  );
});

test('category filtering limits results to the requested category', async () => {
  const baseUrl = await startServer({
    services: [
      makeService({ title: 'Phone repair', category: 'Smartphone' }),
      makeService({ title: 'AC repair', category: 'AC' })
    ]
  });

  const response = await fetch(`${baseUrl}?category=AC`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => item.title),
    ['AC repair']
  );
});

test('service mode filtering limits results to the requested mode', async () => {
  const baseUrl = await startServer({
    services: [
      makeService({ title: 'Home visit service', serviceMode: 'Home Visit' }),
      makeService({
        title: 'Drop-off service',
        serviceMode: 'Shop Drop-off'
      })
    ]
  });

  const query = new URLSearchParams({ serviceMode: 'Shop Drop-off' });
  const response = await fetch(`${baseUrl}?${query}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => item.title),
    ['Drop-off service']
  );
});

test('price sorting orders services ascending and descending', async () => {
  const baseUrl = await startServer({
    services: [
      makeService({ title: 'Mid', basePrice: 75 }),
      makeService({ title: 'High', basePrice: 120 }),
      makeService({ title: 'Low', basePrice: 40 })
    ]
  });

  const ascending = await (await fetch(`${baseUrl}?sort=price-asc`)).json();
  const descending = await (await fetch(`${baseUrl}?sort=price-desc`)).json();

  assert.deepEqual(
    ascending.items.map((item) => item.title),
    ['Low', 'Mid', 'High']
  );
  assert.deepEqual(
    descending.items.map((item) => item.title),
    ['High', 'Mid', 'Low']
  );
});

test('newest sorting orders services by creation date descending', async () => {
  const baseUrl = await startServer({
    services: [
      makeService({
        title: 'Oldest',
        createdAt: new Date('2025-01-01T00:00:00.000Z')
      }),
      makeService({
        title: 'Newest',
        createdAt: new Date('2026-01-01T00:00:00.000Z')
      })
    ]
  });

  const response = await fetch(`${baseUrl}?sort=newest`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => item.title),
    ['Newest', 'Oldest']
  );
});

test('invalid query parameters return a centralized 400 error', async () => {
  const baseUrl = await startServer();

  const response = await fetch(`${baseUrl}?limit=0`);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INVALID_QUERY');
});

test('valid service details return the public service and technician summary', async () => {
  const service = makeService();
  const baseUrl = await startServer({
    services: [service],
    users: [makeTechnician()]
  });

  const response = await fetch(`${baseUrl}/${service._id.toHexString()}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.service.title, service.title);
  assert.equal(body.service.description, service.description);
  assert.equal(body.service.basePrice, service.basePrice);
  assert.deepEqual(body.service.technician, {
    name: 'Ada Technician',
    image: 'https://cdn.example.com/technician.jpg',
    area: 'Downtown',
    bio: 'Ten years of repair experience.'
  });
});

test('invalid ObjectId returns a centralized 400 error', async () => {
  const baseUrl = await startServer();

  const response = await fetch(`${baseUrl}/not-an-object-id`);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INVALID_OBJECT_ID');
});

test('missing service returns a centralized 404 error', async () => {
  const baseUrl = await startServer();

  const response = await fetch(`${baseUrl}/${new ObjectId().toHexString()}`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('unapproved service returns a centralized 404 error', async () => {
  const service = makeService({ approvalStatus: 'pending' });
  const baseUrl = await startServer({ services: [service] });

  const response = await fetch(`${baseUrl}/${service._id.toHexString()}`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('unavailable service returns a centralized 404 error', async () => {
  const service = makeService({ isAvailable: false });
  const baseUrl = await startServer({ services: [service] });

  const response = await fetch(`${baseUrl}/${service._id.toHexString()}`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('private technician information is not exposed', async () => {
  const service = makeService();
  const baseUrl = await startServer({
    services: [service],
    users: [makeTechnician()]
  });

  const response = await fetch(`${baseUrl}/${service._id.toHexString()}`);
  const body = await response.json();
  const output = JSON.stringify(body);

  assert.deepEqual(Object.keys(body.service.technician).sort(), [
    'area',
    'bio',
    'image',
    'name'
  ]);
  for (const secret of [
    'secret-password-hash',
    'secret-session-token',
    'secret-reset-token',
    '555-9999',
    '"role"'
  ]) {
    assert.doesNotMatch(output, new RegExp(secret.replace(/"/g, '\\"')));
  }
});

test('success and error responses use the consistent JSON format', async () => {
  const baseUrl = await startServer({ services: [makeService()] });

  const successResponse = await fetch(baseUrl);
  const successBody = await successResponse.json();
  assert.equal(successResponse.status, 200);
  assert.equal(successBody.success, true);
  assert.ok(successBody.message);
  assert.equal(successBody.error, undefined);

  const errorResponse = await fetch(`${baseUrl}?sort=unknown`);
  const errorBody = await errorResponse.json();
  assert.equal(errorResponse.status, 400);
  assert.equal(errorBody.success, false);
  assert.ok(errorBody.message);
  assert.equal(errorBody.error.code, 'INVALID_QUERY');
});
