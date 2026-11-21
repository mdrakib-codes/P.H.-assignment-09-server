import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { test } from 'node:test';

const {
  analyzeSeedPlan,
  buildSeedData,
  checkSeedGuards,
  parseSeedArgs,
  SEED_CONFIRMATION_TOKEN,
  SEED_IDS,
  seedDemoData,
  validateSeedDataset
} = await import('../src/seeds/demo.seed.js');
const { runSeedCli } = await import('../scripts/seed-demo-data.js');

const DAY_MS = 86_400_000;
const LOCAL_MONGODB_URI = 'mongodb://127.0.0.1:27017/fixmate_seed_cli_test';
const NON_EXISTENT_DOTENV_PATH = path.join(os.tmpdir(), 'fixmate-seed-cli-no-dotenv');
const APPLY_OPTIONS = Object.freeze({
  apply: true,
  confirmation: SEED_CONFIRMATION_TOKEN,
  allowDevelopment: true
});

const makeCliEnv = ({
  nodeEnv = 'development',
  mongodbUri = LOCAL_MONGODB_URI
} = {}) => ({ nodeEnv, mongodbUri });

const setEnvVar = (name, value) => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

const importRealProductionEnv = async () => {
  const names = [
    'NODE_ENV',
    'MONGODB_URI',
    'CLIENT_ORIGIN',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'DOTENV_CONFIG_PATH',
    'DOTENV_PATH',
    'DOTENV_QUIET'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  try {
    setEnvVar('DOTENV_CONFIG_PATH', NON_EXISTENT_DOTENV_PATH);
    setEnvVar('DOTENV_PATH', NON_EXISTENT_DOTENV_PATH);
    setEnvVar('DOTENV_QUIET', '1');
    setEnvVar('NODE_ENV', 'production');
    setEnvVar('MONGODB_URI', LOCAL_MONGODB_URI);
    setEnvVar('CLIENT_ORIGIN', 'http://localhost:3000');
    setEnvVar('STRIPE_SECRET_KEY', 'sk_test_seed_cli_guard');
    setEnvVar('STRIPE_WEBHOOK_SECRET', 'whsec_seed_cli_guard');
    return await import(`../src/config/env.js?seed-cli-guard-${Date.now()}`);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      setEnvVar(name, value);
    }
  }
};

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

const sameValue = (left, right) => {
  if (left && typeof left.toHexString === 'function') {
    return left.toHexString() === String(right);
  }
  if (right && typeof right.toHexString === 'function') {
    return String(left) === right.toHexString();
  }
  return String(left ?? '') === String(right ?? '');
};

const matches = (document, filter = {}) =>
  Object.entries(filter).every(([field, expected]) => {
    if (expected && Array.isArray(expected.$in)) {
      return expected.$in.some((candidate) => sameValue(document[field], candidate));
    }
    return sameValue(document[field], expected);
  });

const makeCollection = (documents = [], options = {}) => {
  const writeCalls = [];
  const findCalls = [];

  return {
    documents,
    writeCalls,
    findCalls,
    async findOne(filter, findOptions) {
      findCalls.push({ filter, findOptions });
      return documents.find((document) => matches(document, filter)) ?? null;
    },
    async updateOne(filter, update, updateOptions) {
      writeCalls.push({ filter, update, updateOptions });

      if (options.beforeUpdate) {
        await options.beforeUpdate(filter, update, updateOptions);
      }

      const index = documents.findIndex((document) => matches(document, filter));

      if (index >= 0) {
        return { matchedCount: 1, upsertedCount: 0 };
      }

      const inserted = update.$setOnInsert;

      if (!inserted) {
        throw new Error('Insert requires $setOnInsert.');
      }

      documents.push(inserted);
      return { matchedCount: 0, upsertedCount: 1, upsertedId: inserted._id };
    }
  };
};

const makeCollections = (dataset, existing = {}) => ({
  users: makeCollection(existing.users ?? []),
  services: makeCollection(existing.services ?? []),
  bookings: makeCollection(existing.bookings ?? []),
  payments: makeCollection(existing.payments ?? [])
});

const allWriteCalls = (collections) =>
  Object.values(collections).flatMap((collection) => collection.writeCalls);

