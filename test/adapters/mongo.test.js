import { test, before, after, skip } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { Wait } from 'testcontainers';
import { MongoAdapter } from '../../src/db/mongo.js';

const enabled = process.env.RUN_ADAPTER_TESTS === '1';

let adapter;
let container;

async function waitForPrimary(connectionString) {
  const client = new MongoClient(connectionString, {
    directConnection: true,
    serverSelectionTimeoutMS: 1_000,
  });
  await client.connect();

  try {
    const admin = client.db('admin');
    const deadline = Date.now() + 60_000;
    let initiated = false;

    while (Date.now() < deadline) {
      const hello = await admin.command({ hello: 1 });
      if (hello.isWritablePrimary) return;

      if (!hello.setName && !initiated) {
        try {
          await admin.command({
            replSetInitiate: {
              _id: 'rs0',
              members: [{ _id: 0, host: hello.me ?? 'localhost:27017' }],
            },
          });
        } catch (err) {
          if (err.code !== 23 && err.codeName !== 'AlreadyInitialized') throw err;
        }
        initiated = true;
      }

      await delay(100);
    }

    throw new Error('MongoDB replica set did not elect a primary within 60 seconds');
  } finally {
    await client.close();
  }
}

before(async () => {
  if (!enabled) return;
  const { MongoDBContainer } = await import('@testcontainers/mongodb');
  container = await new MongoDBContainer('mongo:8')
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  await waitForPrimary(container.getConnectionString());
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
