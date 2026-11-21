import { pathToFileURL } from 'node:url';
import {
  ACTIVE_BOOKING_STATUSES,
  emailSchema,
  objectIdSchema
} from '../src/validators/index.js';

export const MIGRATION_CONFIRMATION_TOKEN = 'CANCEL_DUPLICATE_BOOKINGS';

const STATUS_PRIORITY = Object.freeze({
  'in-progress': 0,
  accepted: 1,
  requested: 2
});

const toIdString = (value) =>
  value && typeof value.toHexString === 'function'
    ? value.toHexString()
    : String(value ?? '');

const inspectRecord = (record) => {
  const reasons = [];
  const emailResult = emailSchema.safeParse(record?.customerEmail);
  const serviceResult = objectIdSchema.safeParse(record?.serviceId);
  const idResult = objectIdSchema.safeParse(record?._id);

  if (!emailResult.success) {
    reasons.push('invalid customerEmail');
  }
  if (!serviceResult.success) {
    reasons.push('invalid serviceId');
  }
  if (!idResult.success) {
    reasons.push('invalid _id');
  }
  if (!ACTIVE_BOOKING_STATUSES.includes(record?.status)) {
    reasons.push('invalid active status');
  }
  if (!(record?.createdAt instanceof Date) || Number.isNaN(record.createdAt.getTime())) {
    reasons.push('invalid createdAt');
  }

  return { valid: reasons.length === 0, reasons };
};

const summarizeRecord = (record, reasons = []) => ({
  _id: toIdString(record?._id),
  customerEmail: record?.customerEmail,
  normalizedCustomerEmail:
    emailSchema.safeParse(record?.customerEmail).data ?? String(record?.customerEmail ?? '').toLowerCase(),
  serviceId: toIdString(
    objectIdSchema.safeParse(record?.serviceId).data ?? record?.serviceId
  ),
  status: record?.status,
  createdAt: record?.createdAt instanceof Date ? record.createdAt.toISOString() : null,
  reasons: [...reasons]
});

const compareRecords = (left, right) => {
  const statusDifference = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];

  if (statusDifference !== 0) {
    return statusDifference;
  }

  const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();

  if (createdDifference !== 0) {
    return createdDifference;
  }

  return toIdString(left._id).localeCompare(toIdString(right._id));
};

export const detectDuplicateBookingGroups = async (collection) => {
  const activeRecords = await collection
    .find({ status: { $in: [...ACTIVE_BOOKING_STATUSES] } })
    .toArray();
  const suspicious = [];
  const grouped = new Map();

  for (const record of activeRecords) {
    const inspection = inspectRecord(record);
    const summary = summarizeRecord(record, inspection.reasons);

    if (!inspection.valid) {
      suspicious.push(summary);
      continue;
    }

    const key = {
      customerEmail: summary.normalizedCustomerEmail,
      serviceId: summary.serviceId
    };
    const groupKey = JSON.stringify(key);

    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, { key, records: [] });
    }

    grouped.get(groupKey).records.push(record);
  }

  const groups = [];

  for (const { key, records } of grouped.values()) {
    if (records.length < 2) {
      continue;
    }

    const ordered = [...records].sort(compareRecords);

    groups.push({
      key,
      canonical: summarizeRecord(ordered[0]),
      duplicates: ordered.slice(1).map((record) => summarizeRecord(record)),
      records: ordered
    });
  }

  return { activeRecords: activeRecords.length, suspicious, groups };
};

const printReport = (detection, { mode, logger }) => {
  logger.info(`Active booking duplicate ${mode === 'apply' ? 'migration plan' : 'dry-run'}`);
  logger.info(`Active records inspected: ${detection.activeRecords}`);
  logger.info(`Duplicate groups: ${detection.groups.length}`);
  logger.info(`Suspicious records: ${detection.suspicious.length}`);

  if (detection.suspicious.length > 0) {
    for (const record of detection.suspicious) {
      logger.info(
        `SUSPICIOUS id=${record._id} status=${record.status} customerEmail=${record.customerEmail} serviceId=${record.serviceId} reasons=${record.reasons.join(',')}`
      );
    }
  }

  for (const group of detection.groups) {
    logger.info(
      `GROUP customerEmail=${group.key.customerEmail} serviceId=${group.key.serviceId}`
    );
    logger.info(
      `  KEEP id=${group.canonical._id} status=${group.canonical.status} createdAt=${group.canonical.createdAt}`
    );

    for (const duplicate of group.duplicates) {
      logger.info(
        `  CANCEL id=${duplicate._id} status=${duplicate.status} createdAt=${duplicate.createdAt}`
      );
    }
  }
};

