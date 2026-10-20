import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadSimulatorSettings } from '../tools/simulator/config.js';
import {
  createFaultSelector,
  describeLogicalRequest,
  FAULT_HEADER_NAMES,
} from '../tools/simulator/faults.js';
import { createProbeScheduler, SECURITY_PROBE_REQUESTS } from '../tools/simulator/probes.js';
import { createRandom } from '../tools/simulator/random.js';
import { createMetrics, createRequestExecutor } from '../tools/simulator/request.js';
import { isValidScoreSubmission, runSimulator, submitScore } from '../tools/simulate-users.js';

function enabledFaults(overrides = {}) {
  return {
    enabled: true,
    seed: 19,
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
    ...overrides,
  };
}

function enabledProbes(overrides = {}) {
  return {
    enabled: true,
    seed: 29,
    durationSeconds: 60,
    operations: [{ operation: 'fileProbe', ratePerSecond: 2, maxCount: 2 }],
    ...overrides,
  };
}

test('per-worker pseudo-random streams repeat and remain distinct', () => {
  const first = createRandom(4321, 1);
  const replay = createRandom(4321, 1);
  const otherWorker = createRandom(4321, 2);
  const firstSequence = Array.from({ length: 6 }, () => first.next());
  const replaySequence = Array.from({ length: 6 }, () => replay.next());

  assert.deepEqual(replaySequence, firstSequence);
  assert.notDeepEqual(
    Array.from({ length: 6 }, () => otherWorker.next()),
    firstSequence,
  );
  assert.equal(createRandom(7, 3).int(4, 4), 4);
});

test('JSON fault and probe configuration rejects invalid roles, rates, bounds, and unknown fields', () => {
  assert.throws(
    () =>
      loadSimulatorSettings({
        DEMO_SECURITY_MODE: 'true',
        DEMO_TOKEN: 'secret',
        SIM_FAULTS_JSON: JSON.stringify(
          enabledFaults({
            rules: [
              {
                operations: ['userWrite'],
                targetRole: 'score',
                errorRate: 1,
                errorStatus: 503,
                delayRate: 0,
                delayMs: { min: 0, max: 0 },
              },
            ],
          }),
        ),
      }),
    /cannot consume operation/,
  );

  const webConsumerSettings = loadSimulatorSettings({
    DEMO_SECURITY_MODE: 'true',
    DEMO_TOKEN: 'secret',
    SIM_FAULTS_JSON: JSON.stringify(
      enabledFaults({
        rules: [
          {
            operations: ['scoreWrite'],
            targetRole: 'web',
            errorRate: 1,
            errorStatus: 503,
            delayRate: 0,
            delayMs: { min: 0, max: 0 },
          },
        ],
      }),
    ),
  });
  const webFault = createFaultSelector(webConsumerSettings.faults, 0).select(
    { operation: 'scoreWrite' },
    createRandom(19, 1),
    1,
  );
  assert.equal(webFault.targetRole, 'web');

  assert.throws(
    () =>
      loadSimulatorSettings({
        DEMO_SECURITY_MODE: 'true',
        DEMO_TOKEN: 'secret',
        SIM_FAULTS_JSON: JSON.stringify(enabledFaults({ durationSeconds: 3601 })),
      }),
    /durationSeconds/,
  );
  assert.throws(
    () =>
      loadSimulatorSettings({
        DEMO_SECURITY_MODE: 'true',
        DEMO_TOKEN: 'secret',
        SIM_FAULTS_JSON: JSON.stringify(
          enabledFaults({
            rules: [
              {
                operations: ['scoreWrite'],
                targetRole: 'score',
                errorRate: 0.6,
                errorStatus: 503,
                delayRate: 0.5,
                delayMs: { min: 0, max: 10_001 },
              },
            ],
          }),
        ),
      }),
    /errorRate plus delayRate/,
  );

  assert.throws(
    () =>
      loadSimulatorSettings({
        DEMO_SECURITY_MODE: 'true',
        DEMO_TOKEN: 'secret',
        SIM_FAULTS_JSON: JSON.stringify(
          enabledFaults({
            rules: [
              {
                operations: ['scoreWrite'],
                targetRole: 'score',
                errorRate: 0,
                errorStatus: 503,
                delayRate: 1,
                delayMs: { min: 1, max: 10_001 },
              },
            ],
          }),
        ),
      }),
    /delayMs.max/,
  );

  assert.throws(
    () =>
      loadSimulatorSettings({
        SIM_SECURITY_PROBES_JSON: JSON.stringify(
          enabledProbes({
            operations: [
              { operation: 'fileProbe', ratePerSecond: 10, maxCount: 1 },
              { operation: 'execProbe', ratePerSecond: 0.1, maxCount: 1 },
            ],
          }),
        ),
        DEMO_SECURITY_MODE: 'true',
        DEMO_TOKEN: 'secret',
      }),
    /combined ratePerSecond/,
  );
  assert.throws(
    () =>
      loadSimulatorSettings({
        SIM_SECURITY_PROBES_JSON: JSON.stringify(
          enabledProbes({
            operations: [{ operation: 'fileProbe', ratePerSecond: 1, maxCount: 1001 }],
          }),
        ),
        DEMO_SECURITY_MODE: 'true',
        DEMO_TOKEN: 'secret',
      }),
    /maxCount/,
  );
  assert.throws(
    () =>
      loadSimulatorSettings({
        SIM_SECURITY_PROBES_JSON: JSON.stringify(
          enabledProbes({
            operations: [
              { operation: 'fileProbe', ratePerSecond: 0.5, maxCount: 800 },
              { operation: 'execProbe', ratePerSecond: 0.5, maxCount: 201 },
            ],
          }),
        ),
        DEMO_SECURITY_MODE: 'true',
        DEMO_TOKEN: 'secret',
      }),
    /combined maxCount/,
  );

  assert.throws(() => loadSimulatorSettings({ USERS: '101' }), /USERS/);
  assert.throws(() => loadSimulatorSettings({ DURATION_SECONDS: '3601' }), /DURATION_SECONDS/);
  assert.throws(() => loadSimulatorSettings({ SIM_FAULTS_JSON: '{invalid' }), /valid JSON/);
  assert.throws(
    () =>
      loadSimulatorSettings({
        SIM_FAULTS_JSON: JSON.stringify({ ...enabledFaults(), unexpected: true }),
        DEMO_SECURITY_MODE: 'true',
        DEMO_TOKEN: 'secret',
      }),
    /unsupported field/,
  );
});

