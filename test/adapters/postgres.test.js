import { test, before, after, skip } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { MongoAdapter } from '../../src/db/mongo.js';
import { PostgresAdapter, createPostgresPoolOptions } from '../../src/db/postgres.js';

const enabled = process.env.RUN_ADAPTER_TESTS === '1';
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'src', 'db', 'migrations', 'postgres', '0001_init.sql');

let adapter;
let container;

test('postgres pool options bound connections and validate TLS by default', () => {
  const options = createPostgresPoolOptions({
    POSTGRES_HOST: 'db',
    POSTGRES_PORT: 5432,
    POSTGRES_DB: 'pacman',
    POSTGRES_USER: 'pacman',
    POSTGRES_PASSWORD: 'secret',
    POSTGRES_SSL: true,
  });

  assert.equal(options.max, 10);
  assert.equal(options.connectionTimeoutMillis, 5000);
  assert.equal(options.idleTimeoutMillis, 30000);
  assert.equal(options.statement_timeout, 10000);
  assert.equal(options.query_timeout, 15000);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
});

test('mongo options bound pools and timeouts', () => {
  const adapter = new MongoAdapter({
    MONGO_SERVICE_HOST: 'db',
    MY_MONGO_PORT: 27017,
    MONGO_DATABASE: 'pacman',
    MONGO_USE_SSL: false,
  });

  assert.equal(adapter.options.maxPoolSize, 10);
  assert.equal(adapter.options.minPoolSize, 0);
  assert.equal(adapter.options.connectTimeoutMS, 10000);
  assert.equal(adapter.options.serverSelectionTimeoutMS, 5000);
  assert.equal(adapter.options.socketTimeoutMS, 30000);
  assert.equal(adapter.options.waitQueueTimeoutMS, 5000);
});

before(async () => {
  if (!enabled) return;
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  container = await new PostgreSqlContainer('postgres:17-alpine').start();

  // Apply schema.
  const pool = new pg.Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
  });
  const sql = await readFile(migration, 'utf8');
  await pool.query(sql);
  await pool.end();

  adapter = new PostgresAdapter(
    {
      POSTGRES_HOST: container.getHost(),
      POSTGRES_PORT: container.getPort(),
      POSTGRES_DB: container.getDatabase(),
      POSTGRES_USER: container.getUsername(),
      POSTGRES_PASSWORD: container.getPassword(),
      POSTGRES_SSL: false,
    },
  );
  await adapter.connect();
});

after(async () => {
  if (adapter) await adapter.disconnect();
  if (container) await container.stop();
});

test('postgres adapter: insertScore + listTopScores', async (t) => {
  if (!enabled) return skip(t, 'set RUN_ADAPTER_TESTS=1 to enable');
  await adapter.insertScore({ name: 'A', score: 10, level: 1 });
  await adapter.insertScore({ name: 'B', score: 30, level: 1 });
  await adapter.insertScore({ name: 'C', score: 20, level: 1 });
  const top = await adapter.listTopScores(2);
  assert.equal(top.length, 2);
  assert.equal(top[0].name, 'B');
  assert.equal(top[1].name, 'C');
});

test('postgres adapter: createUser + updateUserStats + listUserStats', async (t) => {
  if (!enabled) return skip(t, 'set RUN_ADAPTER_TESTS=1 to enable');
  const { id } = await adapter.createUser();
  assert.ok(id);
  await adapter.updateUserStats(id, { cloud: 'gcp', score: 50, level: 2 });
  const stats = await adapter.listUserStats();
  const ours = stats.find((s) => s.score === 50);
  assert.ok(ours);
  assert.equal(ours.txncount, 1);
});
