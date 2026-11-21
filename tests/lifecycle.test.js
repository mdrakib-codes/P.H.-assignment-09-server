import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServerLifecycle } from '../src/server/lifecycle.js';

const logger = { log() {}, error() {} };

const makeLogger = () => {
  const errors = [];
  return {
    errors,
    log() {},
    error(message) {
      errors.push(message);
    }
  };
};

const makeServer = ({ onClose, onIdle } = {}) => ({
  on() {},
  close(callback) {
    if (onClose) {
      onClose(callback);
      return;
    }
    callback();
  },
  ...(onIdle ? { closeIdleConnections: onIdle } : {})
});

const makeApp = (server) => ({
  listen(port, callback) {
    callback();
    return server;
  }
});

const pending = () => new Promise(() => {});

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

test('normal cleanup completes successfully and repeated shutdown calls are idempotent', async () => {
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
  const firstShutdown = lifecycle.shutdown('SIGTERM');
  await firstShutdown;
  assert.equal(lifecycle.shutdown('SIGTERM'), firstShutdown);
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

test('HTTP close hangs: shutdown respects the deadline', { timeout: 1000 }, async () => {
  const calls = [];
  const testLogger = makeLogger();
  const server = makeServer({
    onClose() {
      calls.push('closeServer');
    },
    onIdle() {
      calls.push('closeIdleConnections');
    }
  });
  const lifecycle = createServerLifecycle({
    app: makeApp(server),
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: async () => {},
    closeDatabase: async () => calls.push('closeDatabase'),
    logger: testLogger,
    shutdownTimeoutMs: 20
  });

  await lifecycle.start();
  await assert.rejects(() => lifecycle.shutdown('SIGTERM'), /Shutdown deadline exceeded/);

  assert.deepEqual(calls, ['closeServer', 'closeIdleConnections', 'closeDatabase']);
  assert.match(
    testLogger.errors.join('\n'),
    /HTTP close failed: Shutdown deadline exceeded/
  );
});

test('database close never resolves: shutdown respects the deadline', { timeout: 1000 }, async () => {
  const calls = [];
  const testLogger = makeLogger();
  const server = makeServer({
    onClose(callback) {
      calls.push('closeServer');
      callback();
    }
  });
  const lifecycle = createServerLifecycle({
    app: makeApp(server),
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: async () => {},
    closeDatabase: () => {
      calls.push('closeDatabase');
      return pending();
    },
    logger: testLogger,
    shutdownTimeoutMs: 20
  });

  await lifecycle.start();
  await assert.rejects(() => lifecycle.shutdown('SIGTERM'), /Shutdown deadline exceeded/);

  assert.deepEqual(calls, ['closeServer', 'closeDatabase']);
  assert.match(
    testLogger.errors.join('\n'),
    /Database close failed: Shutdown deadline exceeded/
  );
});

test('HTTP and database cleanup share one overall deadline', { timeout: 2000 }, async () => {
  const calls = [];
  const testLogger = makeLogger();
  const server = makeServer({
    onClose() {
      calls.push('closeServer');
    },
    onIdle() {
      calls.push('closeIdleConnections');
    }
  });
  const lifecycle = createServerLifecycle({
    app: makeApp(server),
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: async () => {},
    closeDatabase: () => {
      calls.push('closeDatabase');
      return pending();
    },
    logger: testLogger,
    shutdownTimeoutMs: 200
  });

  await lifecycle.start();
  const startedAt = Date.now();
  await assert.rejects(() => lifecycle.shutdown('SIGTERM'), /Shutdown deadline exceeded/);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 350, `shutdown took ${elapsed}ms; expected one 200ms deadline`);
  assert.deepEqual(calls, ['closeServer', 'closeIdleConnections', 'closeDatabase']);
});

test('database close rejection is reported safely and rejects shutdown', async () => {
  const calls = [];
  const testLogger = makeLogger();
  const server = makeServer({
    onClose(callback) {
      calls.push('closeServer');
      callback();
    }
  });
  const lifecycle = createServerLifecycle({
    app: makeApp(server),
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: async () => {},
    closeDatabase: async () => {
      calls.push('closeDatabase');
      throw new Error(
        'failed mongodb://admin:secret-password@cluster.example.com/fixmate'
      );
    },
    logger: testLogger
  });

  await lifecycle.start();
  await assert.rejects(() => lifecycle.shutdown('SIGTERM'), /failed mongodb/);

  const logs = testLogger.errors.join('\n');
  assert.deepEqual(calls, ['closeServer', 'closeDatabase']);
  assert.match(logs, /Database close failed/);
  assert.equal(logs.includes('secret-password'), false);
  assert.equal(logs.includes('cluster.example.com'), false);
});

test('HTTP close failure is reported and the database is still closed', async () => {
  const calls = [];
  const testLogger = makeLogger();
  const server = makeServer({
    onClose(callback) {
      calls.push('closeServer');
      callback(new Error('close failed token=secret-password'));
    }
  });
  const lifecycle = createServerLifecycle({
    app: makeApp(server),
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: async () => {},
    closeDatabase: async () => calls.push('closeDatabase'),
    logger: testLogger
  });

  await lifecycle.start();
  await assert.rejects(() => lifecycle.shutdown('SIGTERM'), /close failed/);

  const logs = testLogger.errors.join('\n');
  assert.deepEqual(calls, ['closeServer', 'closeDatabase']);
  assert.match(logs, /HTTP close failed/);
  assert.equal(logs.includes('secret-password'), false);
});

test('shutdown during startup prevents HTTP listening', async () => {
  let releaseInitialization;
  const initialization = new Promise((resolve) => {
    releaseInitialization = resolve;
  });
  let listened = false;
  const calls = [];
  const app = {
    listen() {
      listened = true;
      return makeServer();
    }
  };
  const lifecycle = createServerLifecycle({
    app,
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: () => initialization,
    closeDatabase: async () => calls.push('closeDatabase'),
    logger,
    shutdownTimeoutMs: 20
  });

  const starting = lifecycle.start();
  const stopping = lifecycle.shutdown('SIGTERM');
  releaseInitialization();
  await Promise.all([starting, stopping]);

  assert.equal(listened, false);
  assert.deepEqual(calls, ['closeDatabase']);
  assert.equal(lifecycle.getServer(), null);
});

test('HTTP server receives configured request and keep-alive timeouts', async () => {
  const server = {
    on() {},
    close(callback) {
      callback();
    },
    setTimeout(value) {
      server.timeout = value;
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
    closeDatabase: async () => {},
    logger,
    serverTimeouts: {
      requestTimeout: 1234,
      headersTimeout: 2345,
      keepAliveTimeout: 3456
    }
  });

  await lifecycle.start();

  assert.equal(server.timeout, 1234);
  assert.equal(server.requestTimeout, 1234);
  assert.equal(server.headersTimeout, 2345);
  assert.equal(server.keepAliveTimeout, 3456);
});

test('server errors are reported through a callback with redacted logs', async () => {
  let errorListener;
  const server = {
    on(event, listener) {
      if (event === 'error') {
        errorListener = listener;
      }
    },
    close(callback) {
      callback();
    }
  };
  const app = {
    listen(port, callback) {
      callback();
      return server;
    }
  };
  const reported = [];
  const errorLogs = [];
  const lifecycle = createServerLifecycle({
    app,
    env: { port: 5099, nodeEnv: 'test' },
    initializeDatabase: async () => {},
    closeDatabase: async () => {},
    logger: {
      log() {},
      error(message) {
        errorLogs.push(message);
      }
    },
    onServerError: (error) => reported.push(error.message)
  });

  await lifecycle.start();
  errorListener(
    new Error('failed mongodb://admin:secret-password@cluster.example.com/fixmate')
  );

  assert.deepEqual(reported, [
    'failed mongodb://admin:secret-password@cluster.example.com/fixmate'
  ]);
  assert.match(errorLogs[0], /HTTP server error/);
  assert.equal(errorLogs[0].includes('secret-password'), false);
  assert.equal(errorLogs[0].includes('cluster.example.com'), false);
});
