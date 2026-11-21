process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const { createServerLifecycle } = await import('../src/server/lifecycle.js');
const { COLLECTION_NAMES } = await import('../src/db/collections.js');
const { INDEX_DEFINITIONS } = await import('../src/db/indexes.js');
const { initializeCollectionsAndIndexes } = await import('../src/db/initialize.js');
const { ACTIVE_BOOKING_STATUSES } = await import('../src/validators/index.js');
const { CASE_INSENSITIVE_EMAIL_COLLATION } = await import('../src/db/collations.js');

const makeFakeDb = ({ namespaceExists = false } = {}) => {
  const created = [];
  const indexCalls = [];
  const dropped = [];
  const collections = new Map();

  return {
    created,
    indexCalls,
    dropped,
    async createCollection(name) {
      if (namespaceExists) {
        const error = new Error('collection already exists');
        error.code = 48;
        throw error;
      }
      created.push(name);
    },
    collection(name) {
      if (!collections.has(name)) {
        collections.set(name, {
          async createIndexes(definitions) {
            indexCalls.push({ name, definitions });
            return definitions.map((definition) => definition.name);
          }
        });
      }
      return collections.get(name);
    },
    async dropCollection(name) {
      dropped.push(name);
    }
  };
};

const databaseSource = await readFile(
  new URL('../src/config/database.js', import.meta.url),
  'utf8'
);
const databaseBody = databaseSource
  .replace(/^import .*$/gm, '')
  .replace(/export const /g, 'const ');

const loadDatabaseStateMachine = ({
  MongoClient,
  configureDns = () => {},
  redactSecrets = (value) => String(value),
  initializationPingTimeoutMs = 20
}) =>
  new Function(
    'MongoClient',
    'env',
    'configureDns',
    'redactSecrets',
    `${databaseBody}\nreturn { connectDatabase, getDatabaseStatus, getMongoClient, closeDatabase };`
  )(
    MongoClient,
    {
      mongodbUri: 'mongodb://127.0.0.1:27017/fixmate_test',
      mongodbDbName: 'fixmate_test',
      isTest: true,
      initializationPingTimeoutMs
    },
    configureDns,
    redactSecrets
  );

const makePendingClient = ({ pingMode = 'success' } = {}) => {
  const calls = { constructed: 0, connect: 0, close: 0, db: 0, ping: 0 };
  let resolveConnect;
  let rejectConnect;
  const pendingDatabase = {
    command() {
      calls.ping += 1;

      if (pingMode === 'reject') {
        return Promise.reject(new Error('ping failed'));
      }

      if (pingMode === 'hang') {
        return new Promise(() => {});
      }

      return Promise.resolve({ ok: 1 });
    }
  };

  class FakeMongoClient {
    constructor() {
      calls.constructed += 1;
    }

    connect() {
      calls.connect += 1;
      return new Promise((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = reject;
      });
    }

    db() {
      calls.db += 1;
      return pendingDatabase;
    }

    async close() {
      calls.close += 1;
    }
  }

  return {
    calls,
    MongoClient: FakeMongoClient,
    resolveConnect: () => resolveConnect(),
    rejectConnect: (error) => rejectConnect(error)
  };
};

test('application data uses exactly four collections', () => {
  assert.deepEqual(Object.values(COLLECTION_NAMES), [
    'users',
    'services',
    'bookings',
    'payments'
  ]);
});

test('initialization creates four collections and all indexes without dropping data', async () => {
  const db = makeFakeDb();
  const result = await initializeCollectionsAndIndexes(db);

  assert.equal(result.created.length, 4);
  assert.equal(db.indexCalls.length, 4);
  assert.deepEqual(db.dropped, []);

  for (const name of Object.values(COLLECTION_NAMES)) {
    assert.ok(result.created.includes(name));
    assert.ok(db.indexCalls.some((call) => call.name === name));
  }
});

test('initialization is repeatable when collections already exist', async () => {
  const db = makeFakeDb({ namespaceExists: true });
  const result = await initializeCollectionsAndIndexes(db);

  assert.deepEqual(result.created, []);
  assert.equal(db.indexCalls.length, 4);
  assert.deepEqual(db.dropped, []);
});

test('initialization surfaces unexpected database errors', async () => {
  const db = makeFakeDb();
  db.createCollection = async () => {
    throw new Error('permission denied');
  };

  await assert.rejects(() => initializeCollectionsAndIndexes(db), /permission denied/);
});

test('users email index is unique and aligned with BetterAuth index naming', () => {
  const emailIndex = INDEX_DEFINITIONS.users.find(
    (definition) => definition.name === 'user_email_uidx'
  );

  assert.ok(emailIndex);
  assert.equal(emailIndex.unique, true);
  assert.deepEqual(emailIndex.key, { email: 1 });
});

