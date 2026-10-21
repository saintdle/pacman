import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import { MemoryAdapter } from '../src/db/memory.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';

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
  assert.equal(res.body.version, 'dev');
  assert.equal(res.body.commit, 'unknown');
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

test('GET /readyz ignores configured upstreams by default while details still probes readiness', async () => {
  const previous = {
    APP_ROLE: config.APP_ROLE,
    READINESS_CHECK_UPSTREAMS: config.READINESS_CHECK_UPSTREAMS,
    SCORE_SERVICE_URL: config.SCORE_SERVICE_URL,
  };
  const paths = [];
  const upstream = http.createServer((req, res) => {
    paths.push(req.url);
    res.statusCode = 503;
    res.end('{"status":"not-ready"}');
  });

  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    config.APP_ROLE = 'web';
    config.READINESS_CHECK_UPSTREAMS = false;
    config.SCORE_SERVICE_URL = `http://127.0.0.1:${upstream.address().port}`;

    const ready = await request(app).get('/readyz');
    assert.equal(ready.status, 200);
    assert.deepEqual(paths, []);

    const details = await request(app).get('/readyz/details');
    assert.equal(details.status, 503);
    assert.equal(details.body.upstreams.score.healthy, false);
    assert.deepEqual(paths, ['/readyz']);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    Object.assign(config, previous);
  }
});

test('GET /readyz checks configured upstream readiness when enabled', async () => {
  const previous = {
    APP_ROLE: config.APP_ROLE,
    READINESS_CHECK_UPSTREAMS: config.READINESS_CHECK_UPSTREAMS,
    SCORE_SERVICE_URL: config.SCORE_SERVICE_URL,
  };
  const paths = [];
  const upstream = http.createServer((req, res) => {
    paths.push(req.url);
    res.statusCode = 503;
    res.end('{"status":"not-ready"}');
  });

  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    config.APP_ROLE = 'web';
    config.READINESS_CHECK_UPSTREAMS = true;
    config.SCORE_SERVICE_URL = `http://127.0.0.1:${upstream.address().port}`;

    const res = await request(app).get('/readyz');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'not-ready');
    assert.deepEqual(paths, ['/readyz']);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    Object.assign(config, previous);
  }
});

test('GET /readyz returns not-ready for unreachable configured upstreams when enabled', async () => {
  const previous = {
    APP_ROLE: config.APP_ROLE,
    READINESS_CHECK_UPSTREAMS: config.READINESS_CHECK_UPSTREAMS,
    SCORE_SERVICE_URL: config.SCORE_SERVICE_URL,
  };

  try {
    config.APP_ROLE = 'web';
    config.READINESS_CHECK_UPSTREAMS = true;
    config.SCORE_SERVICE_URL = 'http://127.0.0.1:1';

    const res = await request(app).get('/readyz');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'not-ready');
  } finally {
    Object.assign(config, previous);
  }
});

