import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.DEMO_SECURITY_MODE = 'true';
process.env.DEMO_TOKEN = 'secret-demo';
process.env.APP_ROLE = 'web';
process.env.APP_VERSION = 'v-demo';
process.env.APP_VARIANT = 'canary';

const [{ createApp }, { MemoryAdapter }] = await Promise.all([
  import('../src/app.js'),
  import('../src/db/memory.js'),
]);

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

describe('demo metadata and incident routes', () => {
  test('GET /version returns app role and version metadata', async () => {
    const res = await request(app).get('/version');
    assert.equal(res.status, 200);
    assert.equal(res.body.app, 'pacman');
    assert.equal(res.body.role, 'web');
    assert.equal(res.body.version, 'v-demo');
    assert.equal(res.body.variant, 'canary');
  });

  test('POST /demo/incidents is blocked without the demo token', async () => {
    const res = await request(app).post('/demo/incidents').send({ type: 'test' });
    assert.equal(res.status, 403);
  });

  test('POST /demo/incidents records a gated lab incident', async () => {
    const res = await request(app)
      .post('/demo/incidents')
      .set('x-demo-token', 'secret-demo')
      .send({ type: 'score-tamper', action: 'observe' });
    assert.equal(res.status, 200);
    assert.equal(res.body.rs, 'success');
    assert.equal(res.body.incident.type, 'score-tamper');
    assert.equal(res.body.incident.action, 'observe');
  });

  test('demo fault middleware injects a gated HTTP error', async () => {
    const res = await request(app)
      .get('/version')
      .set('x-demo-token', 'secret-demo')
      .set('x-demo-fault-status', '503');
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'demo fault injected');
  });
});
