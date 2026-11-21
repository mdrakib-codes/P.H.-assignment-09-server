process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';
process.env.NODE_ENV ||= 'test';

import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { after, test } from 'node:test';

const { UserRepository } = await import('../src/repositories/index.js');
const { USER_PROFILE_FIELDS } = await import('../src/repositories/user.repository.js');
const { createUserController } = await import('../src/controllers/user.controller.js');
const userRoutesModule = await import('../src/routes/user.routes.js');
const { createUserRoutes } = userRoutesModule;
const { notFound } = await import('../src/middleware/notFound.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

const servers = [];

const customerUser = {
  _id: new ObjectId(),
  name: 'Canonical Customer',
  email: 'customer@example.com',
  image: 'https://cdn.example.com/old-avatar.jpg',
  role: 'customer',
  phone: '555-1000',
  area: 'Old Area',
  bio: 'Old bio.',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  passwordHash: 'hidden-password-hash',
  accessToken: 'hidden-access-token',
  sessions: ['hidden-session'],
  internalNote: 'hidden-internal-note'
};

const otherUser = {
  _id: new ObjectId(),
  name: 'Other Customer',
  email: 'other@example.com',
  role: 'customer',
  passwordHash: 'other-password-hash'
};

const customerActor = {
  id: customerUser._id,
  email: ' CUSTOMER@EXAMPLE.COM ',
  role: 'customer',
  name: 'Untrusted Display Name'
};

const project = (document, projection) => {
  if (!projection) {
    return { ...document };
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

const makeUserCollection = (users, { missingAtWrite = false } = {}) => {
  const calls = [];
  const stored = users.map((user) => ({ ...user }));

  return {
    calls,
    stored,
    async findOne(filter, options) {
      calls.push({ type: 'findOne', filter, options });
      const user = stored.find((item) => item.email === filter.email);
      return user ? project(user, options?.projection) : null;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push({ type: 'findOneAndUpdate', filter, update, options });

      if (missingAtWrite) {
        return null;
      }

      const index = stored.findIndex(
        (item) => String(item._id) === String(filter._id)
      );

      if (index === -1) {
        return null;
      }

      stored[index] = { ...stored[index], ...update.$set };
      return project(stored[index], options?.projection);
    }
  };
};

const startServer = async ({
  users = [customerUser],
  actor = customerActor,
  attachActor = true,
  getActor = (req) => req.actor,
  missingAtWrite = false
} = {}) => {
  const collection = makeUserCollection(users, { missingAtWrite });
  const usersRepository = new UserRepository({
    collectionFactory: () => collection
  });
  const controller = createUserController({ users: usersRepository, getActor });
  const requireActor = (req, res, next) => {
    if (attachActor) {
      req.actor = actor;
    }
    return next();
  };
  const app = express();

  app.use(express.json());
  app.use('/api/users', createUserRoutes({ controller, requireActor }));
  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/users/profile`,
    collection
  };
};

const patchJson = (url, body, headers = {}) =>
  fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  }).then(async (response) => ({
    status: response.status,
    body: await response.json()
  }));

const writeCalls = (collection) =>
  collection.calls.filter((call) => call.type === 'findOneAndUpdate');

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('user profile route factory and controller require injected actor dependencies', () => {
  const controller = createUserController();

  assert.throws(
    () => createUserRoutes({ controller }),
    (error) => error instanceof TypeError && /requireActor/.test(error.message)
  );
  assert.throws(
    () => createUserController({ getActor: null }),
    (error) => error instanceof TypeError && /getActor/.test(error.message)
  );
  assert.equal('default' in userRoutesModule, false);
});

test('authenticated customer can update all own profile fields', async () => {
  const { baseUrl, collection } = await startServer({
    actor: { ...customerActor, id: customerUser._id.toHexString() }
  });
  const response = await patchJson(baseUrl, {
    name: '  Updated Customer  ',
    image: 'https://cdn.example.com/new-avatar.jpg',
    phone: ' 555-2222 ',
    area: '  North Area ',
    bio: '  Updated bio. '
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.message, 'Profile updated successfully.');
  assert.equal(response.body.user.name, 'Updated Customer');
  assert.equal(response.body.user.image, 'https://cdn.example.com/new-avatar.jpg');
  assert.equal(response.body.user.phone, '555-2222');
  assert.equal(response.body.user.area, 'North Area');
  assert.equal(response.body.user.bio, 'Updated bio.');

  const writes = writeCalls(collection);
  assert.equal(writes.length, 1);
  assert.equal(String(writes[0].filter._id), customerUser._id.toHexString());
  assert.equal(writes[0].update.$set.name, 'Updated Customer');
  assert.equal(writes[0].update.$set.image, 'https://cdn.example.com/new-avatar.jpg');
  assert.equal(writes[0].update.$set.phone, '555-2222');
  assert.equal(writes[0].update.$set.area, 'North Area');
  assert.equal(writes[0].update.$set.bio, 'Updated bio.');
  assert.ok(writes[0].update.$set.updatedAt instanceof Date);
  assert.equal(writes[0].update.$set.email, undefined);
  assert.equal(writes[0].update.$set.role, undefined);
  assert.equal(writes[0].update.$set._id, undefined);
  assert.equal(writes[0].update.$set.createdAt, undefined);
});

test('partial profile update leaves unrelated fields untouched', async () => {
  const { baseUrl, collection } = await startServer();
  const response = await patchJson(baseUrl, { phone: ' 555-9999 ' });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.name, customerUser.name);
  assert.equal(response.body.user.image, customerUser.image);
  assert.equal(response.body.user.area, customerUser.area);
  assert.equal(response.body.user.bio, customerUser.bio);
  assert.equal(response.body.user.phone, '555-9999');

  const writes = writeCalls(collection);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].update.$set).sort(), [
    'phone',
    'updatedAt'
  ]);
});

test('missing or malformed actors fail closed with 401 even with identity headers', async () => {
  const missing = await startServer({ attachActor: false });
  const missingResponse = await patchJson(
    missing.baseUrl,
    { name: 'Spoofed Name' },
    {
      'x-user-id': customerUser._id.toHexString(),
      'x-user-email': customerUser.email,
      'x-user-role': 'customer'
    }
  );

  assert.equal(missingResponse.status, 401);
  assert.equal(missingResponse.body.error.code, 'UNAUTHORIZED');
  assert.equal(writeCalls(missing.collection).length, 0);

  const malformed = await startServer({
    actor: { ...customerActor, email: 'not-an-email' }
  });
  const malformedResponse = await patchJson(malformed.baseUrl, {
    name: 'Spoofed Name'
  });

  assert.equal(malformedResponse.status, 401);
  assert.equal(malformedResponse.body.error.code, 'UNAUTHORIZED');
  assert.equal(writeCalls(malformed.collection).length, 0);
});

test('invalid actors and canonical database identity mismatches fail closed', async () => {
  const invalidId = await startServer({
    actor: { ...customerActor, id: 'not-an-object-id' }
  });
  const invalidIdResponse = await patchJson(invalidId.baseUrl, {
    name: 'Spoofed Name'
  });
  assert.equal(invalidIdResponse.status, 401);
  assert.equal(invalidIdResponse.body.error.code, 'UNAUTHORIZED');

  const cases = [
    {
      name: 'role mismatch',
      options: {
        actor: { ...customerActor, role: 'technician' }
      }
    },
    {
      name: 'database id mismatch',
      options: { actor: { ...customerActor, id: otherUser._id } }
    },
    {
      name: 'database email mismatch',
      options: { actor: { ...customerActor, email: otherUser.email } }
    },
    {
      name: 'missing canonical user',
      options: { actor: { ...customerActor, email: 'missing@example.com' } }
    }
  ];

  for (const testCase of cases) {
    const { baseUrl, collection } = await startServer(testCase.options);
    const response = await patchJson(baseUrl, { name: 'Spoofed Name' });
    assert.equal(response.status, 403, testCase.name);
    assert.equal(response.body.error.code, 'FORBIDDEN', testCase.name);
    assert.equal(writeCalls(collection).length, 0, testCase.name);
  }
});

test('missing user at write time returns centralized 404', async () => {
  const { baseUrl } = await startServer({ missingAtWrite: true });
  const response = await patchJson(baseUrl, { name: 'Updated Customer' });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

test('invalid field values are rejected before any database write', async () => {
  const { baseUrl, collection } = await startServer();
  const invalidBodies = [
    { name: '   ' },
    { image: 'not-a-url' },
    { phone: 555 },
    {}
  ];

  for (const body of invalidBodies) {
    const response = await patchJson(baseUrl, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'INVALID_PROFILE_UPDATE');
  }

  assert.equal(writeCalls(collection).length, 0);
});

test('unknown and protected fields are rejected before any database write', async () => {
  const { baseUrl, collection } = await startServer();
  const protectedBodies = [
    { role: 'admin' },
    { email: 'new@example.com' },
    { _id: otherUser._id.toHexString() },
    { createdAt: new Date().toISOString() },
    { updatedAt: new Date().toISOString() },
    { status: 'active' },
    { passwordHash: 'injected-hash' },
    { accessToken: 'injected-token' },
    { photo: 'https://cdn.example.com/injected.jpg' }
  ];

  for (const body of protectedBodies) {
    const response = await patchJson(baseUrl, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'INVALID_PROFILE_UPDATE');
  }

  assert.equal(writeCalls(collection).length, 0);
});

test('actor identity prevents updating another user profile', async () => {
  const spoofedBody = await startServer({ users: [customerUser, otherUser] });
  const spoofedResponse = await patchJson(spoofedBody.baseUrl, {
    id: otherUser._id.toHexString(),
    userId: otherUser._id.toHexString(),
    email: otherUser.email,
    name: 'Spoofed Name'
  });

  assert.equal(spoofedResponse.status, 400);
  assert.equal(spoofedResponse.body.error.code, 'INVALID_PROFILE_UPDATE');
  assert.equal(writeCalls(spoofedBody.collection).length, 0);
  assert.equal(spoofedBody.collection.stored[1].name, otherUser.name);

  const wrongActor = await startServer({
    users: [customerUser, otherUser],
    actor: { ...customerActor, id: otherUser._id }
  });
  const wrongActorResponse = await patchJson(wrongActor.baseUrl, {
    name: 'Spoofed Name'
  });

  assert.equal(wrongActorResponse.status, 403);
  assert.equal(wrongActorResponse.body.error.code, 'FORBIDDEN');
  assert.equal(writeCalls(wrongActor.collection).length, 0);
  assert.equal(wrongActor.collection.stored[1].name, otherUser.name);
});

test('profile response uses an explicit safe user projection', async () => {
  const { baseUrl } = await startServer();
  const response = await patchJson(baseUrl, { name: 'Safer Name' });

  assert.equal(response.status, 200);
  assert.deepEqual(
    Object.keys(response.body.user).sort(),
    [...USER_PROFILE_FIELDS].sort()
  );
  assert.equal(response.body.user.passwordHash, undefined);
  assert.equal(response.body.user.accessToken, undefined);
  assert.equal(response.body.user.sessions, undefined);
  assert.equal(response.body.user.internalNote, undefined);
});
