process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { COLLECTION_NAMES } = await import('../src/db/collections.js');
const { INDEX_DEFINITIONS } = await import('../src/db/indexes.js');
const { initializeCollectionsAndIndexes } = await import('../src/db/initialize.js');

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