test('enabled fault and probe JSON requires explicit security mode and a token', () => {
  assert.throws(
    () =>
      loadSimulatorSettings({
        DEMO_TOKEN: 'secret',
        SIM_FAULTS_JSON: JSON.stringify(enabledFaults()),
      }),
    /DEMO_SECURITY_MODE/,
  );
  assert.throws(
    () =>
      loadSimulatorSettings({
        DEMO_SECURITY_MODE: 'true',
        SIM_SECURITY_PROBES_JSON: JSON.stringify(enabledProbes()),
      }),
    /DEMO_TOKEN/,
  );
  assert.equal(loadSimulatorSettings({}).faults.enabled, false);
  assert.equal(loadSimulatorSettings({}).probes.enabled, false);
});

test('fault selection matches only gameplay operations and selects one action', () => {
  const config = enabledFaults({
    rules: [
      {
        operations: ['scoreWrite', 'scoreRead'],
        targetRole: 'score',
        errorRate: 0.5,
        errorStatus: 503,
        delayRate: 0.5,
        delayMs: { min: 100, max: 100 },
      },
    ],
  });
  const selector = createFaultSelector(config, 1000);
  const random = createRandom(config.seed, 1);

  assert.equal(describeLogicalRequest('GET', '/config'), null);
  assert.equal(describeLogicalRequest('GET', '/user/id?name=sim1', { bootstrap: true }), null);
  assert.equal(describeLogicalRequest('POST', '/demo/incidents/file-probe'), null);
  assert.equal(describeLogicalRequest('GET', '/metrics'), null);
  assert.deepEqual(describeLogicalRequest('GET', '/highscores/list'), {
    operation: 'scoreRead',
  });

  const fault = selector.select(describeLogicalRequest('POST', '/highscores'), random, 1001);
  assert.ok(fault);
  assert.equal(fault.operation, 'scoreWrite');
  assert.equal(Number(fault.status !== undefined) + Number(fault.delayMs !== undefined), 1);
  assert.equal(
    selector.select(describeLogicalRequest('POST', '/highscores'), random, 61_000),
    null,
  );
});

