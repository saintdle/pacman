import { test, before, after, skip } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { Wait } from 'testcontainers';
import { MongoAdapter } from '../../src/db/mongo.js';
import { runMongoStartupWithDiagnostics } from './mongo-fixture-diagnostics.js';

const enabled = process.env.RUN_ADAPTER_TESTS === '1';

let adapter;
let container;
let containerName;

function docker(args) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
}

function runDocker(args) {
  const result = docker(args);
  assert.equal(result.status, 0, `docker ${args[0]} failed: ${result.stderr || result.error?.message}`);
  return result;
}

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
  containerName = `pacman-mongo-adapter-${process.pid}-${randomUUID()}`;
  await runMongoStartupWithDiagnostics({
    containerName,
    startContainer: async (captureOutput) => {
      const { MongoDBContainer } = await import('@testcontainers/mongodb');
      return new MongoDBContainer('mongo:8')
        .withName(containerName)
        .withLogConsumer((stream) => stream.on('data', captureOutput))
        .withWaitStrategy(Wait.forListeningPorts())
        .start();
    },
    onContainer: (startedContainer) => {
      container = startedContainer;
    },
    initialize: async (startedContainer) => {
      await waitForPrimary(startedContainer.getConnectionString());
      adapter = new MongoAdapter(
        { MONGO_DATABASE: 'pacman' },
        { url: startedContainer.getConnectionString(), options: { directConnection: true } },
      );
      await adapter.connect();
    },
  });
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

test('mongo startup diagnostics capture and clean an owned Mongo-image container that exits during start', async (t) => {
  if (!enabled) return skip(t, 'set RUN_ADAPTER_TESTS=1 to enable');

  const diagnosticContainerName = `pacman-mongo-diagnostic-${process.pid}-${randomUUID()}`;
  const controlledFailure = new Error('controlled Mongo startup rejection after process exit');
  const diagnostics = [];

  try {
    await assert.rejects(
      runMongoStartupWithDiagnostics({
        containerName: diagnosticContainerName,
        startContainer: async (captureOutput) => {
          runDocker([
            'create',
            '--name',
            diagnosticContainerName,
            '--entrypoint',
            '/bin/sh',
            'mongo:8',
            '-c',
            'printf "%s\\n" "PACMAN_MONGO_STDOUT_MARKER"; printf "%s\\n" "PACMAN_MONGO_STDERR_MARKER" >&2; exit 37',
          ]);
          runDocker(['start', diagnosticContainerName]);

          const deadline = Date.now() + 10_000;
          let state;
          while (Date.now() < deadline) {
            const inspect = runDocker(['inspect', '--format', '{{json .State}}', diagnosticContainerName]);
            state = JSON.parse(inspect.stdout);
            if (!state.Running) break;
            await delay(50);
          }

          assert.equal(state?.Status, 'exited', 'controlled Mongo image process should exit');
          assert.equal(state.ExitCode, 37, 'controlled Mongo image process should preserve its exit code');
          const logs = runDocker(['logs', diagnosticContainerName]);
          captureOutput(logs.stdout);
          captureOutput(logs.stderr);
          throw controlledFailure;
        },
        initialize: async () => assert.fail('initialize must not run after a startup rejection'),
        write: (message) => diagnostics.push(message),
      }),
      (error) => error === controlledFailure,
    );

    const diagnosticText = diagnostics.join('\n');
    assert.match(diagnosticText, /ExitCode":37/);
    assert.match(diagnosticText, /PACMAN_MONGO_STDOUT_MARKER/);
    assert.match(diagnosticText, /PACMAN_MONGO_STDERR_MARKER/);
    assert.match(diagnosticText, /Captured startup output:/);

    const afterCleanup = docker(['inspect', diagnosticContainerName]);
    assert.notEqual(afterCleanup.status, 0, 'failed startup container should be removed');
  } finally {
    const leftover = docker(['inspect', diagnosticContainerName]);
    if (leftover.status === 0) docker(['rm', '-f', diagnosticContainerName]);
  }
});