test('active booking index enforces one booking per email-service pair with case-insensitive email', () => {
  const index = INDEX_DEFINITIONS.bookings.find(
    (definition) => definition.name === 'bookings_active_customer_service_uidx'
  );

  assert.ok(index);
  assert.equal(index.unique, true);
  assert.deepEqual(index.key, { customerEmail: 1, serviceId: 1 });
  assert.equal(Object.hasOwn(index.key, 'status'), false);
  assert.deepEqual(index.partialFilterExpression, {
    status: { $in: [...ACTIVE_BOOKING_STATUSES] }
  });
  assert.deepEqual(index.collation, CASE_INSENSITIVE_EMAIL_COLLATION);
  assert.deepEqual(index.collation, { locale: 'en', strength: 2 });
});

test('payments indexes enforce one payment per booking and unique Stripe sessions', () => {
  const bookingIndex = INDEX_DEFINITIONS.payments.find(
    (definition) => definition.name === 'payments_booking_id_uidx'
  );
  const sessionIndex = INDEX_DEFINITIONS.payments.find(
    (definition) => definition.name === 'payments_stripe_session_id_uidx'
  );

  assert.equal(bookingIndex.unique, true);
  assert.deepEqual(bookingIndex.partialFilterExpression, {
    bookingId: { $type: 'objectId' }
  });
  assert.equal(sessionIndex.unique, true);
  assert.deepEqual(sessionIndex.partialFilterExpression, {
    stripeSessionId: { $type: 'string' }
  });
});

test('all index definitions have names and key patterns', () => {
  for (const definitions of Object.values(INDEX_DEFINITIONS)) {
    for (const definition of definitions) {
      assert.ok(definition.name, 'index must have a name');
      assert.ok(definition.key && Object.keys(definition.key).length > 0);
    }
  }
});

test('successful initialization ping connects normally', async () => {
  const fake = makePendingClient();
  const database = loadDatabaseStateMachine({ MongoClient: fake.MongoClient });

  const connecting = database.connectDatabase();
  fake.resolveConnect();
  await connecting;

  assert.equal(database.getDatabaseStatus(), 'connected');
  assert.equal(fake.calls.ping, 1);
  assert.equal(fake.calls.close, 0);
  assert.ok(database.getMongoClient());

  await database.closeDatabase();
  assert.equal(fake.calls.close, 1);
});

test('failed initialization ping closes the constructed client', async () => {
  const fake = makePendingClient({ pingMode: 'reject' });
  const database = loadDatabaseStateMachine({ MongoClient: fake.MongoClient });

  const connecting = database.connectDatabase();
  fake.resolveConnect();
  await assert.rejects(connecting, /MongoDB connection failed: ping failed/);

  assert.equal(fake.calls.ping, 1);
  assert.equal(fake.calls.close, 1);
  assert.equal(database.getDatabaseStatus(), 'disconnected');
  assert.throws(() => database.getMongoClient(), /not connected/);

  await Promise.all([database.closeDatabase(), database.closeDatabase()]);
  assert.equal(fake.calls.close, 1);
});

test('hanging initialization ping closes the constructed client after timeout', async () => {
  const fake = makePendingClient({ pingMode: 'hang' });
  const database = loadDatabaseStateMachine({
    MongoClient: fake.MongoClient,
    initializationPingTimeoutMs: 20
  });

  const connecting = database.connectDatabase();
  fake.resolveConnect();
  await assert.rejects(connecting, /initialization ping timed out/);

  assert.equal(fake.calls.ping, 1);
  assert.equal(fake.calls.close, 1);
  assert.equal(database.getDatabaseStatus(), 'disconnected');

  await database.closeDatabase();
  assert.equal(fake.calls.close, 1);
});

test('shutdown during pending ping respects the overall deadline', { timeout: 2000 }, async () => {
  const fake = makePendingClient({ pingMode: 'hang' });
  const database = loadDatabaseStateMachine({
    MongoClient: fake.MongoClient,
    initializationPingTimeoutMs: 50
  });
  let listened = false;
  let closeCalls = 0;
  let cleanup;
  const lifecycle = createServerLifecycle({
    app: {
      listen() {
        listened = true;
        return {
          on() {},
          close(callback) {
            callback();
          }
        };
      }
    },
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: database.connectDatabase,
    closeDatabase: () => {
      closeCalls += 1;
      cleanup = database.closeDatabase();
      return cleanup;
    },
    logger: { log() {}, error() {} },
    shutdownTimeoutMs: 10
  });

  const starting = lifecycle.start();
  fake.resolveConnect();
  const startedAt = Date.now();

  await assert.rejects(() => lifecycle.shutdown('SIGTERM'), /Shutdown deadline exceeded/);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 300, `shutdown took ${elapsed}ms; expected one 10ms deadline`);
  assert.equal(listened, false);
  assert.equal(closeCalls, 1);

  await assert.rejects(starting, /initialization ping timed out/);
  await cleanup;
  assert.equal(fake.calls.close, 1);
  assert.equal(database.getDatabaseStatus(), 'disconnected');
});

