import { test } from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import { MemoryAdapter } from '../src/db/memory.js';
import { pacmanProto, startGrpcScoreServer } from '../src/grpc/score-service.js';

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
