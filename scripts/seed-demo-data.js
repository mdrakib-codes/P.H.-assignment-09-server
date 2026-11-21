import { pathToFileURL } from 'node:url';
import { checkSeedGuards, parseSeedArgs, seedDemoData } from '../src/seeds/demo.seed.js';
import { redactSecrets } from '../src/utils/redact.js';

export const runSeedCli = async (argv = [], options = {}) => {
  const args = parseSeedArgs(argv);
  const logger = options.logger ?? console;
  const setExitCode = options.setExitCode ?? ((code) => {
    process.exitCode = code;
  });
  const env = options.env ?? (await import('../src/config/env.js')).env;
  const guard = checkSeedGuards({
    apply: args.apply,
    confirmation: args.confirmation,
    allowDevelopment: args.allowDevelopment,
    nodeEnv: env.nodeEnv,
    mongodbUri: env.mongodbUri
  });

  if (!guard.ok) {
    logger.error(`Seed aborted: ${guard.reason}`);
    setExitCode(1);
    return { success: false, reason: guard.reason };
  }

  const databaseModule =
    options.databaseModule ?? (await import('../src/config/database.js'));
  const collectionsModule =
    options.collectionsModule ?? (await import('../src/db/collections.js'));

  try {
    await databaseModule.connectDatabase();

    const collections = {
      users: collectionsModule.getCollection('users'),
      services: collectionsModule.getCollection('services'),
      bookings: collectionsModule.getCollection('bookings'),
      payments: collectionsModule.getCollection('payments')
    };
    const result = await seedDemoData(collections, {
      apply: args.apply,
      confirmation: args.confirmation,
      allowDevelopment: args.allowDevelopment,
      nodeEnv: env.nodeEnv,
      mongodbUri: env.mongodbUri,
      logger
    });

    if (!result.success) {
      setExitCode(1);
    }

    return result;
  } catch (error) {
    logger.error(`Seed failed: ${redactSecrets(error?.message || error)}`);
    setExitCode(1);
    return { success: false, reason: 'SEED_ERROR' };
  } finally {
    await databaseModule.closeDatabase();
  }
};

const isDirectRun = () =>
  Boolean(process.argv[1]) &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun()) {
  runSeedCli(process.argv.slice(2)).catch((error) => {
    console.error(`Seed failed: ${redactSecrets(error?.message || error)}`);
    process.exitCode = 1;
  });
}
