import { MongoClient } from 'mongodb';
import { env } from './env.js';
import { configureDns } from './dns.js';
import { redactSecrets } from '../utils/redact.js';

let client = null;
let database = null;
let connectionState = 'disconnected';
let connectionPromise = null;
let closePromise = null;
let connectionClosed = false;

const driverOptions = Object.freeze({
  maxPoolSize: 10,
  serverSelectionTimeoutMS: env.isTest ? 2000 : 10000
});
const HEALTH_PING_TIMEOUT_MS = 1000;
const INITIALIZATION_PING_TIMEOUT_MS = env.initializationPingTimeoutMs ?? HEALTH_PING_TIMEOUT_MS;
const closedClients = new WeakSet();

const closeClientOnce = async (targetClient, { ignoreErrors = false } = {}) => {
  if (!targetClient || closedClients.has(targetClient)) {
    return;
  }

  closedClients.add(targetClient);

  try {
    await targetClient.close();
  } catch (error) {
    if (!ignoreErrors) {
      throw error;
    }
  }
};

const withTimeout = (operation, timeoutMs, message) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);

    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const failConnection = async (pendingClient, error) => {
  connectionState = 'disconnected';
  await closeClientOnce(pendingClient, { ignoreErrors: true });
  const message = redactSecrets(error?.message || error);
  throw new Error(`MongoDB connection failed: ${message}`);
};

export const connectDatabase = () => {
  if (connectionClosed) {
    return Promise.reject(new Error('MongoDB connection is closed.'));
  }

  if (connectionState === 'connected' && database) {
    return Promise.resolve(database);
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  configureDns();
  connectionState = 'connecting';
  const pendingClient = new MongoClient(env.mongodbUri, driverOptions);

  connectionPromise = (async () => {
    try {
      await pendingClient.connect();
      const pendingDatabase = pendingClient.db(env.mongodbDbName);
      await withTimeout(
        pendingDatabase.command(
          { ping: 1 },
          { maxTimeMS: INITIALIZATION_PING_TIMEOUT_MS }
        ),
        INITIALIZATION_PING_TIMEOUT_MS,
        'MongoDB initialization ping timed out.'
      );
      client = pendingClient;
      database = pendingDatabase;
      connectionState = 'connected';
      return database;
    } catch (error) {
      return failConnection(pendingClient, error);
    }
  })().finally(() => {
    connectionPromise = null;
  });

  return connectionPromise;
};

export const getDb = () => {
  if (!database || connectionState !== 'connected') {
    throw new Error('MongoDB is not connected.');
  }
  return database;
};

export const getMongoClient = () => {
  if (!client || connectionState !== 'connected') {
    throw new Error('MongoDB client is not connected.');
  }
  return client;
};

export const getDatabaseStatus = () => connectionState;

export const checkDatabaseHealth = async () => {
  if (connectionState !== 'connected' || !database) {
    return 'disconnected';
  }

  try {
    await database.command({ ping: 1 }, { maxTimeMS: HEALTH_PING_TIMEOUT_MS });
    return 'connected';
  } catch {
    return 'disconnected';
  }
};

export const closeDatabase = () => {
  if (closePromise) {
    return closePromise;
  }

  connectionClosed = true;
  if (client || connectionPromise) {
    connectionState = 'disconnecting';
  }

  closePromise = (async () => {
    const pendingConnection = connectionPromise;

    if (pendingConnection) {
      try {
        await pendingConnection;
      } catch {}
    }

    const closingClient = client;
    client = null;
    database = null;

    if (closingClient) {
      try {
        await closeClientOnce(closingClient);
      } finally {
        connectionState = 'disconnected';
      }
    }
  })().finally(() => {
    client = null;
    database = null;
    connectionState = 'disconnected';
    closePromise = null;
  });

  return closePromise;
};
