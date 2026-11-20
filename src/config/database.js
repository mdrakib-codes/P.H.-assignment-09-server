import { MongoClient } from 'mongodb';
import { env } from './env.js';
import { configureDns } from './dns.js';
import { redactSecrets } from '../utils/redact.js';

let client = null;
let database = null;
let connectionState = 'disconnected';
let connectionPromise = null;

const driverOptions = Object.freeze({
  maxPoolSize: 10,
  serverSelectionTimeoutMS: env.isTest ? 2000 : 10000
});

const failConnection = async (pendingClient, error) => {
  connectionState = 'disconnected';
  await pendingClient.close().catch(() => {});
  const message = redactSecrets(error?.message || error);
  throw new Error(`MongoDB connection failed: ${message}`);
};

export const connectDatabase = () => {
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
      await pendingDatabase.command({ ping: 1 });
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
    await database.command({ ping: 1 }, { maxTimeMS: 1000 });
    return 'connected';
  } catch {
    return 'disconnected';
  }
};

export const closeDatabase = async () => {
  if (!client) {
    database = null;
    connectionState = 'disconnected';
    return;
  }

  const closingClient = client;
  client = null;
  database = null;
  connectionState = 'disconnecting';

  try {
    await closingClient.close();
  } finally {
    connectionState = 'disconnected';
  }
};
