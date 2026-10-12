import { test } from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import { MemoryAdapter } from '../src/db/memory.js';
import { createScoreService, pacmanProto, startGrpcScoreServer } from '../src/grpc/score-service.js';

test('gRPC ScoreService accepts and lists scores', async () => {
  const db = new MemoryAdapter();
  await db.connect();
  const handle = await startGrpcScoreServer({ db, host: '127.0.0.1', port: 0 });
  const client = new pacmanProto.ScoreService(`127.0.0.1:${handle.port}`, grpc.credentials.createInsecure());

  try {
    const submit = await new Promise((resolve, reject) => {
      client.submitScore(
        { name: 'GRPC', cloud: 'kind', zone: 'zone-a', host: 'grpc-test', score: 100, level: 1 },
        (err, response) => (err ? reject(err) : resolve(response)),
      );
    });
    assert.equal(submit.rs, 'success');
    assert.equal(submit.name, 'GRPC');

    const list = await new Promise((resolve, reject) => {
      client.listScores({ limit: 10 }, (err, response) => (err ? reject(err) : resolve(response)));
    });
    assert.equal(list.scores.length, 1);
    assert.equal(list.scores[0].name, 'GRPC');
    assert.equal(list.scores[0].score, 100);
  } finally {
    client.close();
    handle.server.forceShutdown();
    await db.disconnect();
  }
});

test('gRPC SubmitScore rejects invalid int32 submissions over the network before database writes', async () => {
  const writes = [];
  const db = {
    async insertScore(record) {
      writes.push(record);
    },
    async listTopScores() {
      return [];
    },
  };
  const handle = await startGrpcScoreServer({ db, host: '127.0.0.1', port: 0 });
  const client = new pacmanProto.ScoreService(`127.0.0.1:${handle.port}`, grpc.credentials.createInsecure());
  const invalidSubmissions = [
    {},
    { score: -1, level: 1 },
    { score: 100, level: undefined },
    { score: 100, level: 0 },
    { score: 100, level: -1 },
    { score: 0, level: 11 },
    { score: 999999, level: 1 },
  ];

  try {
    for (const [index, values] of invalidSubmissions.entries()) {
      await assert.rejects(
        new Promise((resolve, reject) => {
          client.submitScore(
            { name: `INVALID-${index}`, cloud: 'kind', zone: 'zone-a', host: 'grpc-test', ...values },
            (err, response) => (err ? reject(err) : resolve(response)),
          );
        }),
        (err) => err.code === grpc.status.INVALID_ARGUMENT,
      );
    }
    assert.equal(writes.length, 0);

    const accepted = await new Promise((resolve, reject) => {
      client.submitScore(
        { name: 'ZERO', cloud: 'kind', zone: 'zone-a', host: 'grpc-test', score: 0, level: 1 },
        (err, response) => (err ? reject(err) : resolve(response)),
      );
    });
    assert.equal(accepted.score, 0);
    assert.equal(accepted.level, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].score, 0);
    assert.equal(writes[0].level, 1);

    const omittedScore = await new Promise((resolve, reject) => {
      client.submitScore(
        { name: 'OMITTED-SCORE', cloud: 'kind', zone: 'zone-a', host: 'grpc-test', level: 1 },
        (err, response) => (err ? reject(err) : resolve(response)),
      );
    });
    assert.equal(omittedScore.score, 0);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].score, 0);
  } finally {
    client.close();
    handle.server.forceShutdown();
  }
});

test('gRPC score handler rejects malformed JavaScript values before database writes', async () => {
  // The int32 protobuf wire format cannot carry these values without coercion.
  // Exercise the service boundary directly to protect its shared validator.
  const writes = [];
  const service = createScoreService({
    async insertScore(record) {
      writes.push(record);
    },
    async listTopScores() {
      return [];
    },
  });
  const invalidSubmissions = [
    { score: undefined, level: 1 },
    { score: NaN, level: 1 },
    { score: 'abc', level: 1 },
    { score: '100tail', level: 1 },
    { score: 1.5, level: 1 },
    { score: -1, level: 1 },
    { score: Number.MAX_SAFE_INTEGER + 1, level: 1 },
    { score: 100, level: undefined },
    { score: 100, level: '1tail' },
    { score: 100, level: 1.5 },
    { score: 100, level: 0 },
    { score: 100, level: -1 },
    { score: 0, level: Number.MAX_SAFE_INTEGER + 1 },
    { score: 999999, level: 1 },
  ];

  for (const [index, request] of invalidSubmissions.entries()) {
    const err = await new Promise((resolve) => {
      service.submitScore({ request: { name: `INVALID-${index}`, ...request } }, (statusError) => resolve(statusError));
    });
    assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
  }
  assert.equal(writes.length, 0);
});

test('gRPC database errors return sanitized INTERNAL status and retain full details only in server logs', async () => {
  const secretDetails = 'postgres password and host details';
  const logEntries = [];
  const db = {
    async insertScore() {
      throw new Error(`insert failed: ${secretDetails}`);
    },
    async listTopScores() {
      throw new Error(`query failed: ${secretDetails}`);
    },
  };
  const logger = {
    error(payload, message) {
      logEntries.push({ error: payload.err?.message, message });
    },
  };
  const handle = await startGrpcScoreServer({ db, host: '127.0.0.1', port: 0, logger });
  const client = new pacmanProto.ScoreService(`127.0.0.1:${handle.port}`, grpc.credentials.createInsecure());

  try {
    const submitError = await new Promise((resolve) => {
      client.submitScore(
        { name: 'DB-FAIL', score: 100, level: 1 },
        (err) => resolve(err),
      );
    });
    assert.equal(submitError.code, grpc.status.INTERNAL);
    assert.equal(submitError.message, '13 INTERNAL: score submission failed');
    assert.doesNotMatch(submitError.message, /password|host details/);

    const listError = await new Promise((resolve) => {
      client.listScores({ limit: 10 }, (err) => resolve(err));
    });
    assert.equal(listError.code, grpc.status.INTERNAL);
    assert.equal(listError.message, '13 INTERNAL: score listing failed');
    assert.doesNotMatch(listError.message, /password|host details/);

    assert.deepEqual(logEntries, [
      { error: `insert failed: ${secretDetails}`, message: 'gRPC score submission failed' },
      { error: `query failed: ${secretDetails}`, message: 'gRPC score listing failed' },
    ]);
  } finally {
    client.close();
    handle.server.forceShutdown();
  }
});
