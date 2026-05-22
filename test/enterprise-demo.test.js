import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function runWithEnv(env, code) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, LOG_LEVEL: 'silent', ...env },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`subprocess exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

const forwardingScript = `
import http from 'node:http';
import request from 'supertest';

const seen = [];
const backendServer = http.createServer(async (req, res) => {
  seen.push({ method: req.method, url: req.url });
  for await (const _chunk of req) {}
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url === '/internal/score/read') {
    return res.end(JSON.stringify([{ name: 'WEB', score: 500 }]));
  }
  if (req.method === 'POST' && req.url === '/internal/score/write') {
    return res.end(JSON.stringify({ name: 'WEB', score: 500, level: 1, rs: 'success' }));
  }
  if (req.method === 'GET' && req.url === '/internal/user/session') {
    return res.end(JSON.stringify({ id: 'mock-user-id' }));
  }
  if (req.method === 'POST' && req.url === '/internal/user/stats') {
    return res.end(JSON.stringify({ rs: 'success' }));
  }
  if (req.method === 'GET' && req.url === '/internal/user/stats') {
    return res.end(JSON.stringify([{ score: 77 }]));
  }
  res.statusCode = 404;
  return res.end(JSON.stringify({ error: 'unexpected path' }));
});
await new Promise((resolve) => backendServer.listen(0, '127.0.0.1', resolve));
const backendUrl = 'http://127.0.0.1:' + backendServer.address().port;

process.env.SCORE_SERVICE_URL = backendUrl;
process.env.USER_SERVICE_URL = backendUrl;

const [{ MemoryAdapter }, { createApp }] = await Promise.all([
  import('./src/db/memory.js'),
  import('./src/app.js'),
]);

const webDb = new MemoryAdapter();
await webDb.connect();
const webApp = createApp({ db: webDb });

const scoreWrite = await request(webApp)
  .post('/highscores')
  .type('form')
  .send({ name: 'WEB', cloud: 'local', zone: 'lab', host: 'devbox', score: '500', level: '1' });
const scoreRead = await request(webApp).get('/highscores/list');
const session = await request(webApp).get('/user/id');
const statsUpdate = await request(webApp)
  .post('/user/stats')
  .type('form')
  .send({ userId: session.body, cloud: 'local', zone: 'lab', host: 'devbox', score: '77', level: '1' });
const statsRead = await request(webApp).get('/user/stats');

await webDb.disconnect();
await new Promise((resolve) => backendServer.close(resolve));

process.stdout.write(JSON.stringify({
  scoreWrite: { status: scoreWrite.status, body: scoreWrite.body },
  scoreRead: { status: scoreRead.status, body: scoreRead.body },
  session: { status: session.status, body: session.body },
  statsUpdate: { status: statsUpdate.status, body: statsUpdate.body },
  statsRead: { status: statsRead.status, body: statsRead.body },
  seen,
}));
`;

const roleAwareReadinessScript = `
import request from 'supertest';
import { MemoryAdapter } from './src/db/memory.js';
import { createApp } from './src/app.js';

const db = new MemoryAdapter();
await db.connect();
const app = createApp({ db });
const res = await request(app).get('/readyz/details');
await db.disconnect();
process.stdout.write(JSON.stringify({ status: res.status, body: res.body }));
`;

test('web role forwards public score and user APIs to internal backend paths', () => {
  const out = runWithEnv({ APP_ROLE: 'web' }, forwardingScript);
  assert.equal(out.scoreWrite.status, 200);
  assert.equal(out.scoreWrite.body.rs, 'success');
  assert.equal(out.scoreRead.status, 200);
  assert.ok(out.scoreRead.body.some((score) => score.name === 'WEB'));
  assert.equal(out.session.status, 200);
  assert.equal(typeof out.session.body, 'string');
  assert.equal(out.statsUpdate.status, 200);
  assert.equal(out.statsUpdate.body.rs, 'success');
  assert.equal(out.statsRead.status, 200);
  assert.ok(out.statsRead.body.some((row) => row.score === 77));
  assert.deepEqual(out.seen.map((entry) => `${entry.method} ${entry.url}`), [
    'POST /internal/score/write',
    'GET /internal/score/read',
    'GET /internal/user/session',
    'POST /internal/user/stats',
    'GET /internal/user/stats',
  ]);
});

test('non-web role readiness ignores accidentally configured upstream URLs', () => {
  const out = runWithEnv({
    APP_ROLE: 'score',
    SCORE_SERVICE_URL: 'http://127.0.0.1:1',
    USER_SERVICE_URL: 'http://127.0.0.1:1',
  }, roleAwareReadinessScript);
  assert.equal(out.status, 200);
  assert.equal(out.body.status, 'ready');
  assert.equal(out.body.role, 'score');
  assert.deepEqual(out.body.upstreams, {});
});

test('web role readiness reports unreachable configured upstreams', () => {
  const out = runWithEnv({ APP_ROLE: 'web', SCORE_SERVICE_URL: 'http://127.0.0.1:1' }, roleAwareReadinessScript);
  assert.equal(out.status, 503);
  assert.equal(out.body.status, 'not-ready');
  assert.equal(out.body.upstreams.score.healthy, false);
});