test('probe scheduler uses only fixed POST routes and honors rate, count, and duration', () => {
  const scheduler = createProbeScheduler(
    enabledProbes({
      durationSeconds: 3,
      operations: [{ operation: 'fileProbe', ratePerSecond: 2, maxCount: 2 }],
    }),
    1000,
  );

  assert.deepEqual(scheduler.claimDue(1000), [
    { operation: 'fileProbe', ...SECURITY_PROBE_REQUESTS.fileProbe },
  ]);
  assert.deepEqual(scheduler.claimDue(1499), []);
  assert.deepEqual(scheduler.claimDue(1500), [
    { operation: 'fileProbe', ...SECURITY_PROBE_REQUESTS.fileProbe },
  ]);
  assert.deepEqual(scheduler.claimDue(2000), []);
  assert.deepEqual(scheduler.claimDue(4000), []);
  assert.equal(SECURITY_PROBE_REQUESTS.execProbe.method, 'POST');
  assert.equal(SECURITY_PROBE_REQUESTS.execProbe.path, '/demo/incidents/exec-probe');
  assert.deepEqual(scheduler.snapshot()[0].attempted, 2);

  const combinedScheduler = createProbeScheduler(
    enabledProbes({
      durationSeconds: 1,
      operations: [
        { operation: 'fileProbe', ratePerSecond: 5, maxCount: 10 },
        { operation: 'execProbe', ratePerSecond: 5, maxCount: 10 },
      ],
    }),
    0,
  );
  const probeRandom = createRandom(29, 0);
  assert.equal(combinedScheduler.claimDue(0, probeRandom).length, 1);
  assert.deepEqual(combinedScheduler.claimDue(99, probeRandom), []);
  assert.equal(combinedScheduler.claimDue(100, probeRandom).length, 1);
  assert.equal(
    combinedScheduler.snapshot().reduce((sum, operation) => sum + operation.attempted, 0),
    2,
  );
});

test('request executor attaches one authorized fault and keeps bootstrap and probes exempt', async () => {
  const seen = [];
  const metrics = createMetrics();
  const config = enabledFaults();
  const request = createRequestExecutor({
    metrics,
    faultSelector: createFaultSelector(config, 0),
    faultRandom: createRandom(config.seed, 1),
    demoToken: 'secret-value',
    demoTokenHeader: 'x-custom-demo',
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ rs: 'success' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    now: () => 1,
    onFailure: () => assert.fail('unexpected request failure'),
  });

  await request('http://example.test', '/config', {
    bootstrap: true,
    headers: { 'X-Demo-Fault-Status': '599' },
  });
  await request('http://example.test', '/user/id?name=sim1', { bootstrap: true });
  await request('http://example.test', '/highscores', { method: 'POST' });
  await request('http://example.test', '/demo/incidents/file-probe', {
    method: 'POST',
    demoAuth: true,
    probeOperation: 'fileProbe',
    optional: true,
  });

  const [configRequest, userBootstrap, scoreWrite, probe] = seen;
  assert.equal(configRequest.headers['x-demo-fault-status'], undefined);
  assert.equal(configRequest.headers['x-custom-demo'], undefined);
  assert.equal(userBootstrap.headers['x-custom-demo'], undefined);
  assert.equal(scoreWrite.headers['x-custom-demo'], 'secret-value');
  assert.equal(scoreWrite.headers[FAULT_HEADER_NAMES.role], 'score');
  assert.equal(scoreWrite.headers[FAULT_HEADER_NAMES.operation], 'scoreWrite');
  assert.equal(scoreWrite.headers[FAULT_HEADER_NAMES.status], '503');
  assert.equal(scoreWrite.headers[FAULT_HEADER_NAMES.delayMs], undefined);
  assert.equal(probe.headers['x-custom-demo'], 'secret-value');
  assert.equal(probe.headers[FAULT_HEADER_NAMES.role], undefined);
  assert.equal(metrics.requests.attempted, 4);
  assert.equal(metrics.probes.fileProbe.succeeded, 1);
});

