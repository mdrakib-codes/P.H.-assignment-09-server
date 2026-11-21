import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
const noDotEnvPath = fileURLToPath(new URL('./dotenv-disabled', import.meta.url));

const readAllowedOrigins = (overrides = {}) => {
  const script =
    "import { env } from './src/config/env.js'; process.stdout.write(JSON.stringify(env.allowedOrigins));";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: noDotEnvPath,
      DOTENV_PATH: noDotEnvPath,
      DOTENV_QUIET: '1',
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/fixmate_test',
      ...overrides
    },
    encoding: 'utf8',
    timeout: 15000
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
};

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

test('rejects comma-separated values in CLIENT_ORIGIN', () => {
  assert.throws(
    () =>
      validateEnv({
        ...baseEnv,
        MONGODB_URI: validUri,
        CLIENT_ORIGIN: 'https://a.example.com,https://b.example.com'
      }),
    /CLIENT_ORIGIN must contain exactly one origin/
  );
});

test('accepts case-insensitive and trailing-slash origins during validation', () => {
  const parsed = validateEnv({
    ...baseEnv,
    MONGODB_URI: validUri,
    CLIENT_ORIGIN: '  HTTPS://APP.EXAMPLE.COM/  ',
    CLIENT_ORIGINS: ' HTTPS://B.EXAMPLE.COM/, https://app.example.com '
  });

  assert.equal(parsed.CLIENT_ORIGIN, 'HTTPS://APP.EXAMPLE.COM/');
  assert.equal(parsed.CLIENT_ORIGINS, 'HTTPS://B.EXAMPLE.COM/, https://app.example.com');
});

test('runtime normalizes and deduplicates configured origins', () => {
  const origins = readAllowedOrigins({
    CLIENT_ORIGIN: 'HTTPS://APP.EXAMPLE.COM/',
    CLIENT_ORIGINS: 'https://b.example.com/, HTTPS://APP.EXAMPLE.COM, https://b.example.com'
  });

  assert.deepEqual(origins, ['https://app.example.com', 'https://b.example.com']);
});

test('runtime exposes a normalized primary origin for payment redirects', () => {
  const origins = readAllowedOrigins({ CLIENT_ORIGIN: 'HTTPS://FIXMATE.EXAMPLE.COM/' });

  assert.deepEqual(origins, ['https://fixmate.example.com']);
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

test('production requires Stripe environment variables', () => {
  assert.throws(
    () =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        MONGODB_URI: validUri,
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: ''
      }),
    /STRIPE_WEBHOOK_SECRET is required in production/
  );
});

test('accepts and trims Stripe environment variables', () => {
  const parsed = validateEnv({
    ...baseEnv,
    NODE_ENV: 'production',
    MONGODB_URI: validUri,
    STRIPE_SECRET_KEY: '  sk_test_123  ',
    STRIPE_WEBHOOK_SECRET: '  whsec_123  '
  });

  assert.equal(parsed.STRIPE_SECRET_KEY, 'sk_test_123');
  assert.equal(parsed.STRIPE_WEBHOOK_SECRET, 'whsec_123');
});

test('accepts and trims IMGBB_API_KEY', () => {
  const parsed = validateEnv({
    ...baseEnv,
    MONGODB_URI: validUri,
    IMGBB_API_KEY: '  imgbb_server_key_123  '
  });

  assert.equal(parsed.IMGBB_API_KEY, 'imgbb_server_key_123');
});

test('rejects placeholder IMGBB_API_KEY values without echoing them', () => {
  assert.throws(
    () =>
      validateEnv({
        ...baseEnv,
        MONGODB_URI: validUri,
        IMGBB_API_KEY: 'imgbb_REPLACE_ME'
      }),
    /Replace the IMGBB_API_KEY placeholder/
  );
});

test('redacts ImgBB API keys in log-like text', () => {
  const redacted = redactSecrets('IMG BB failed: IMGBB_API_KEY=imgbb_secret_123');
  assert.doesNotMatch(redacted, /imgbb_secret_123/);
  assert.match(redacted, /REDACTED/);
});

test('example environment file documents every supported setting', async () => {
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const documentedKeys = [
    'NODE_ENV',
    'PORT',
    'CLIENT_ORIGIN',
    'CLIENT_ORIGINS',
    'MONGODB_URI',
    'MONGODB_DNS_SERVERS',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'IMGBB_API_KEY',
    'TRUST_PROXY',
    'RATE_LIMIT_ENABLED',
    'RATE_LIMIT_WINDOW_MS',
    'RATE_LIMIT_MAX',
    'HEALTH_RATE_LIMIT_MAX',
    'SERVICE_RATE_LIMIT_MAX',
    'WEBHOOK_RATE_LIMIT_MAX',
    'RATE_LIMIT_MAX_ENTRIES'
  ];

  for (const key of documentedKeys) {
    assert.match(example, new RegExp(`^#?\\s*${key}=`, 'm'), `${key} is undocumented`);
  }
});
