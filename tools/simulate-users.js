#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSimulatorSettings } from './simulator/config.js';
import { createFaultSelector } from './simulator/faults.js';
import { createProbeScheduler } from './simulator/probes.js';
import { createRandom } from './simulator/random.js';
import { createMetrics, createRequestExecutor } from './simulator/request.js';

const DEFAULT_STATIC_PATHS = [
  '/',
  '/style.css',
  '/pacman-canvas.css',
  '/pacman-canvas.js',
  '/js/jquery-3.4.1.min.js',
  '/js/jquery.hammer.min.js',
];

const userAgents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 PacmanSynthetic/1.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 PacmanSynthetic/1.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 PacmanSynthetic/1.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 PacmanSynthetic/1.0',
];

const MAX_POINTS_PER_LEVEL = 1400;
let stopping = false;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body;
}

function createSessionState(sessionId) {
  return {
    sessionId,
    name: `sim${sessionId}`,
    userAgent: userAgents[sessionId % userAgents.length],
    userId: null,
    cloud: 'synthetic',
    zone: `sim-zone-${(sessionId % 3) + 1}`,
    host: `sim-host-${(sessionId % 12) + 1}`,
    score: 0,
    level: 1,
    lives: 3,
    elapsedTime: 0,
    maxLevel: 10,
  };
}

async function loadBrowserShell(session, options, random) {
  const headers = {
    'user-agent': session.userAgent,
    'x-pacman-simulator-session': String(session.sessionId),
  };

  for (const assetPath of options.staticPaths) {
    await options.request(options.baseUrl, assetPath, { headers, timeoutMs: options.timeoutMs });
    await sleep(random.int(25, 125));
  }

  const config = await options.request(options.baseUrl, '/config', {
    headers,
    timeoutMs: options.timeoutMs,
    bootstrap: true,
  });
  const location = await options.request(options.baseUrl, '/location/metadata', {
    headers,
    timeoutMs: options.timeoutMs,
    optional: true,
    bootstrap: true,
  });
  const userId = await options.request(
    options.baseUrl,
    `/user/id?name=${encodeURIComponent(session.name)}`,
    {
      headers,
      timeoutMs: options.timeoutMs,
      bootstrap: true,
    },
  );

  if (location?.ok && location.payload && typeof location.payload === 'object') {
    session.cloud = location.payload.cloud || session.cloud;
    session.zone = location.payload.zone || session.zone;
    session.host = location.payload.host || session.host;
  }

  if (userId?.ok && typeof userId.payload === 'string') session.userId = userId.payload;
  const configuredMaxLevel = config?.ok ? config.payload?.maxLevel : null;
  if (configuredMaxLevel === 'unlimited') session.maxLevel = 'unlimited';
  else if (Number.isSafeInteger(Number(configuredMaxLevel)) && Number(configuredMaxLevel) > 0) {
    session.maxLevel = Number(configuredMaxLevel);
  }
}

async function updateStats(session, options) {
  if (!session.userId) return null;
  return options.request(options.baseUrl, '/user/stats', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': session.userAgent,
      'x-pacman-simulator-session': String(session.sessionId),
    },
    body: formBody({
      userId: session.userId,
      name: session.name,
      cloud: session.cloud,
      zone: session.zone,
      host: session.host,
      score: session.score,
      level: session.level,
      lives: session.lives,
      elapsedTime: session.elapsedTime,
    }),
  });
}

async function readStats(session, options) {
  if (!session.userId) return null;
  return options.request(options.baseUrl, '/user/stats?includeSimulated=true', {
    timeoutMs: options.timeoutMs,
    optional: true,
    headers: {
      'user-agent': session.userAgent,
      'x-pacman-simulator-session': String(session.sessionId),
    },
  });
}

export function isValidScoreSubmission(session) {
  if (!Number.isSafeInteger(session.score) || session.score < 0) return false;
  if (!Number.isSafeInteger(session.level) || session.level < 1) return false;
  if (session.maxLevel !== 'unlimited' && session.level > session.maxLevel) return false;
  return session.score / session.level <= MAX_POINTS_PER_LEVEL;
}

export async function submitScore(session, options) {
  if (!isValidScoreSubmission(session)) {
    options.metrics.scoreSubmissions.invalid += 1;
    return false;
  }

  options.metrics.scoreSubmissions.attempted += 1;
  const result = await options.request(options.baseUrl, '/highscores', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': session.userAgent,
      'x-pacman-simulator-session': String(session.sessionId),
    },
    body: formBody({
      name: session.name,
      cloud: session.cloud,
      zone: session.zone,
      host: session.host,
      score: session.score,
      level: session.level,
    }),
  });
  if (result?.ok && result.payload?.rs === 'success') {
    options.metrics.scoreSubmissions.succeeded += 1;
    options.metrics.scoresSubmitted += 1;
    return true;
  }
  options.metrics.scoreSubmissions.failed += 1;
  return false;
}

async function runProbeWorker(settings, metrics, probeScheduler, startedAt) {
  const random = createRandom(settings.probes.seed, 0);
  const request = createRequestExecutor({
    metrics,
    demoToken: settings.demoToken,
    demoTokenHeader: settings.demoTokenHeader,
  });
  const session = { sessionId: 0, userAgent: userAgents[0] };
  const options = { ...settings, request };

  while (
    !stopping &&
    !(settings.durationSeconds > 0 && Date.now() - startedAt >= settings.durationSeconds * 1000)
  ) {
    const now = Date.now();
    const due = probeScheduler.claimDue(now, random);
    if (due.length === 0) {
      const nextDelay = probeScheduler.nextDelay(now);
      if (nextDelay === null) return;
      await sleep(Math.max(1, Math.min(nextDelay, 1000)));
      continue;
    }
    for (const probe of due) {
      await options.request(options.baseUrl, probe.path, {
        method: probe.method,
        timeoutMs: options.timeoutMs,
        optional: true,
        demoAuth: true,
        probeOperation: probe.operation,
        headers: {
          'user-agent': session.userAgent,
          'x-pacman-simulator-session': String(session.sessionId),
        },
      });
    }
  }
}

