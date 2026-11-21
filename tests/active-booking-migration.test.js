import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { test } from 'node:test';

const {
  detectDuplicateBookingGroups,
  migrateActiveBookingDuplicates,
  parseMigrationArgs,
  isAtlasUri,
  MIGRATION_CONFIRMATION_TOKEN
} = await import('../scripts/migrate-active-booking-duplicates.js');

const serviceId = new ObjectId();

const makeLogger = () => {
  const entries = { info: [], warn: [], error: [] };

  return {
    entries,
    info(message) {
      entries.info.push(message);
    },
    warn(message) {
      entries.warn.push(message);
    },
    error(message) {
      entries.error.push(message);
    }
  };
};

const matches = (document, filter) =>
  Object.entries(filter).every(([field, expected]) => {
    if (expected?.$in) {
      return expected.$in.some((value) => String(document[field]) === String(value));
    }
    return String(document[field]) === String(expected);
  });

const makeCollection = (documents = [], options = {}) => {
  const writeCalls = [];

  return {
    documents,
    writeCalls,
    find(filter) {
      writeCalls.push({ type: 'find', filter });
      return {
        async toArray() {
          return documents.filter((document) => matches(document, filter));
        }
      };
    },
    async updateOne(filter, update, updateOptions) {
      writeCalls.push({ type: 'updateOne', filter, update, updateOptions });
      if (options.beforeUpdate) {
        await options.beforeUpdate(filter, update);
      }
      const index = documents.findIndex((document) => matches(document, filter));

      if (index === -1) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      Object.assign(documents[index], update.$set ?? {});
      return { matchedCount: 1, modifiedCount: 1 };
    }
  };
};

const makeRecord = (overrides = {}) => ({
  _id: new ObjectId(),
  serviceId,
  customerEmail: 'Customer@Example.com',
  customerName: 'Test Customer',
  status: 'requested',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  paymentSessionId: 'cs_test_historical',
  ...overrides
});

test('dry-run detects normalized duplicate groups with deterministic priority and no writes', async () => {
  const inProgressId = new ObjectId();
  const acceptedId = new ObjectId();
  const requestedId = new ObjectId();
  const collection = makeCollection([
    makeRecord({
      _id: inProgressId,
      customerEmail: 'Customer@Example.COM',
      status: 'in-progress',
      createdAt: new Date('2026-01-05T00:00:00.000Z')
    }),
    makeRecord({
      _id: requestedId,
      customerEmail: 'customer@example.com',
      status: 'requested',
      createdAt: new Date('2026-01-02T00:00:00.000Z')
    }),
    makeRecord({
      _id: acceptedId,
      customerEmail: 'CUSTOMER@example.com',
      status: 'accepted',
      createdAt: new Date('2026-01-03T00:00:00.000Z')
    })
  ]);
  const logger = makeLogger();

  const result = await migrateActiveBookingDuplicates(collection, { logger });

  assert.equal(result.success, true);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.detection.groups.length, 1);
  assert.equal(result.detection.groups[0].canonical._id, inProgressId.toHexString());
  assert.deepEqual(
    result.detection.groups[0].duplicates.map((record) => record._id),
    [acceptedId.toHexString(), requestedId.toHexString()]
  );
  assert.equal(
    writeCallsOfType(collection, 'updateOne').length,
    0
  );
  assert.ok(logger.entries.info.some((line) => line.includes('KEEP')));
  assert.ok(logger.entries.info.some((line) => line.includes('CANCEL')));
});

test('canonical selection uses earliest createdAt then lowest id for equal status', async () => {
  const laterId = new ObjectId();
  const earlierId = new ObjectId();
  const lowerId = new ObjectId('000000000000000000000001');
  const higherId = new ObjectId('000000000000000000000002');
  const sameTime = new Date('2026-01-01T00:00:00.000Z');
  const collection = makeCollection([
    makeRecord({
      _id: laterId,
      status: 'requested',
      createdAt: new Date('2026-01-03T00:00:00.000Z')
    }),
    makeRecord({
      _id: earlierId,
      status: 'requested',
      createdAt: new Date('2026-01-02T00:00:00.000Z')
    })
  ]);
  const tiedCollection = makeCollection([
    makeRecord({ _id: higherId, status: 'accepted', createdAt: sameTime }),
    makeRecord({ _id: lowerId, status: 'accepted', createdAt: sameTime })
  ]);

  const byDate = await detectDuplicateBookingGroups(collection);
  const byId = await detectDuplicateBookingGroups(tiedCollection);

  assert.equal(byDate.groups[0].canonical._id, earlierId.toHexString());
  assert.equal(byId.groups[0].canonical._id, lowerId.toHexString());
});

