import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryAdapter } from '../src/db/memory.js';
import { config } from '../src/config/index.js';
import { metricsMiddleware, renderMetrics } from '../src/metrics.js';

// Mirrors the real /demo router shape in src/routes/demo.js: a sub-router
// mounted at /demo whose probe handlers report failures via next(err).
// Express restores req.baseUrl to the parent value ('') as that error
// unwinds back through the app-level handler, before this middleware's
// 'finish' listener records the metric — the exact mechanism behind the
// "unknown" route label on enforced probe failures.
function buildProbeApp() {
  const app = express();
  app.use(metricsMiddleware());

  const demo = express.Router();
  demo.post('/incidents/file-probe', (req, res, next) => {
    if (req.headers['x-simulate-probe-error']) return next(new Error('simulated file probe failure'));
    return res.json({ rs: 'success', probe: 'file' });
  });
  demo.post('/incidents/exec-probe', (req, res, next) => {
    if (req.headers['x-simulate-probe-error']) return next(new Error('simulated exec probe failure'));
    return res.json({ rs: 'success', probe: 'exec' });
  });
  demo.post('/incidents/other', (req, res, next) => {
    next(new Error('simulated unrelated failure'));
  });
  app.use('/demo', demo);

  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

function hasCounterSample(metricsText, name, labelFragments) {
  return metricsText
    .split('\n')
    .some((line) => line.startsWith(`${name}{`) && labelFragments.every((fragment) => line.includes(fragment)));
}

function counterSampleValue(metricsText, name, labelFragments) {
  const sample = metricsText
    .split('\n')
    .find((line) => line.startsWith(`${name}{`) && labelFragments.every((fragment) => line.includes(fragment)));
  return sample ? Number(sample.trim().split(/\s+/).at(-1)) : 0;
}

describe('routeLabel survives Express error-unwinding for known demo probe routes', () => {
  test('file-probe keeps a fixed route label on both success and enforced failure', async () => {
    const app = buildProbeApp();

    const ok = await request(app).post('/demo/incidents/file-probe');
    assert.equal(ok.status, 200);

    const failed = await request(app).post('/demo/incidents/file-probe').set('x-simulate-probe-error', '1');
    assert.equal(failed.status, 500);

    const metricsText = renderMetrics();
    assert.ok(
      hasCounterSample(metricsText, 'pacman_http_requests_total', ['route="/demo/incidents/file-probe"', 'status="200"']),
      `expected the 200 sample to keep the fixed file-probe route:\n${metricsText}`,
    );
    assert.ok(
      hasCounterSample(metricsText, 'pacman_http_requests_total', ['route="/demo/incidents/file-probe"', 'status="500"']),
      `expected the enforced 500 to keep the fixed file-probe route instead of "unknown":\n${metricsText}`,
    );
  });

  test('exec-probe keeps a fixed route label on both success and enforced failure', async () => {
    const app = buildProbeApp();

    const ok = await request(app).post('/demo/incidents/exec-probe');
    assert.equal(ok.status, 200);

    const failed = await request(app).post('/demo/incidents/exec-probe').set('x-simulate-probe-error', '1');
    assert.equal(failed.status, 500);

    const metricsText = renderMetrics();
    assert.ok(
      hasCounterSample(metricsText, 'pacman_http_requests_total', ['route="/demo/incidents/exec-probe"', 'status="200"']),
      `expected the 200 sample to keep the fixed exec-probe route:\n${metricsText}`,
    );
    assert.ok(
      hasCounterSample(metricsText, 'pacman_http_requests_total', ['route="/demo/incidents/exec-probe"', 'status="500"']),
      `expected the enforced 500 to keep the fixed exec-probe route instead of "unknown":\n${metricsText}`,
    );
  });

  test('a failure on a mounted route outside the known probe allowlist stays bounded to "unknown"', async () => {
    const app = buildProbeApp();

    const failed = await request(app).post('/demo/incidents/other');
    assert.equal(failed.status, 500);

    const metricsText = renderMetrics();
    assert.ok(
      hasCounterSample(metricsText, 'pacman_http_requests_total', ['route="unknown"', 'status="500"', 'method="POST"']),
      `expected an unmapped route failure to stay bounded to "unknown":\n${metricsText}`,
    );
    assert.ok(
      !metricsText.includes('route="/demo/incidents/other"'),
      'routes outside the explicit allowlist must never be labeled individually',
    );
  });

  test('a query string on a known probe route does not leak into the fixed label', async () => {
    const app = buildProbeApp();

    const failed = await request(app)
      .post('/demo/incidents/file-probe?debug=1')
      .set('x-simulate-probe-error', '1');
    assert.equal(failed.status, 500);

    const metricsText = renderMetrics();
    assert.ok(
      hasCounterSample(metricsText, 'pacman_http_requests_total', ['route="/demo/incidents/file-probe"', 'status="500"']),
      `expected the query string to be stripped from the fixed probe label:\n${metricsText}`,
    );
    assert.ok(
      !metricsText.includes('debug='),
      'query parameters must never be reflected into a route label',
    );
  });
});

test('main API failures keep the route label through injection and error unwinding', async () => {
  const previous = {
    APP_ROLE: config.APP_ROLE,
    SCORE_SERVICE_URL: config.SCORE_SERVICE_URL,
    DEMO_SECURITY_MODE: config.DEMO_SECURITY_MODE,
    DEMO_TOKEN: config.DEMO_TOKEN,
  };
  const token = 'metrics-route-label-test-token';
  const db = new MemoryAdapter();
  const app = createApp({ db });

  try {
    config.APP_ROLE = 'web';
    config.SCORE_SERVICE_URL = undefined;
    config.DEMO_SECURITY_MODE = true;
    config.DEMO_TOKEN = token;

    const metricsBefore = renderMetrics();
    const healthy = await request(app).get('/highscores/list');
    const injected = await request(app)
      .get('/highscores/list')
      .set('x-demo-token', token)
      .set('x-demo-fault-role', 'web')
      .set('x-demo-fault-operation', 'scoreRead')
      .set('x-demo-fault-status', '503');

    const healthyTrailingSlash = await request(app).get('/highscores/list/');
    const caseVariantHealthy = await request(app).get('/Highscores/List/');
    const headTrailingSlashHealthy = await request(app).head('/highscores/list/');
    const injectedTrailingSlash = await request(app)
      .get('/highscores/list/')
      .set('x-demo-token', token)
      .set('x-demo-fault-role', 'web')
      .set('x-demo-fault-operation', 'pageView')
      .set('x-demo-fault-status', '503');

    const originalListTopScores = db.listTopScores;
    db.listTopScores = async () => {
      throw new Error('simulated adapter failure');
    };
    const adapterFailure = await request(app).get('/highscores/list');
    const trailingSlashFailure = await request(app).get('/highscores/list/');
    const caseVariantFailure = await request(app).get('/Highscores/List/');
    const headTrailingSlashFailure = await request(app).head('/highscores/list/');
    const unknownExtraSlash = await request(app).get('/highscores/list///');
    db.listTopScores = originalListTopScores;

    const unknownPath = '/profiles/private-route-label-fixture';
    const unknown = await request(app).get(`${unknownPath}?token=private-fixture`);
    assert.equal(healthy.status, 200);
    assert.equal(injected.status, 503);
    assert.equal(healthyTrailingSlash.status, 200);
    assert.equal(caseVariantHealthy.status, 200);
    assert.equal(headTrailingSlashHealthy.status, 200);
    assert.equal(injectedTrailingSlash.status, 503);
    assert.equal(adapterFailure.status, 500);
    assert.equal(trailingSlashFailure.status, 500);
    assert.equal(caseVariantFailure.status, 500);
    assert.equal(headTrailingSlashFailure.status, 500);
    assert.equal(unknownExtraSlash.status, 404);
    assert.equal(unknown.status, 404);

    const metricsText = renderMetrics();
    const requestMetric = 'pacman_http_requests_total';
    for (const [method, status, expectedDelta] of [
      ['GET', '200', 3],
      ['GET', '503', 2],
      ['GET', '500', 3],
      ['HEAD', '200', 1],
      ['HEAD', '500', 1],
    ]) {
      const labels = [`method="${method}"`, 'route="/highscores/list"', `status="${status}"`];
      assert.equal(
        counterSampleValue(metricsText, requestMetric, labels) - counterSampleValue(metricsBefore, requestMetric, labels),
        expectedDelta,
        `expected ${expectedDelta} ${method} /highscores/list ${status} samples across accepted route forms:\n${metricsText}`,
      );
    }
    for (const [method, status, expectedDelta] of [['GET', '404', 2], ['GET', '503', 0], ['GET', '500', 0]]) {
      const labels = [`method="${method}"`, 'route="unknown"', `status="${status}"`];
      assert.equal(
        counterSampleValue(metricsText, requestMetric, labels) - counterSampleValue(metricsBefore, requestMetric, labels),
        expectedDelta,
        `unexpected unknown-route samples for ${method} status ${status}:\n${metricsText}`,
      );
    }
    assert.ok(!metricsText.includes('/highscores/list///'), 'a non-matching repeated slash must not be normalized into a route');
    assert.ok(
      hasCounterSample(metricsText, 'pacman_http_requests_total', [
        'method="GET"',
        'route="unknown"',
        'status="404"',
      ]),
      'unknown URLs must remain in the bounded unknown bucket',
    );
    assert.ok(!metricsText.includes(unknownPath), 'unknown paths must not become metric labels');
    assert.ok(!metricsText.includes('private-fixture'), 'query strings must not become metric labels');
  } finally {
    Object.assign(config, previous);
  }
});