test('optional HTTP failures and timeouts remain in separate request accounting', async () => {
  const metrics = createMetrics();
  let calls = 0;
  const warnings = [];
  const request = createRequestExecutor({
    metrics,
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      if (calls === 1) return new Response('unavailable', { status: 503 });
      if (calls === 2)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    onFailure: (warning) => warnings.push(warning),
  });

  await request('http://example.test', '/optional', { optional: true, timeoutMs: 30 });
  await request('http://example.test', '/ok', { timeoutMs: 30 });
  await request('http://example.test', '/slow', { optional: true, timeoutMs: 1 });

  assert.deepEqual(metrics.requests, { attempted: 3, succeeded: 1, failed: 2, timeouts: 1 });
  assert.deepEqual(warnings, []);
});

test('only valid successful score writes increment scoresSubmitted, with no write retry', async () => {
  const metrics = createMetrics();
  const responses = [
    { ok: true, payload: { rs: 'success' } },
    { ok: true, payload: { rs: 'error' } },
  ];
  let calls = 0;
  const options = {
    baseUrl: 'http://example.test',
    timeoutMs: 100,
    metrics,
    request: async () => {
      calls += 1;
      return responses.shift();
    },
  };
  const validSession = {
    sessionId: 1,
    name: 'sim1',
    userAgent: 'test',
    score: 1400,
    level: 1,
    maxLevel: 10,
  };
  const invalidSession = { ...validSession, score: 1401 };

  assert.equal(isValidScoreSubmission(validSession), true);
  assert.equal(isValidScoreSubmission(invalidSession), false);
  assert.equal(await submitScore(invalidSession, options), false);
  assert.equal(await submitScore(validSession, options), true);
  assert.equal(await submitScore(validSession, options), false);
  assert.equal(calls, 2);
  assert.deepEqual(metrics.scoreSubmissions, { attempted: 2, succeeded: 1, failed: 1, invalid: 1 });
  assert.equal(metrics.scoresSubmitted, 1);
});

test('a real simulator session makes a faultable live user-stats read after bootstrap', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    req.resume();
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, headers: req.headers });

    let status = 200;
    let payload = {};
    if (url.pathname === '/config') payload = { maxLevel: 10 };
    else if (url.pathname === '/location/metadata') payload = {};
    else if (url.pathname === '/user/id') payload = 'fixture-user-id';
    else if (url.pathname === '/user/stats' && req.method === 'POST') {
      payload = { rs: 'success' };
    } else if (url.pathname === '/user/stats' && req.method === 'GET') {
      if (req.headers['x-demo-fault-operation'] === 'userRead') status = 503;
      payload = [];
    }

    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const metrics = await runSimulator({
      PACMAN_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      USERS: '1',
      DURATION_SECONDS: '1',
      STATIC_PATHS: '',
      MIN_THINK_MS: '1',
      MAX_THINK_MS: '1',
      MIN_SESSION_SECONDS: '1',
      MAX_SESSION_SECONDS: '1',
      MIN_SESSION_GAP_MS: '0',
      MAX_SESSION_GAP_MS: '0',
      HIGH_SCORE_READ_RATE: '0',
      SCORE_SUBMIT_RATE: '0',
      FINAL_SCORE_SUBMIT_RATE: '0',
      DEMO_SECURITY_MODE: 'true',
      DEMO_TOKEN: 'simulator-loop-test-token',
      SIM_FAULTS_JSON: JSON.stringify(
        enabledFaults({
          durationSeconds: 60,
          rules: [
            {
              operations: ['userRead'],
              targetRole: 'user',
              errorRate: 1,
              errorStatus: 503,
              delayRate: 0,
              delayMs: { min: 0, max: 0 },
            },
          ],
        }),
      ),
    });

    const statsReads = requests.filter(
      ({ method, path }) => method === 'GET' && path === '/user/stats',
    );
    const userReadFaults = statsReads.filter(
      ({ headers }) => headers['x-demo-fault-operation'] === 'userRead',
    );
    const userBootstrap = requests.filter(
      ({ method, path }) => method === 'GET' && path === '/user/id',
    );

    assert.ok(statsReads.length >= 1, 'the simulator should read live user stats');
    assert.equal(userReadFaults.length, statsReads.length);
    assert.equal(userReadFaults[0].headers['x-demo-fault-role'], 'user');
    assert.equal(userReadFaults[0].headers['x-demo-fault-status'], '503');
    assert.ok(userBootstrap.length >= 1);
    assert.equal(userBootstrap[0].headers['x-demo-fault-operation'], undefined);
    assert.equal(userBootstrap[0].headers['x-demo-token'], undefined);
    assert.ok(metrics.requests.failed >= statsReads.length);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
