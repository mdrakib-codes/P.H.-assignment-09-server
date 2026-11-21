process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createHealthController } = await import('../src/controllers/health.controller.js');

const makeRes = () => ({
  statusCode: null,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  }
});

test('liveness does not depend on database health', async () => {
  let checks = 0;
  const controller = createHealthController({
    checkDatabase: async () => {
      checks += 1;
      return 'disconnected';
    },
    getState: () => 'disconnected',
    now: () => '2026-02-01T00:00:00.000Z'
  });
  const res = makeRes();

  await controller.getLiveness({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.timestamp, '2026-02-01T00:00:00.000Z');
  assert.equal(checks, 0);
});

test('readiness reports ok when the database check succeeds', async () => {
  const controller = createHealthController({
    checkDatabase: async () => 'connected',
    getState: () => 'connected',
    now: () => '2026-02-01T00:00:00.000Z'
  });
  const res = makeRes();

  await controller.getReadiness({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.database, 'connected');
  assert.equal(res.body.state, 'connected');
  assert.equal(res.body.timestamp, '2026-02-01T00:00:00.000Z');
});

test('readiness reports unavailable when the database is disconnected', async () => {
  const controller = createHealthController({
    checkDatabase: async () => 'disconnected',
    getState: () => 'disconnected',
    now: () => '2026-02-01T00:00:00.000Z'
  });
  const res = makeRes();

  await controller.getReadiness({}, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(res.body.error.details.status, 'unavailable');
  assert.equal(res.body.error.details.database, 'disconnected');
  assert.equal(res.body.error.details.state, 'disconnected');
  assert.equal(res.body.error.details.timestamp, '2026-02-01T00:00:00.000Z');
});

test('readiness hides database check errors and connection details', async () => {
  const controller = createHealthController({
    checkDatabase: async () => {
      throw new Error(
        'failed mongodb+srv://admin:secret-password@cluster.example.com/fixmate'
      );
    },
    getState: () => 'connecting',
    now: () => '2026-02-01T00:00:00.000Z'
  });
  const res = makeRes();

  await controller.getReadiness({}, res);

  const serialized = JSON.stringify(res.body);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(res.body.error.details.database, 'unavailable');
  assert.equal(res.body.error.details.state, 'connecting');
  assert.equal(serialized.includes('secret-password'), false);
  assert.equal(serialized.includes('cluster.example.com'), false);
  assert.equal(serialized.includes('mongodb+srv'), false);
});