test('closeDatabase closes a client created by a pending connection', async () => {
  const fake = makePendingClient();
  let dnsCalls = 0;
  const database = loadDatabaseStateMachine({
    MongoClient: fake.MongoClient,
    configureDns: () => {
      dnsCalls += 1;
    }
  });

  const connecting = database.connectDatabase();
  const closing = database.closeDatabase();

  assert.equal(database.getDatabaseStatus(), 'disconnecting');
  await assert.rejects(database.connectDatabase(), /MongoDB connection is closed/);

  fake.resolveConnect();
  await connecting;
  await closing;

  assert.deepEqual(fake.calls, { constructed: 1, connect: 1, close: 1, db: 1, ping: 1 });
  assert.equal(dnsCalls, 1);
  assert.equal(database.getDatabaseStatus(), 'disconnected');
  assert.throws(() => database.getMongoClient(), /not connected/);
});

test('closeDatabase handles connection failure while close is pending', async () => {
  const fake = makePendingClient();
  const database = loadDatabaseStateMachine({ MongoClient: fake.MongoClient });

  const connecting = database.connectDatabase();
  const closing = database.closeDatabase();
  fake.rejectConnect(new Error('connection refused'));

  await assert.rejects(connecting, /MongoDB connection failed: connection refused/);
  await closing;

  assert.equal(fake.calls.close, 1);
  assert.equal(database.getDatabaseStatus(), 'disconnected');
  assert.throws(() => database.getMongoClient(), /not connected/);
});

test('closeDatabase closes an established connection idempotently', async () => {
  const fake = makePendingClient();
  const database = loadDatabaseStateMachine({ MongoClient: fake.MongoClient });

  const connecting = database.connectDatabase();
  fake.resolveConnect();
  await connecting;
  await Promise.all([database.closeDatabase(), database.closeDatabase()]);

  assert.equal(fake.calls.close, 1);
  assert.equal(database.getDatabaseStatus(), 'disconnected');
});

test('closeDatabase prevents new connections after shutdown', async () => {
  const fake = makePendingClient();
  const database = loadDatabaseStateMachine({ MongoClient: fake.MongoClient });

  await database.closeDatabase();

  await assert.rejects(database.connectDatabase(), /MongoDB connection is closed/);
  assert.equal(fake.calls.constructed, 0);
  assert.equal(database.getDatabaseStatus(), 'disconnected');
});

test('lifecycle shutdown during connect prevents listening and closes eventual client', async () => {
  const fake = makePendingClient();
  const database = loadDatabaseStateMachine({ MongoClient: fake.MongoClient });
  let listened = false;
  const lifecycle = createServerLifecycle({
    app: {
      listen() {
        listened = true;
        return {
          on() {},
          close(callback) {
            callback();
          }
        };
      }
    },
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: database.connectDatabase,
    closeDatabase: database.closeDatabase,
    logger: { log() {}, error() {} },
    shutdownTimeoutMs: 5000
  });

  const starting = lifecycle.start();
  const stopping = lifecycle.shutdown('SIGTERM');
  fake.resolveConnect();
  await Promise.all([starting, stopping]);

  assert.equal(listened, false);
  assert.equal(fake.calls.close, 1);
  assert.equal(database.getDatabaseStatus(), 'disconnected');
  assert.equal(lifecycle.getServer(), null);
});

test('never-resolving connection respects the lifecycle deadline', { timeout: 2000 }, async () => {
  const fake = makePendingClient();
  const database = loadDatabaseStateMachine({ MongoClient: fake.MongoClient });
  let listened = false;
  let closeCalled = false;
  const lifecycle = createServerLifecycle({
    app: {
      listen() {
        listened = true;
        return {
          on() {},
          close(callback) {
            callback();
          }
        };
      }
    },
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: database.connectDatabase,
    closeDatabase: () => {
      closeCalled = true;
      return database.closeDatabase();
    },
    logger: { log() {}, error() {} },
    shutdownTimeoutMs: 30
  });

  lifecycle.start();
  const startedAt = Date.now();
  await assert.rejects(() => lifecycle.shutdown('SIGTERM'), /Shutdown deadline exceeded/);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 300, `shutdown took ${elapsed}ms; expected one 30ms deadline`);
  assert.equal(closeCalled, true);
  assert.equal(listened, false);
});
