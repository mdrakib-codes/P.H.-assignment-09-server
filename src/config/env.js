import dotenv from 'dotenv';
import { validateEnv } from '../validators/env.validator.js';

dotenv.config({ quiet: true });

const raw = validateEnv(process.env);

const configuredOrigins = [
  ...(raw.CLIENT_ORIGIN ? [raw.CLIENT_ORIGIN] : []),
  ...(raw.CLIENT_ORIGINS ? raw.CLIENT_ORIGINS.split(',') : [])
]
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const developmentDefaults = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const allowedOrigins =
  raw.NODE_ENV === 'production'
    ? configuredOrigins
    : configuredOrigins.length > 0
      ? configuredOrigins
      : developmentDefaults;

const mongodbDnsServers = (raw.MONGODB_DNS_SERVERS || '')
  .split(',')
  .map((server) => server.trim())
  .filter(Boolean);

const uriPath = new URL(raw.MONGODB_URI).pathname.replace(/^\//, '');
const uriDatabaseName = decodeURIComponent(uriPath.split('/')[0] || '');
const mongodbDbName = uriDatabaseName || 'fixmate';

if (!/^[A-Za-z0-9_-]+$/.test(mongodbDbName)) {
  throw new Error(
    'Invalid environment configuration: MONGODB_URI database name may only use letters, numbers, hyphens, and underscores.'
  );
}

export const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  port: raw.PORT,
  allowedOrigins: [...new Set(allowedOrigins)],
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  mongodbUri: raw.MONGODB_URI,
  mongodbDbName,
  mongodbDnsServers
});
