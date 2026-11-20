import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServerLifecycle } from '../src/server/lifecycle.js';

const logger = { log() {}, error() {} };

const makeServer = () => ({
  on() {},
  close(callback) {
    callback();
  }
});

test('database initialization happens before HTTP listening', async () => {
  const calls = [];
  const server = makeServer();
  const app = {
    listen(port, callback) {
      calls.push(`listen:${port}`);
      callback();
      return server;
    }
  };

  const lifecycle = createServerLifecycle({
    app,
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: async () => calls.push('initialize'),
    closeDatabase: async () => calls.push('closeDatabase'),
    logger
  });

  await lifecycle.start();

  assert.deepEqual(calls, ['initialize', 'listen:5099']);
  assert.equal(lifecycle.getServer(), server);
});

test('shutdown closes HTTP server before MongoDB and is idempotent', async () => {
  const calls = [];
  const server = {
    on() {},
    close(callback) {
      calls.push('closeServer');
      callback();
    }
  };
  const app = {
    listen(port, callback) {
      callback();
      return server;
    }
  };

  const lifecycle = createServerLifecycle({
    app,
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: async () => {},
    closeDatabase: async () => calls.push('closeDatabase'),
    logger
  });

  await lifecycle.start();
  await lifecycle.shutdown('SIGTERM');
  await lifecycle.shutdown('SIGTERM');

  assert.deepEqual(calls, ['closeServer', 'closeDatabase']);
  assert.equal(lifecycle.getServer(), null);
});

test('startup failure prevents HTTP listening', async () => {
  let listened = false;
  const app = {
    listen() {
      listened = true;
    }
  };

  const lifecycle = createServerLifecycle({
    app,
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: async () => {
      throw new Error('database unavailable');
    },
    closeDatabase: async () => {},
    logger
  });

  await assert.rejects(() => lifecycle.start(), /database unavailable/);
  assert.equal(listened, false);
});
