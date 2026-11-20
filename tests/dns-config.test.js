process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/fixmate_test';
process.env.MONGODB_DNS_SERVERS ||= '';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const { configureDns } = await import('../src/config/dns.js');
const root = fileURLToPath(new URL('..', import.meta.url));

test('system DNS is preserved when no resolvers are configured', () => {
  const calls = [];
  const applied = configureDns({
    dnsModule: { setServers: (servers) => calls.push(servers) },
    servers: []
  });

  assert.equal(applied, false);
  assert.deepEqual(calls, []);
});

test('configured resolvers are applied before MongoDB connects', () => {
  const calls = [];
  const servers = ['8.8.8.8', '8.8.4.4'];
  const applied = configureDns({
    dnsModule: { setServers: (value) => calls.push(value) },
    servers
  });

  assert.equal(applied, true);
  assert.deepEqual(calls, [servers]);
});

test('environment parsing produces a clean DNS server list', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { env } from './src/config/env.js'; console.log(JSON.stringify(env.mongodbDnsServers));"
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MONGODB_URI: 'mongodb://127.0.0.1:27017/fixmate_test',
        MONGODB_DNS_SERVERS: '8.8.8.8, 8.8.4.4'
      },
      encoding: 'utf8',
      timeout: 15000
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['8.8.8.8', '8.8.4.4']);
});
