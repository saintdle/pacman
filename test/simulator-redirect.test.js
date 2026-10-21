import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFaultSelector } from '../tools/simulator/faults.js';
import { createRandom } from '../tools/simulator/random.js';
import { createMetrics, createRequestExecutor } from '../tools/simulator/request.js';
import { submitScore } from '../tools/simulate-users.js';

const demoToken = 'simulator-test-token';
const tokenHeaders = ['x-demo-token', 'x-custom-demo-token'];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function startRedirectFixture() {
  const sinkRequests = [];
  const sink = createServer((req, res) => {
    sinkRequests.push({ method: req.method, headers: req.headers, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rs: 'success' }));
  });
  const sinkPort = await listen(sink);
  const sinkUrl = `http://127.0.0.1:${sinkPort}/redirected`;

  const sourceRequests = [];
  const source = createServer((req, res) => {
    sourceRequests.push({ method: req.method, headers: req.headers, url: req.url });
    res.writeHead(307, { location: sinkUrl });
    res.end();
  });
  const sourcePort = await listen(source);

  return {
    baseUrl: `http://127.0.0.1:${sourcePort}`,
    sourceRequests,
    sinkRequests,
    close: async () => {
      await Promise.all([close(source), close(sink)]);
    },
  };
}

const cases = [
  ...tokenHeaders.flatMap((tokenHeader) => [
    { tokenHeader, kind: 'fault write' },
    { tokenHeader, kind: 'file probe' },
  ]),
];

for (const { tokenHeader, kind } of cases) {
  test(`simulator rejects redirects for ${kind} with ${tokenHeader}`, async () => {
    const fixture = await startRedirectFixture();
    const metrics = createMetrics();
    const failures = [];
    const request = createRequestExecutor({
      metrics,
      demoToken,
      demoTokenHeader: tokenHeader,
      faultSelector: createFaultSelector(
        {
          enabled: true,
          durationSeconds: 60,
          rules: [
            {
              operations: ['scoreWrite'],
              targetRole: 'score',
              errorRate: 1,
              errorStatus: 503,
              delayRate: 0,
              delayMs: { min: 0, max: 0 },
            },
          ],
        },
        0,
      ),
      faultRandom: createRandom(19, 1),
      now: () => 1,
      onFailure: (failure) => failures.push(failure),
    });

    try {
      let operationResult;
      if (kind === 'fault write') {
        operationResult = await submitScore(
          {
            sessionId: 1,
            name: 'sim1',
            userAgent: 'PacmanSynthetic/1.0',
            cloud: 'synthetic',
            zone: 'sim-zone-1',
            host: 'sim-host-1',
            score: 100,
            level: 1,
            maxLevel: 10,
          },
          { request, baseUrl: fixture.baseUrl, timeoutMs: 1000, metrics },
        );
      } else {
        operationResult = await request(fixture.baseUrl, '/demo/incidents/file-probe', {
          method: 'POST',
          demoAuth: true,
          optional: true,
          probeOperation: 'fileProbe',
          timeoutMs: 1000,
        });
      }

      const evidence = {
        result: operationResult,
        sourceRequests: fixture.sourceRequests,
        sinkRequests: fixture.sinkRequests,
        requests: metrics.requests,
        scoreSubmissions: metrics.scoreSubmissions,
        scoresSubmitted: metrics.scoresSubmitted,
        fileProbe: metrics.probes.fileProbe,
      };

      assert.equal(fixture.sourceRequests.length, 1, 'the executor should make one request');
      assert.equal(fixture.sourceRequests[0].method, 'POST');
      assert.equal(
        fixture.sourceRequests[0].headers[tokenHeader],
        demoToken,
        'the selected backend should receive the configured token header',
      );
      assert.equal(
        fixture.sinkRequests.length,
        0,
        `redirect destination must not receive the request: ${JSON.stringify(evidence)}`,
      );
      assert.deepEqual(metrics.requests, { attempted: 1, succeeded: 0, failed: 1, timeouts: 0 });

      if (kind === 'fault write') {
        assert.equal(operationResult, false);
        assert.deepEqual(metrics.scoreSubmissions, {
          attempted: 1,
          succeeded: 0,
          failed: 1,
          invalid: 0,
        });
        assert.equal(metrics.scoresSubmitted, 0);
        assert.equal(fixture.sourceRequests[0].headers['x-demo-fault-operation'], 'scoreWrite');
        assert.equal(failures.length, 1);
      } else {
        assert.equal(operationResult.ok, false);
        assert.deepEqual(metrics.probes.fileProbe, {
          attempted: 1,
          succeeded: 0,
          failed: 1,
          timeouts: 0,
        });
        assert.equal(failures.length, 0, 'optional probe failures should remain quiet');
      }
    } finally {
      await fixture.close();
    }
  });
}
