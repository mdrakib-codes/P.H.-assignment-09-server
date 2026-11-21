import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

const { createProcessHandlers } = await import('../src/server/processHandlers.js');

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

const makeLifecycle = (shutdown = async () => {}) => {
  const calls = [];
  return {
    calls,
    lifecycle: {
      async shutdown(reason) {
        calls.push(reason);
        await shutdown(reason);
      }
    }
  };
};

test('process handlers install once and remove all listeners', () => {
  const emitter = new EventEmitter();
  const { lifecycle } = makeLifecycle();
  const handlers = createProcessHandlers({
    getLifecycle: () => lifecycle,
    processEmitter: emitter,
    exit() {},
    logger: makeLogger()
  });

  handlers.install();
  handlers.install();

  for (const event of ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException']) {
    assert.equal(emitter.listenerCount(event), 1);
  }

  handlers.remove();

  for (const event of ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException']) {
    assert.equal(emitter.listenerCount(event), 0);
  }
});

test('signals shut down the lifecycle and exit once with success', async () => {
  const exits = [];
  const { calls, lifecycle } = makeLifecycle();
  const handlers = createProcessHandlers({
    getLifecycle: () => lifecycle,
    exit: (code) => exits.push(code),
    logger: makeLogger()
  });

  await handlers.handleSignal('SIGINT');
  await handlers.handleSignal('SIGTERM');

  assert.deepEqual(calls, ['SIGINT', 'SIGTERM']);
  assert.deepEqual(exits, [0]);
  assert.equal(handlers.hasExited(), true);
});

test('fatal errors are logged once with secrets redacted, then shut down and exit', async () => {
  const exits = [];
  const logger = makeLogger();
  const { calls, lifecycle } = makeLifecycle();
  const handlers = createProcessHandlers({
    getLifecycle: () => lifecycle,
    exit: (code) => exits.push(code),
    logger
  });
  const error = new Error(
    'failed mongodb://admin:secret-password@cluster.example.com/fixmate'
  );

  await handlers.handleFatal('unhandledRejection', error);
  await handlers.handleFatal('uncaughtException', error);

  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], /unhandledRejection/);
  assert.equal(logger.errors[0].includes('secret-password'), false);
  assert.equal(logger.errors[0].includes('cluster.example.com'), false);
  assert.deepEqual(calls, ['unhandledRejection']);
  assert.deepEqual(exits, [1]);
});

test('uncaughtException events use the fatal error path', async () => {
  const exits = [];
  const logger = makeLogger();
  const emitter = new EventEmitter();
  const { calls, lifecycle } = makeLifecycle();
  const handlers = createProcessHandlers({
    getLifecycle: () => lifecycle,
    processEmitter: emitter,
    exit: (code) => exits.push(code),
    logger
  });

  handlers.install();
  const listener = emitter.listeners('uncaughtException')[0];
  await listener(new Error('unexpected failure'));
  handlers.remove();

  assert.deepEqual(calls, ['uncaughtException']);
  assert.deepEqual(exits, [1]);
  assert.match(logger.errors[0], /unexpected failure/);
});

test('shutdown failure still exits non-zero', async () => {
  const exits = [];
  const logger = makeLogger();
  const { lifecycle } = makeLifecycle(async () => {
    throw new Error('close failed');
  });
  const handlers = createProcessHandlers({
    getLifecycle: () => lifecycle,
    exit: (code) => exits.push(code),
    logger
  });

  await handlers.handleSignal('SIGTERM');

  assert.deepEqual(exits, [1]);
  assert.match(logger.errors.join('\n'), /Shutdown failed/);
});
