import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { MemoryAdapter } from '../src/db/memory.js';
import { createApp } from '../src/app.js';

let app;
let db;

before(async () => {
  db = new MemoryAdapter();
  await db.connect();
  app = createApp({ db });
});

after(async () => {
  await db.disconnect();
});

test('GET /healthz returns ok', async () => {
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('GET /readyz returns ready when adapter is healthy', async () => {
  const res = await request(app).get('/readyz');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ready');
});

test('GET /readyz/details returns db and gameplay config details', async () => {
  const res = await request(app).get('/readyz/details');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ready');
  assert.equal(res.body.role, 'web');
  assert.equal(res.body.database.type, 'memory');
  assert.equal(res.body.database.healthy, true);
  assert.deepEqual(res.body.upstreams, {});
  assert.equal(typeof res.body.config.allowClientOverride, 'boolean');
  assert.equal(typeof res.body.config.allowEbeeModeOverride, 'boolean');
});

test('GET /metrics returns Prometheus text with bounded route labels', async () => {
  await request(app).get('/pacman-canvas.js');
  const res = await request(app).get('/metrics');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.text, /# TYPE pacman_http_requests_total counter/);
  assert.match(res.text, /pacman_http_requests_total\{role="web",method="GET",route="static",status="200"\}/);
  assert.doesNotMatch(res.text, /route="\/pacman-canvas\.js"/);
});

test('GET /highscores/list is empty initially', async () => {
  const res = await request(app).get('/highscores/list');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('POST /highscores then GET /highscores/list round-trips', async () => {
  const post = await request(app)
    .post('/highscores')
    .type('form')
    .send({ name: 'DEA', cloud: 'local', zone: 'lab', host: 'devbox', score: '4200', level: '2' });
  assert.equal(post.status, 200);
  assert.equal(post.body.rs, 'success');

  const list = await request(app).get('/highscores/list');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].name, 'DEA');
  assert.equal(list.body[0].score, 4200);
});

test('GET /user/id returns a non-empty string id', async () => {
  const res = await request(app).get('/user/id');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'string');
  assert.ok(res.body.length > 0);
});

test('POST /user/stats updates stats for an existing user id', async () => {
  const createRes = await request(app).get('/user/id');
  const userId = createRes.body;

  const upd = await request(app)
    .post('/user/stats')
    .type('form')
    .send({
      userId,
      cloud: 'local',
      zone: 'lab',
      host: 'devbox',
      score: '100',
      level: '1',
      lives: '3',
      elapsedTime: '42',
    });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.rs, 'success');

  const stats = await request(app).get('/user/stats');
  assert.equal(stats.status, 200);
  const ours = stats.body.find((s) => s.score === 100);
  assert.ok(ours, 'expected our update to appear in /user/stats');
  assert.equal(ours.cloud, 'local');
  assert.equal(ours.txncount, 1);
});

test('POST /user/stats rejects missing userId', async () => {
  const res = await request(app).post('/user/stats').type('form').send({ score: '1' });
  assert.equal(res.status, 400);
});

test('POST /highscores rejects non-numeric score', async () => {
  const res = await request(app)
    .post('/highscores')
    .type('form')
    .send({ name: 'X', score: 'not-a-number' });
  assert.equal(res.status, 400);
});

test('POST /highscores rejects implausible score for level', async () => {
  // Max per level is 104*10 + 4*50 + 4*4*100 = 2840.
  const res = await request(app)
    .post('/highscores')
    .type('form')
    .send({ name: 'CHEATER', score: '999999', level: '1' });
  assert.equal(res.status, 400);
});

test('POST /highscores rejects out-of-range level', async () => {
  const res = await request(app)
    .post('/highscores')
    .type('form')
    .send({ name: 'CHEATER', score: '100', level: '99' });
  assert.equal(res.status, 400);
});

