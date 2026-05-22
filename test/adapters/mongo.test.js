import { test, before, after, skip } from 'node:test';
import assert from 'node:assert/strict';
import { MongoAdapter } from '../../src/db/mongo.js';

const enabled = process.env.RUN_ADAPTER_TESTS === '1';

let adapter;
let container;

before(async () => {
  if (!enabled) return;
  const { MongoDBContainer } = await import('@testcontainers/mongodb');
  container = await new MongoDBContainer('mongo:8').start();
  adapter = new MongoAdapter(
    { MONGO_DATABASE: 'pacman' },
    { url: container.getConnectionString(), options: { directConnection: true } },
  );
  await adapter.connect();
});

after(async () => {
  if (adapter) await adapter.disconnect();
  if (container) await container.stop();
});

test('mongo adapter: insertScore + listTopScores', async (t) => {
  if (!enabled) return skip(t, 'set RUN_ADAPTER_TESTS=1 to enable');
  await adapter.insertScore({ name: 'A', score: 10, level: 1 });
  await adapter.insertScore({ name: 'B', score: 30, level: 1 });
  await adapter.insertScore({ name: 'C', score: 20, level: 1 });
  const top = await adapter.listTopScores(2);
  assert.equal(top.length, 2);
  assert.equal(top[0].name, 'B');
  assert.equal(top[1].name, 'C');
});

test('mongo adapter: createUser + updateUserStats + listUserStats', async (t) => {
  if (!enabled) return skip(t, 'set RUN_ADAPTER_TESTS=1 to enable');
  const { id } = await adapter.createUser();
  assert.ok(id);
  await adapter.updateUserStats(id, { cloud: 'aws', score: 50, level: 2 });
  const stats = await adapter.listUserStats();
  const ours = stats.find((s) => s.score === 50);
  assert.ok(ours);
  assert.equal(ours.txncount, 1);
});