test('suspicious records are reported, excluded from the plan, and block apply', async () => {
  const collection = makeCollection([
    makeRecord({ status: 'requested' }),
    makeRecord({ status: 'accepted', customerEmail: 'not-an-email' })
  ]);
  const logger = makeLogger();

  const result = await migrateActiveBookingDuplicates(collection, {
    apply: true,
    approved: true,
    logger
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'SUSPICIOUS_RECORDS');
  assert.equal(result.detection.suspicious.length, 1);
  assert.equal(result.detection.suspicious[0].reasons[0], 'invalid customerEmail');
  assert.equal(result.detection.groups.length, 0);
  assert.equal(writeCallsOfType(collection, 'updateOne').length, 0);
  assert.ok(logger.entries.error.some((line) => line.includes('Suspicious')));
});

test('apply without explicit approval aborts before writing', async () => {
  const collection = makeCollection([
    makeRecord({ status: 'requested' }),
    makeRecord({ status: 'accepted' })
  ]);
  const logger = makeLogger();

  const result = await migrateActiveBookingDuplicates(collection, {
    apply: true,
    approved: false,
    logger
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'PLAN_NOT_APPROVED');
  assert.equal(writeCallsOfType(collection, 'updateOne').length, 0);
});

test('approved apply cancels only duplicates with conditional updates and is idempotent', async () => {
  const canonical = makeRecord({
    _id: new ObjectId('000000000000000000000010'),
    customerEmail: 'Customer@Example.com',
    status: 'in-progress'
  });
  const acceptedDuplicate = makeRecord({
    _id: new ObjectId('000000000000000000000011'),
    customerEmail: 'customer@example.com',
    status: 'accepted'
  });
  const requestedDuplicate = makeRecord({
    _id: new ObjectId('000000000000000000000012'),
    customerEmail: 'CUSTOMER@EXAMPLE.COM',
    status: 'requested'
  });
  const collection = makeCollection([canonical, acceptedDuplicate, requestedDuplicate]);
  const changedAt = new Date('2026-03-01T00:00:00.000Z');
  const logger = makeLogger();

  const result = await migrateActiveBookingDuplicates(collection, {
    apply: true,
    approved: true,
    now: () => changedAt,
    logger
  });

  assert.equal(result.success, true);
  assert.equal(result.reason, 'MIGRATION_COMPLETE');
  assert.equal(result.changes.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.after.groups.length, 0);
  assert.equal(canonical.status, 'in-progress');
  assert.equal(acceptedDuplicate.status, 'cancelled');
  assert.equal(requestedDuplicate.status, 'cancelled');
  assert.equal(acceptedDuplicate.customerName, 'Test Customer');
  assert.equal(acceptedDuplicate.serviceId, serviceId);
  assert.equal(acceptedDuplicate.paymentSessionId, 'cs_test_historical');
  assert.deepEqual(acceptedDuplicate.createdAt, new Date('2026-01-01T00:00:00.000Z'));
  assert.deepEqual(acceptedDuplicate.updatedAt, changedAt);

  const updates = writeCallsOfType(collection, 'updateOne');
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].filter, {
    _id: acceptedDuplicate._id,
    status: 'accepted',
    customerEmail: 'customer@example.com',
    serviceId
  });
  assert.deepEqual(updates[0].update, {
    $set: { status: 'cancelled', updatedAt: changedAt }
  });
  assert.equal(updates[0].updateOptions.upsert, false);

  const rerun = await migrateActiveBookingDuplicates(collection, {
    apply: true,
    approved: true,
    now: () => changedAt,
    logger
  });

  assert.equal(rerun.success, true);
  assert.equal(rerun.changes.length, 0);
  assert.equal(rerun.detection.groups.length, 0);
});

test('conditional update skips a duplicate whose status changed after inspection', async () => {
  const acceptedDuplicate = makeRecord({
    _id: new ObjectId('000000000000000000000021'),
    status: 'accepted'
  });
  const collection = makeCollection(
    [
      makeRecord({ _id: new ObjectId('000000000000000000000019'), status: 'in-progress' }),
      makeRecord({ _id: new ObjectId('000000000000000000000020'), status: 'requested' }),
      acceptedDuplicate
    ],
    {
      beforeUpdate: (filter) => {
        if (String(filter._id) === String(acceptedDuplicate._id)) {
          acceptedDuplicate.status = 'rejected';
        }
      }
    }
  );
  const logger = makeLogger();

  const result = await migrateActiveBookingDuplicates(collection, {
    apply: true,
    approved: true,
    logger
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'DUPLICATES_REMAIN');
  assert.equal(acceptedDuplicate.status, 'rejected');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'CONDITION_NOT_MATCHED');
  assert.ok(logger.entries.warn.some((line) => line.includes('SKIPPED')));
});

test('CLI argument parsing and Atlas guard require explicit approval', () => {
  assert.deepEqual(parseMigrationArgs([]), { apply: false, confirmation: '' });
  assert.deepEqual(parseMigrationArgs(['--apply', '--confirm', MIGRATION_CONFIRMATION_TOKEN]), {
    apply: true,
    confirmation: MIGRATION_CONFIRMATION_TOKEN
  });
  assert.throws(() => parseMigrationArgs(['--unknown']), /Unknown argument/);
  assert.equal(isAtlasUri('mongodb+srv://user:pass@cluster.example.mongodb.net/db'), true);
  assert.equal(isAtlasUri('mongodb://127.0.0.1:27017/fixmate'), false);
});

const writeCallsOfType = (collection, type) =>
  collection.writeCalls.filter((call) => call.type === type);
