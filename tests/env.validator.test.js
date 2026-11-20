import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateEnv } from '../src/validators/env.validator.js';
import { redactSecrets } from '../src/utils/redact.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseEnv = {
  NODE_ENV: 'development',
  PORT: '5000',
  CLIENT_ORIGIN: 'http://localhost:3000'
};
const validUri = 'mongodb+srv://user:pass@cluster0.example.net/fixmate?retryWrites=true';

test('requires MONGODB_URI', () => {
  assert.throws(
    () => validateEnv({ ...baseEnv, MONGODB_URI: '' }),
    /MONGODB_URI is required/
  );
});

test('rejects a non-MongoDB URI', () => {
  assert.throws(
    () => validateEnv({ ...baseEnv, MONGODB_URI: 'https://example.com/fixmate' }),
    /valid mongodb/
  );
});

test('rejects placeholder Atlas credentials', () => {
  assert.throws(
    () =>
      validateEnv({
        ...baseEnv,
        MONGODB_URI: 'mongodb+srv://<username>:<password>@cluster.example.com/fixmate'
      }),
    /placeholder/
  );
});

test('accepts a valid MongoDB URI and trims whitespace', () => {
  const parsed = validateEnv({ ...baseEnv, MONGODB_URI: `  ${validUri}  ` });
  assert.equal(parsed.MONGODB_URI, validUri);
  assert.equal(parsed.PORT, 5000);
});

test('accepts a validated MongoDB DNS server list', () => {
  const parsed = validateEnv({
    ...baseEnv,
    MONGODB_URI: validUri,
    MONGODB_DNS_SERVERS: '8.8.8.8, 8.8.4.4'
  });

  assert.equal(parsed.MONGODB_DNS_SERVERS, '8.8.8.8, 8.8.4.4');
});

test('rejects invalid MongoDB DNS server values without echoing them', () => {
  assert.throws(
    () =>
      validateEnv({
        ...baseEnv,
        MONGODB_URI: validUri,
        MONGODB_DNS_SERVERS: 'dns.example.com'
      }),
    /MONGODB_DNS_SERVERS must contain only comma-separated IP addresses/
  );
});

test('redacts connection strings and embedded credentials', () => {
  const redacted = redactSecrets(
    `failed to connect: mongodb+srv://admin:secret@cluster0.example.net/fixmate`
  );
  assert.doesNotMatch(redacted, /admin|secret|mongodb\+srv:\/\//);
  assert.match(redacted, /REDACTED/);
});

test('server exits non-zero when MONGODB_URI is missing', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, MONGODB_URI: '', NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 15000
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /MONGODB_URI/);
});

test('server exits non-zero when MONGODB_URI is invalid', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, MONGODB_URI: 'not-a-mongodb-uri', NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 15000
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /valid mongodb/i);
});

test('unreachable database prevents startup without exposing credentials', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      MONGODB_URI: 'mongodb://admin:secret@127.0.0.1:27018/fixmate',
      NODE_ENV: 'test'
    },
    encoding: 'utf8',
    timeout: 15000
  });

  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /MongoDB connection failed/);
  assert.doesNotMatch(output, /admin:secret/);
});
