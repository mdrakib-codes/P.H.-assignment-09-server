process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const { default: app } = await import('../src/app.js');
const server = app.listen(0);

await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('liveness endpoint reports the process is alive without a database check', async () => {
  const response = await fetch(`${baseUrl}/api/health/live`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.status, 'ok');
  assert.equal(body.database, undefined);
  assert.ok(body.timestamp);
});

test('readiness endpoint reports unavailable when the database is disconnected', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(body.error.details.status, 'unavailable');
  assert.equal(body.error.details.database, 'disconnected');
  assert.ok(body.error.details.timestamp);
});

test('unknown route still returns centralized 404 JSON', async () => {
  const response = await fetch(`${baseUrl}/api/missing`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'ROUTE_NOT_FOUND');
});

test('malformed JSON still returns centralized 400 JSON', async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad json'
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'MALFORMED_JSON');
});

test('CORS accepts listed origins with trailing slashes', async () => {
  const response = await fetch(`${baseUrl}/api/health/live`, {
    headers: { origin: 'http://localhost:3000/' }
  });

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('access-control-allow-origin') || '',
    /^http:\/\/localhost:3000\/?$/
  );
});

test('CORS still rejects unlisted origins', async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { origin: 'https://evil.example.com' }
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'ORIGIN_NOT_ALLOWED');
});
