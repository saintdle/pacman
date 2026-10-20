import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
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