async function runUserSession(sessionId, options, random, now) {
  const session = createSessionState(sessionId);
  options.metrics.sessionsStarted += 1;

  await loadBrowserShell(session, options, random);
  const sessionEndsAt = now() + random.int(options.minSessionMs, options.maxSessionMs);
  let readLiveStats = false;

  while (!stopping && now() < sessionEndsAt && !options.deadlineExpired()) {
    session.elapsedTime += random.int(1, 6);
    if (
      random.chance(0.08) &&
      (session.maxLevel === 'unlimited' || session.level < session.maxLevel)
    ) {
      session.level += 1;
    }
    session.score = Math.min(
      session.score + random.int(10, 140),
      session.level * MAX_POINTS_PER_LEVEL,
    );
    if (random.chance(0.04)) session.lives = Math.max(1, session.lives - 1);

    await updateStats(session, options);
    if (!readLiveStats) {
      await readStats(session, options);
      readLiveStats = true;
    }

    if (random.chance(options.highScoreReadRate)) {
      await options.request(options.baseUrl, '/highscores/list', {
        headers: {
          'user-agent': session.userAgent,
          'x-pacman-simulator-session': String(session.sessionId),
        },
        timeoutMs: options.timeoutMs,
      });
    }

    if (random.chance(options.scoreSubmitRate)) await submitScore(session, options);
    await sleep(random.int(options.minThinkMs, options.maxThinkMs));
  }

  if (!stopping && session.score > 0 && random.chance(options.finalScoreSubmitRate)) {
    await submitScore(session, options);
  }
  options.metrics.sessionsCompleted += 1;
}

function logMetrics(metrics, startedAt) {
  const runtimeSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'pacman simulator metrics',
      runtimeSeconds,
      requests: metrics.requests.attempted,
      requestMetrics: metrics.requests,
      failures: metrics.requests.failed,
      timeouts: metrics.requests.timeouts,
      probes: metrics.probes,
      sessionsStarted: metrics.sessionsStarted,
      sessionsCompleted: metrics.sessionsCompleted,
      scoresSubmitted: metrics.scoresSubmitted,
      scoreSubmissions: metrics.scoreSubmissions,
      requestsPerSecond: Number((metrics.requests.attempted / runtimeSeconds).toFixed(2)),
    }),
  );
}

export async function runSimulator(env = process.env) {
  const settings = loadSimulatorSettings(env);
  const startedAt = Date.now();
  const metrics = createMetrics();
  const faultSelector = settings.faults.enabled
    ? createFaultSelector(settings.faults, startedAt)
    : undefined;
  const probeScheduler = settings.probes.enabled
    ? createProbeScheduler(settings.probes, startedAt)
    : undefined;
  const options = {
    ...settings,
    metrics,
    probeScheduler,
    staticPaths: settings.staticPaths || DEFAULT_STATIC_PATHS,
    deadlineExpired: () =>
      settings.durationSeconds > 0 && Date.now() - startedAt >= settings.durationSeconds * 1000,
  };

  const safeOptions = {
    baseUrl: settings.baseUrl,
    users: settings.users,
    durationSeconds: settings.durationSeconds,
    minThinkMs: settings.minThinkMs,
    maxThinkMs: settings.maxThinkMs,
    minSessionMs: settings.minSessionMs,
    maxSessionMs: settings.maxSessionMs,
    minSessionGapMs: settings.minSessionGapMs,
    maxSessionGapMs: settings.maxSessionGapMs,
    scoreSubmitRate: settings.scoreSubmitRate,
    finalScoreSubmitRate: settings.finalScoreSubmitRate,
    highScoreReadRate: settings.highScoreReadRate,
    timeoutMs: settings.timeoutMs,
    staticPaths: options.staticPaths,
    faults: settings.faults,
    probes: settings.probes,
  };
  console.log(
    JSON.stringify({ level: 'info', msg: 'starting pacman user simulator', ...safeOptions }),
  );

  const interval = setInterval(() => logMetrics(metrics, startedAt), settings.metricsIntervalMs);
  const workers = Array.from({ length: settings.users }, (_, workerIndex) => {
    const workerId = workerIndex + 1;
    const random = createRandom(settings.randomSeed, workerId);
    const workerOptions = {
      ...options,
      request: createRequestExecutor({
        metrics,
        faultSelector,
        faultRandom: settings.faults.enabled ? random : undefined,
        demoToken: settings.demoToken,
        demoTokenHeader: settings.demoTokenHeader,
      }),
    };
    return (async () => {
      let sessionCounter = workerId;
      while (!stopping && !options.deadlineExpired()) {
        await runUserSession(sessionCounter, workerOptions, random, Date.now);
        sessionCounter += settings.users;
        await sleep(random.int(settings.minSessionGapMs, settings.maxSessionGapMs));
      }
    })();
  });
  if (settings.probes.enabled)
    workers.push(runProbeWorker(settings, metrics, probeScheduler, startedAt));
  try {
    await Promise.all(workers);
  } finally {
    clearInterval(interval);
  }
  logMetrics(metrics, startedAt);
  return metrics;
}

function isDirectExecution() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  runSimulator().catch((error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'pacman simulator failed',
        error: error.stack || error.message,
      }),
    );
    process.exitCode = 1;
  });
}