test('buildSeedData creates a validated dataset with required accounts, services and statuses', () => {
  const dataset = buildSeedData();
  const roles = new Set(dataset.users.map((user) => user.role));
  const statuses = new Set(dataset.bookings.map((booking) => booking.status));
  const categories = new Set(dataset.services.map((service) => service.category));

  assert.equal(dataset.users.length, 6);
  assert.equal(dataset.services.length, 14);
  assert.equal(dataset.bookings.length, 6);
  assert.deepEqual(dataset.payments, []);
  assert.ok(roles.has('admin'));
  assert.ok(roles.has('technician'));
  assert.ok(roles.has('customer'));
  assert.equal(dataset.users.filter((user) => user.role === 'technician').length, 2);
  assert.equal(dataset.services.filter((service) => service.approvalStatus === 'approved').length, 14);
  assert.equal(categories.size, 7);
  assert.deepEqual([...statuses].sort(), [
    'accepted',
    'cancelled',
    'completed',
    'in-progress',
    'rejected',
    'requested'
  ]);

  for (const booking of dataset.bookings) {
    const service = dataset.services.find(
      (candidate) => candidate._id.toHexString() === booking.serviceId.toHexString()
    );

    assert.ok(service);
    assert.ok(dataset.users.some((user) => user.email === booking.customerEmail));
    assert.ok(dataset.users.some((user) => user.email === service.technicianEmail));
    assert.equal(booking.paymentStatus, 'unpaid');
  }
});

test('seed ids and relationships stay deterministic across different clock values', () => {
  const first = buildSeedData({ now: new Date() });
  const second = buildSeedData({ now: new Date(Date.now() + 7 * DAY_MS) });

  assert.deepEqual(
    first.users.map((user) => user._id.toHexString()),
    second.users.map((user) => user._id.toHexString())
  );
  assert.deepEqual(
    first.services.map((service) => service._id.toHexString()),
    second.services.map((service) => service._id.toHexString())
  );
  assert.deepEqual(
    first.bookings.map((booking) => booking.serviceId.toHexString()),
    second.bookings.map((booking) => booking.serviceId.toHexString())
  );
  assert.equal(SEED_IDS.users.admin.toHexString(), first.users[0]._id.toHexString());
});

test('dry-run returns a non-destructive plan and writes nothing', async () => {
  const dataset = buildSeedData();
  const collections = makeCollections(dataset);
  const logger = makeLogger();

  const result = await seedDemoData(collections, { dataset, logger });

  assert.equal(result.success, true);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.reason, 'DRY_RUN');
  assert.equal(result.analysis.counts.inserts, 26);
  assert.equal(result.analysis.counts.payments, 0);
  assert.equal(allWriteCalls(collections).length, 0);
  assert.ok(logger.entries.info.some((line) => line.includes('Demo seed dry-run plan')));
});

test('apply requires confirmation, development acknowledgement and non-production environment', async () => {
  const dataset = buildSeedData();
  const unconfirmed = makeCollections(dataset);
  const unconfirmedResult = await seedDemoData(unconfirmed, {
    dataset,
    logger: makeLogger(),
    apply: true
  });

  assert.equal(unconfirmedResult.success, false);
  assert.equal(unconfirmedResult.reason, 'PLAN_NOT_CONFIRMED');
  assert.equal(allWriteCalls(unconfirmed).length, 0);

  const unacknowledged = makeCollections(dataset);
  const unacknowledgedResult = await seedDemoData(unacknowledged, {
    dataset,
    logger: makeLogger(),
    apply: true,
    confirmation: SEED_CONFIRMATION_TOKEN
  });

  assert.equal(unacknowledgedResult.success, false);
  assert.equal(unacknowledgedResult.reason, 'DEVELOPMENT_NOT_CONFIRMED');
  assert.equal(allWriteCalls(unacknowledged).length, 0);

  const production = makeCollections(dataset);
  const productionResult = await seedDemoData(production, {
    dataset,
    logger: makeLogger(),
    nodeEnv: 'production',
    ...APPLY_OPTIONS
  });

  assert.equal(productionResult.success, false);
  assert.equal(productionResult.reason, 'PRODUCTION_BLOCKED');
  assert.equal(allWriteCalls(production).length, 0);
});

test('checkSeedGuards rejects Atlas connection strings', () => {
  const result = checkSeedGuards({
    mongodbUri: 'mongodb+srv://user:secret@example.mongodb.net/fixmate'
  });

  assert.deepEqual(result, { ok: false, reason: 'ATLAS_BLOCKED' });
});