test('POST /highscores accepts a plausible score', async () => {
  const res = await request(app)
    .post('/highscores')
    .type('form')
    .send({ name: 'OK', score: '2840', level: '1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.rs, 'success');
});

test('internal score endpoints read, validate, and write scores', async () => {
  const invalid = await request(app)
    .post('/internal/score/write')
    .type('form')
    .send({ name: 'NOPE', score: '999999', level: '1' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'score is implausible for level');

  const write = await request(app)
    .post('/internal/score/write')
    .type('form')
    .send({ name: 'INT', cloud: 'local', zone: 'lab', host: 'devbox', score: '1000', level: '1' });
  assert.equal(write.status, 200);
  assert.equal(write.body.rs, 'success');
  assert.equal(write.body.name, 'INT');

  const read = await request(app).get('/internal/score/read');
  assert.equal(read.status, 200);
  assert.ok(read.body.some((score) => score.name === 'INT' && score.score === 1000));
});

test('internal user endpoints create sessions and update stats', async () => {
  const session = await request(app).get('/internal/user/session');
  assert.equal(session.status, 200);
  assert.equal(typeof session.body.id, 'string');

  const update = await request(app)
    .post('/internal/user/stats')
    .type('form')
    .send({ userId: session.body.id, cloud: 'local', zone: 'lab', host: 'devbox', score: '321', level: '1' });
  assert.equal(update.status, 200);
  assert.equal(update.body.rs, 'success');

  const stats = await request(app).get('/internal/user/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.body.some((row) => row.score === 321));
});

test('internal config endpoint exposes server config', async () => {
  const res = await request(app).get('/internal/config/read');
  assert.equal(res.status, 200);
  assert.equal(res.body.appRole, 'web');
  assert.equal(typeof res.body.allowClientOverride, 'boolean');
});

test('metrics use stable labels for internal API paths', async () => {
  await request(app)
    .post('/highscores')
    .type('form')
    .send({ name: 'MET', cloud: 'local', zone: 'lab', host: 'devbox', score: '100', level: '1' });
  await request(app).get('/internal/score/read');
  await request(app).get('/internal/user/session');

  const res = await request(app).get('/metrics');
  assert.equal(res.status, 200);
  assert.match(res.text, /route="\/highscores"/);
  assert.match(res.text, /route="\/internal\/score\/read"/);
  assert.match(res.text, /route="\/internal\/user\/session"/);
});

test('unknown route returns 500-or-better with our error template', async () => {
  const res = await request(app).get('/this-route-does-not-exist');
  assert.equal(res.status, 404);
});

test('GET /config exposes maxLevel from server config', async () => {
  const res = await request(app).get('/config');
  assert.equal(res.status, 200);
  // Default MAX_LEVEL in src/config/index.js is 10 when the env var is not set.
  assert.ok(
    res.body.maxLevel === 'unlimited' || (Number.isInteger(res.body.maxLevel) && res.body.maxLevel >= 1),
    'maxLevel must be a positive integer or "unlimited"',
  );
  assert.equal(typeof res.body.allowClientOverride, 'boolean');
  assert.equal(typeof res.body.ebeeMode, 'boolean');
  assert.equal(typeof res.body.allowEbeeModeOverride, 'boolean');
});

test('GET /config/schema describes client-visible config fields', async () => {
  const res = await request(app).get('/config/schema');
  assert.equal(res.status, 200);
  assert.equal(res.body.fields.maxLevel.env, 'MAX_LEVEL');
  assert.equal(res.body.fields.ebeeMode.env, 'EBEE_MODE');
  assert.equal(res.body.config.maxLevel, 10);
});

test('POST /config accepts a valid maxLevel when overrides are allowed', async () => {
  const res = await request(app)
    .post('/config')
    .type('form')
    .send({ maxLevel: '15' });
  // Default ALLOW_CLIENT_CONFIG_OVERRIDE is true, so we expect a 200 ack.
  assert.equal(res.status, 200);
  assert.equal(res.body.rs, 'success');
  assert.equal(res.body.maxLevel, 15);
});

test('POST /config rejects an invalid maxLevel', async () => {
  const res = await request(app)
    .post('/config')
    .type('form')
    .send({ maxLevel: 'banana' });
  assert.equal(res.status, 400);
});

test('POST /config accepts a valid eBee mode override when allowed', async () => {
  const res = await request(app)
    .post('/config')
    .type('form')
    .send({ ebeeMode: 'true' });
  assert.equal(res.status, 200);
  assert.equal(res.body.rs, 'success');
  assert.equal(res.body.ebeeMode, true);
});

test('POST /config rejects an invalid eBee mode override', async () => {
  const res = await request(app)
    .post('/config')
    .type('form')
    .send({ ebeeMode: 'banana' });
  assert.equal(res.status, 400);
});