test('GET /readyz stops probing when an upstream path returns to the same app', async () => {
  const previous = {
    APP_ROLE: config.APP_ROLE,
    READINESS_CHECK_UPSTREAMS: config.READINESS_CHECK_UPSTREAMS,
    SCORE_SERVICE_URL: config.SCORE_SERVICE_URL,
  };
  const server = http.createServer(app);
  let requests = 0;
  server.on('request', () => {
    requests += 1;
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const selfUrl = `http://127.0.0.1:${server.address().port}`;
    config.APP_ROLE = 'web';
    config.READINESS_CHECK_UPSTREAMS = true;
    config.SCORE_SERVICE_URL = selfUrl;

    const res = await fetch(`${selfUrl}/readyz`);
    assert.equal(res.status, 200);
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    Object.assign(config, previous);
  }
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

test('live stats retain names, age out inactive sessions, and paginate simulator rows', async () => {
  const humanSession = await request(app).get('/user/id?name=Alice');
  const simulatorSession = await request(app).get('/user/id?name=sim1');

  await request(app).post('/user/stats').type('form').send({
    userId: humanSession.body,
    name: 'Alice',
    score: '101',
    level: '1',
  });
  await request(app).post('/user/stats').type('form').send({
    userId: simulatorSession.body,
    name: 'sim1',
    score: '102',
    level: '1',
  });

  const page = await request(app).get('/user/stats?page=1&pageSize=1&includeSimulated=false');
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 1);
  assert.equal(page.body.items.some((row) => row.name === 'sim1'), false);
  assert.ok(page.body.total >= 1);

  const allHumanRows = await request(app).get('/user/stats?includeSimulated=false');
  assert.equal(allHumanRows.body.items.some((row) => row.name === 'Alice' && row.id === humanSession.body), true);

  db.users.get(humanSession.body).date = new Date(Date.now() - 301_000).toISOString();
  const aged = await request(app).get('/user/stats?includeSimulated=false');
  assert.equal(aged.status, 200);
  assert.equal(aged.body.items.some((row) => row.name === 'Alice'), false);
});

test('highscore list supports pagination and simulator filtering', async () => {
  await request(app).post('/highscores').type('form').send({ name: 'sim2', score: '200', level: '1' });
  await request(app).post('/highscores').type('form').send({ name: 'Human', score: '100', level: '1' });

  const page = await request(app).get('/highscores/list?page=1&pageSize=1&includeSimulated=false');
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 1);
  assert.equal(page.body.items.some((row) => /^sim\d+$/i.test(row.name)), false);
  assert.ok(page.body.total >= 1);
  const humanRows = await request(app).get('/highscores/list?includeSimulated=false');
  assert.equal(humanRows.body.items.some((row) => row.name === 'Human'), true);
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

test('public and internal score submissions reject invalid values before database writes', async () => {
  const invalidSubmissions = [
    { name: 'MISSING-SCORE', level: 1 },
    { name: 'MISSING-LEVEL', score: 100 },
    { name: 'NULL-SCORE', score: null, level: 1 },
    { name: 'NAN-SCORE', score: 'NaN', level: 1 },
    { name: 'TEXT-SCORE', score: 'abc', level: 1 },
    { name: 'PARTIAL-SCORE', score: '100tail', level: 1 },
    { name: 'FRACTIONAL-SCORE', score: 1.5, level: 1 },
    { name: 'NEGATIVE-SCORE', score: -1, level: 1 },
    { name: 'UNSAFE-SCORE', score: 9007199254740992, level: 1 },
    { name: 'TEXT-LEVEL', score: 100, level: 'abc' },
    { name: 'PARTIAL-LEVEL', score: 100, level: '1tail' },
    { name: 'FRACTIONAL-LEVEL', score: 100, level: 1.5 },
    { name: 'ZERO-LEVEL', score: 100, level: 0 },
    { name: 'NEGATIVE-LEVEL', score: 100, level: -1 },
    { name: 'UNSAFE-LEVEL', score: 0, level: 9007199254740992 },
    { name: 'OVER-CAP-LEVEL', score: 0, level: 11 },
    { name: 'IMPLAUSIBLE', score: 999999, level: 1 },
  ];

  for (const path of ['/highscores', '/internal/score/write']) {
    for (const submission of invalidSubmissions) {
      const before = db.highscores.length;
      const res = await request(app).post(path).send(submission);
      assert.equal(res.status, 400, `${path} should reject ${submission.name}`);
      assert.equal(db.highscores.length, before, `${path} should not store ${submission.name}`);
    }

    const before = db.highscores.length;
    const malformedBody = await request(app).post(path).type('json').send(null);
    assert.equal(malformedBody.status, 400, `${path} should reject a null body`);
    assert.equal(db.highscores.length, before, `${path} should not store a null body`);
  }
});

test('public and internal score submissions accept JSON numbers and score zero', async () => {
  for (const path of ['/highscores', '/internal/score/write']) {
    const res = await request(app).post(path).send({ name: 'ZERO', score: 0, level: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.rs, 'success');
    assert.equal(res.body.score, 0);
    assert.equal(res.body.level, 1);
  }
});

test('score submissions honor the unlimited MAX_LEVEL setting', async () => {
  const previous = config.MAX_LEVEL;

  try {
    config.MAX_LEVEL = 'unlimited';
    for (const path of ['/highscores', '/internal/score/write']) {
      const res = await request(app).post(path).send({ name: 'UNLIMITED', score: 0, level: 11 });
      assert.equal(res.status, 200);
      assert.equal(res.body.level, 11);
    }
  } finally {
    config.MAX_LEVEL = previous;
  }
});

test('Express trusts no forwarded client address by default and supports explicit loopback trust', async () => {
  const previous = config.TRUST_PROXY;
  const proxyIp = '198.51.100.42';
  const probeDb = new MemoryAdapter();
  await probeDb.connect();

  try {
    config.TRUST_PROXY = false;
    const untrustedApp = createApp({ db: probeDb });
    const untrusted = await request(untrustedApp)
      .post('/highscores')
      .set('x-forwarded-for', proxyIp)
      .send({ name: 'UNTRUSTED', score: 1, level: 1 });
    assert.equal(untrusted.status, 200);
    assert.notEqual(probeDb.highscores.at(-1).ip_addr, proxyIp);

    config.TRUST_PROXY = ['loopback'];
    const trustedApp = createApp({ db: probeDb });
    const trusted = await request(trustedApp)
      .post('/highscores')
      .set('x-forwarded-for', proxyIp)
      .send({ name: 'TRUSTED', score: 1, level: 1 });
    assert.equal(trusted.status, 200);
    assert.equal(probeDb.highscores.at(-1).ip_addr, proxyIp);
  } finally {
    config.TRUST_PROXY = previous;
    await probeDb.disconnect();
  }
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

test('demo fault counter does not duplicate the role label', async () => {
  const previous = { DEMO_SECURITY_MODE: config.DEMO_SECURITY_MODE, DEMO_TOKEN: config.DEMO_TOKEN };
  config.DEMO_SECURITY_MODE = true;
  config.DEMO_TOKEN = 'routes-test-token';
  try {
    const res = await request(app)
      .get('/highscores/list')
      .set('x-demo-token', config.DEMO_TOKEN)
      .set('x-demo-fault-role', 'web')
      .set('x-demo-fault-operation', 'scoreRead')
      .set('x-demo-fault-status', '503');
    assert.equal(res.status, 503);

    const metrics = await request(app).get('/metrics');
    const line = metrics.text.split('\n').find((l) => l.startsWith('pacman_demo_faults_total'));
    assert.ok(line, 'expected a pacman_demo_faults_total sample');
    const labelSection = line.slice(line.indexOf('{') + 1, line.indexOf('}'));
    const roleLabels = labelSection.split(',').filter((pair) => pair.startsWith('role='));
    assert.equal(roleLabels.length, 1, `expected exactly one role label in: ${line}`);
  } finally {
    Object.assign(config, previous);
  }
});

test('POST /highscores returns a real 5xx (not a disguised 200) when the database write fails', async () => {
  const original = db.insertScore;
  db.insertScore = async () => {
    throw new Error('simulated database write failure');
  };
  try {
    const res = await request(app)
      .post('/highscores')
      .type('form')
      .send({ name: 'DbFail', cloud: 'local', zone: 'lab', host: 'devbox', score: '100', level: '1' });
    assert.ok(res.status >= 500 && res.status <= 599, `expected a 5xx status, got ${res.status}`);
    assert.equal(res.body.rs, 'error');
  } finally {
    db.insertScore = original;
  }
});

test('POST /user/stats returns a real 5xx (not a disguised 200) when the database write fails', async () => {
  const { id: userId } = await db.createUser('DbFailUser');
  const original = db.updateUserStats;
  db.updateUserStats = async () => {
    throw new Error('simulated database write failure');
  };
  try {
    const res = await request(app)
      .post('/user/stats')
      .type('form')
      .send({ userId, score: '100', level: '1', lives: '3', elapsedTime: '10' });
    assert.ok(res.status >= 500 && res.status <= 599, `expected a 5xx status, got ${res.status}`);
    assert.equal(res.body.rs, 'error');
  } finally {
    db.updateUserStats = original;
  }
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