test('approved apply inserts only missing records and a second run is a no-op', async () => {
  const dataset = buildSeedData();
  const collections = makeCollections(dataset);
  const logger = makeLogger();

  const applied = await seedDemoData(collections, {
    dataset,
    logger,
    ...APPLY_OPTIONS
  });

  assert.equal(applied.success, true);
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.reason, 'SEED_COMPLETE');
  assert.equal(applied.changes.length, 26);
  assert.equal(collections.users.documents.length, 6);
  assert.equal(collections.services.documents.length, 14);
  assert.equal(collections.bookings.documents.length, 6);
  assert.equal(collections.payments.documents.length, 0);

  const writes = allWriteCalls(collections);

  for (const write of writes) {
    assert.equal(write.updateOptions.upsert, true);
    assert.ok(write.update.$setOnInsert);
    assert.equal(write.update.$set, undefined);
  }

  const writeCount = writes.length;
  const rerunDataset = buildSeedData({ now: new Date(Date.now() + DAY_MS) });
  const rerun = await seedDemoData(collections, {
    dataset: rerunDataset,
    logger: makeLogger(),
    ...APPLY_OPTIONS
  });

  assert.equal(rerun.success, true);
  assert.equal(rerun.reason, 'ALREADY_SEEDED');
  assert.equal(rerun.changes.length, 0);
  assert.equal(allWriteCalls(collections).length, writeCount);
  assert.equal(collections.users.documents.length, 6);
  assert.equal(collections.services.documents.length, 14);
  assert.equal(collections.bookings.documents.length, 6);
});