export const migrateActiveBookingDuplicates = async (collection, options = {}) => {
  const {
    apply = false,
    approved = false,
    now = () => new Date(),
    logger = console
  } = options;
  const detection = await detectDuplicateBookingGroups(collection);

  printReport(detection, { mode: apply ? 'apply' : 'dry-run', logger });

  if (!apply) {
    return {
      success: true,
      mode: 'dry-run',
      reason: 'DRY_RUN',
      detection,
      changes: [],
      skipped: []
    };
  }

  if (!approved) {
    logger.error('Migration plan was not explicitly approved.');
    return {
      success: false,
      mode: 'apply',
      reason: 'PLAN_NOT_APPROVED',
      detection,
      changes: [],
      skipped: []
    };
  }

  if (detection.suspicious.length > 0) {
    logger.error('Suspicious records found; migration aborted.');
    return {
      success: false,
      mode: 'apply',
      reason: 'SUSPICIOUS_RECORDS',
      detection,
      changes: [],
      skipped: []
    };
  }

  const changes = [];
  const skipped = [];

  for (const group of detection.groups) {
    for (const record of group.duplicates) {
      const original = group.records.find((candidate) => toIdString(candidate._id) === record._id);
      const filter = {
        _id: original._id,
        status: original.status,
        customerEmail: original.customerEmail,
        serviceId: original.serviceId
      };
      const update = {
        $set: {
          status: 'cancelled',
          updatedAt: now()
        }
      };

      try {
        const result = await collection.updateOne(filter, update, { upsert: false });
        const matched = result?.matchedCount ?? (result?.modifiedCount > 0 ? 1 : 0);
        const modified = result?.modifiedCount ?? matched;

        if (matched === 1 && modified >= 1) {
          changes.push({ ...record, filter, update });
          logger.info(`CANCELLED id=${record._id}`);
        } else {
          skipped.push({ ...record, filter, reason: 'CONDITION_NOT_MATCHED' });
          logger.warn(`SKIPPED id=${record._id} reason=CONDITION_NOT_MATCHED`);
        }
      } catch (error) {
        skipped.push({ ...record, filter, reason: 'UPDATE_FAILED' });
        logger.error(`SKIPPED id=${record._id} reason=UPDATE_FAILED message=${error?.message || error}`);
      }
    }
  }

  const after = await detectDuplicateBookingGroups(collection);
  const success =
    after.groups.length === 0 &&
    after.suspicious.length === 0 &&
    skipped.length === 0;

  logger.info(
    success
      ? 'Migration complete: zero active duplicate groups remain.'
      : 'Migration failed: duplicate groups or skipped records remain.'
  );

  return {
    success,
    mode: 'apply',
    reason: success ? 'MIGRATION_COMPLETE' : 'DUPLICATES_REMAIN',
    detection,
    after,
    changes,
    skipped
  };
};

export const parseMigrationArgs = (argv = []) => {
  const result = { apply: false, confirmation: '' };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--apply') {
      result.apply = true;
      continue;
    }

    if (argument === '--confirm') {
      result.confirmation = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (argument.startsWith('--confirm=')) {
      result.confirmation = argument.slice('--confirm='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return result;
};

export const isAtlasUri = (uri) =>
  typeof uri === 'string' &&
  (uri.startsWith('mongodb+srv://') || /@[^/]*\.mongodb\.net/i.test(uri));

export const runMigrationCli = async (argv = []) => {
  const args = parseMigrationArgs(argv);
  const logger = console;

  if (args.apply && args.confirmation !== MIGRATION_CONFIRMATION_TOKEN) {
    logger.error(
      `Refusing to apply without --confirm ${MIGRATION_CONFIRMATION_TOKEN}`
    );
    return { success: false, reason: 'PLAN_NOT_APPROVED' };
  }

  const { env } = await import('../src/config/env.js');

  if (isAtlasUri(env.mongodbUri)) {
    logger.error('Refusing to run the migration against Atlas. Use a local or staging database.');
    return { success: false, reason: 'ATLAS_BLOCKED' };
  }

  const { connectDatabase, closeDatabase } = await import('../src/config/database.js');
  const { getBookingCollection } = await import('../src/db/collections.js');

  try {
    await connectDatabase();
    const result = await migrateActiveBookingDuplicates(getBookingCollection(), {
      apply: args.apply,
      approved: args.confirmation === MIGRATION_CONFIRMATION_TOKEN
    });

    if (!result.success) {
      process.exitCode = 1;
    }

    return result;
  } finally {
    await closeDatabase();
  }
};

const isDirectRun = () =>
  Boolean(process.argv[1]) &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun()) {
  runMigrationCli(process.argv.slice(2)).catch((error) => {
    console.error(`Migration failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