test('existing record conflicts abort apply before any write', async () => {
  const dataset = buildSeedData();
  const conflictingUser = {
    ...dataset.users[0],
    name: 'Different Administrator'
  };
  const collections = makeCollections(dataset, { users: [conflictingUser] });

  const result = await seedDemoData(collections, {
    dataset,
    logger: makeLogger(),
    ...APPLY_OPTIONS
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'SEED_CONFLICT');
  assert.equal(result.analysis.plan.conflicts[0].reason, 'SEED_ID_CONFLICT');
  assert.ok(result.analysis.plan.conflicts[0].differences.includes('name'));
  assert.equal(allWriteCalls(collections).length, 0);

  const naturalKeyUser = {
    ...dataset.users[0],
    _id: new ObjectId()
  };
  const naturalCollections = makeCollections(dataset, { users: [naturalKeyUser] });
  const naturalResult = await seedDemoData(naturalCollections, {
    dataset,
    logger: makeLogger(),
    ...APPLY_OPTIONS
  });

  assert.equal(naturalResult.success, false);
  assert.equal(naturalResult.reason, 'SEED_CONFLICT');
  assert.equal(
    naturalResult.analysis.plan.conflicts[0].reason,
    'SEED_NATURAL_KEY_CONFLICT'
  );
  assert.equal(allWriteCalls(naturalCollections).length, 0);
});

test('validateSeedDataset rejects payment records and duplicate active booking pairs', () => {
  const dataset = buildSeedData();
  const fakePayment = {
    _id: new ObjectId(),
    bookingId: dataset.bookings[0]._id,
    serviceTitle: dataset.bookings[0].serviceTitle,
    customerName: dataset.bookings[0].customerName,
    customerEmail: dataset.bookings[0].customerEmail,
    technicianName: dataset.bookings[0].technicianName,
    technicianEmail: dataset.bookings[0].technicianEmail,
    amount: 129,
    currency: 'usd',
    transactionId: 'fake_transaction',
    paymentStatus: 'paid',
    paidAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date()
  };

  assert.throws(
    () => validateSeedDataset({ ...dataset, payments: [fakePayment] }),
    /must not include payment records/
  );

  const duplicateActive = {
    ...dataset.bookings[1],
    _id: new ObjectId(),
    customerEmail: dataset.bookings[0].customerEmail,
    serviceId: dataset.bookings[0].serviceId,
    status: 'requested'
  };

  assert.throws(
    () => validateSeedDataset({ ...dataset, bookings: [...dataset.bookings, duplicateActive] }),
    /duplicate active booking pairs/
  );
});

test('analyzeSeedPlan requires all four application collections', async () => {
  const dataset = buildSeedData();
  const collections = makeCollections(dataset);
  delete collections.payments;

  await assert.rejects(
    analyzeSeedPlan(collections, dataset),
    /Seed collection payments is unavailable/
  );
});

test('parseSeedArgs accepts only the documented apply flags', () => {
  assert.deepEqual(parseSeedArgs([]), {
    apply: false,
    confirmation: '',
    allowDevelopment: false
  });
  assert.deepEqual(
    parseSeedArgs([
      '--apply',
      '--confirm',
      SEED_CONFIRMATION_TOKEN,
      '--allow-development'
    ]),
    {
      apply: true,
      confirmation: SEED_CONFIRMATION_TOKEN,
      allowDevelopment: true
    }
  );
  assert.deepEqual(
    parseSeedArgs(['--apply', `--confirm=${SEED_CONFIRMATION_TOKEN}`, '--allow-development']),
    {
      apply: true,
      confirmation: SEED_CONFIRMATION_TOKEN,
      allowDevelopment: true
    }
  );
  assert.throws(() => parseSeedArgs(['--drop']), /Unknown argument: --drop/);
});

test('seed CLI blocks Atlas before opening a database connection', async () => {
  const logger = makeLogger();
  const exitCodes = [];
  let connectCalls = 0;
  const result = await runSeedCli([], {
    logger,
    setExitCode: (code) => exitCodes.push(code),
    env: makeCliEnv({
      mongodbUri: 'mongodb+srv://user:secret@example.mongodb.net/fixmate'
    }),
    databaseModule: {
      connectDatabase: async () => {
        connectCalls += 1;
      },
      closeDatabase: async () => {}
    },
    collectionsModule: {
      getCollection: () => {
        throw new Error('getCollection must not be called.');
      }
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'ATLAS_BLOCKED');
  assert.equal(connectCalls, 0);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(
    logger.entries.info.join('\n').includes('example.mongodb.net'),
    false
  );
  assert.equal(
    logger.entries.error.join('\n').includes('user:secret'),
    false
  );
});

test('seed CLI runs a dry-run through injected database modules', async () => {
  const dataset = buildSeedData();
  const collections = makeCollections(dataset);
  const logger = makeLogger();
  const exitCodes = [];
  let connectCalls = 0;
  let closeCalls = 0;
  let getCollectionCalls = 0;
  const result = await runSeedCli([], {
    logger,
    setExitCode: (code) => exitCodes.push(code),
    env: makeCliEnv(),
    databaseModule: {
      connectDatabase: async () => {
        connectCalls += 1;
      },
      closeDatabase: async () => {
        closeCalls += 1;
      }
    },
    collectionsModule: {
      getCollection: () => {
        getCollectionCalls += 1;
        return collections[['users', 'services', 'bookings', 'payments'][getCollectionCalls - 1]];
      }
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.reason, 'DRY_RUN');
  assert.equal(connectCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(getCollectionCalls, 4);
  assert.equal(exitCodes.length, 0);
  assert.equal(allWriteCalls(collections).length, 0);
});

test('seed CLI blocks the real production environment before database access', async () => {
  const { env } = await importRealProductionEnv();
  assert.equal(env.nodeEnv, 'production');
  assert.equal(env.isProduction, true);

  const logger = makeLogger();
  const exitCodes = [];
  const collections = makeCollections(buildSeedData());
  let connectCalls = 0;
  let closeCalls = 0;
  let getCollectionCalls = 0;

  const result = await runSeedCli(
    ['--apply', '--confirm', SEED_CONFIRMATION_TOKEN, '--allow-development'],
    {
      logger,
      setExitCode: (code) => exitCodes.push(code),
      env,
      databaseModule: {
        connectDatabase: async () => {
          connectCalls += 1;
          throw new Error('connectDatabase must not be called.');
        },
        closeDatabase: async () => {
          closeCalls += 1;
          throw new Error('closeDatabase must not be called.');
        }
      },
      collectionsModule: {
        getCollection: () => {
          getCollectionCalls += 1;
          throw new Error('getCollection must not be called.');
        }
      }
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.reason, 'PRODUCTION_BLOCKED');
  assert.equal(connectCalls, 0);
  assert.equal(closeCalls, 0);
  assert.equal(getCollectionCalls, 0);
  assert.equal(allWriteCalls(collections).length, 0);
  assert.deepEqual(exitCodes, [1]);
  assert.ok(logger.entries.error.join('\n').includes('PRODUCTION_BLOCKED'));
});

test('seed CLI applies explicitly confirmed development data', async () => {
  const dataset = buildSeedData();
  const collections = makeCollections(dataset);
  const logger = makeLogger();
  const exitCodes = [];
  let connectCalls = 0;
  let closeCalls = 0;
  let getCollectionCalls = 0;

  const result = await runSeedCli(
    ['--apply', '--confirm', SEED_CONFIRMATION_TOKEN, '--allow-development'],
    {
      logger,
      setExitCode: (code) => exitCodes.push(code),
      env: makeCliEnv(),
      databaseModule: {
        connectDatabase: async () => {
          connectCalls += 1;
        },
        closeDatabase: async () => {
          closeCalls += 1;
        }
      },
      collectionsModule: {
        getCollection: () => {
          getCollectionCalls += 1;
          return collections[['users', 'services', 'bookings', 'payments'][getCollectionCalls - 1]];
        }
      }
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.reason, 'SEED_COMPLETE');
  assert.equal(result.changes.length, 26);
  assert.equal(connectCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(getCollectionCalls, 4);
  assert.equal(allWriteCalls(collections).length, 26);
  assert.deepEqual(exitCodes, []);
});
