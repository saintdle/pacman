#!/usr/bin/env node

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

const startedAt = Date.now();
let stopping = false;

const metrics = {
  requests: 0,
  failures: 0,
  sessionsStarted: 0,
  sessionsCompleted: 0,
  scoresSubmitted: 0,
};

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function floatEnv(name, fallback, { min = 0, max = 1 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function splitEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function chance(probability) {
  return Math.random() < probability;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body;
}

async function request(baseUrl, path, { method = 'GET', body, headers = {}, timeoutMs, optional = false }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  metrics.requests += 1;

  try {
    const response = await fetch(buildUrl(baseUrl, path), {
      method,
      body,
      headers,
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
    return payload;
  } catch (err) {
    if (!optional) {
      metrics.failures += 1;
      console.error(JSON.stringify({ level: 'warn', msg: 'simulator request failed', path, error: err.message }));
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
  };
}

async function loadBrowserShell(baseUrl, session, options) {
  const headers = {
    'user-agent': session.userAgent,
    'x-pacman-simulator-session': String(session.sessionId),
  };

  for (const assetPath of options.staticPaths) {
    await request(baseUrl, assetPath, { headers, timeoutMs: options.timeoutMs });
    await sleep(randomInt(25, 125));
  }

  const config = await request(baseUrl, '/config', { headers, timeoutMs: options.timeoutMs });
  const location = await request(baseUrl, '/location/metadata', {
    headers,
    timeoutMs: options.timeoutMs,
    optional: true,
  });
  const userId = await request(baseUrl, `/user/id?name=${encodeURIComponent(session.name)}`, {
    headers,
    timeoutMs: options.timeoutMs,
  });

  if (location && typeof location === 'object') {
    session.cloud = location.cloud || session.cloud;
    session.zone = location.zone || session.zone;
    session.host = location.host || session.host;
  }

  if (typeof userId === 'string') session.userId = userId;
  if (config?.maxLevel && Number.isFinite(Number.parseInt(config.maxLevel, 10))) {
    session.maxLevel = Number.parseInt(config.maxLevel, 10);
  }
}

async function updateStats(baseUrl, session, options) {
  if (!session.userId) return;
  await request(baseUrl, '/user/stats', {
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

async function submitScore(baseUrl, session, options) {
  await request(baseUrl, '/highscores', {
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
  metrics.scoresSubmitted += 1;
}

async function runUserSession(sessionId, options) {
  const session = createSessionState(sessionId);
  metrics.sessionsStarted += 1;

  await loadBrowserShell(options.baseUrl, session, options);
  const sessionEndsAt = Date.now() + randomInt(options.minSessionMs, options.maxSessionMs);

  while (!stopping && Date.now() < sessionEndsAt && !options.deadlineExpired()) {
    session.elapsedTime += randomInt(1, 6);
    session.score += randomInt(10, 140);
    if (chance(0.08)) session.level = Math.min(session.level + 1, session.maxLevel || 10);
    if (chance(0.04)) session.lives = Math.max(1, session.lives - 1);

    await updateStats(options.baseUrl, session, options);

    if (chance(options.highScoreReadRate)) {
      await request(options.baseUrl, '/highscores/list', {
        headers: { 'user-agent': session.userAgent, 'x-pacman-simulator-session': String(session.sessionId) },
        timeoutMs: options.timeoutMs,
      });
    }

    if (chance(options.scoreSubmitRate)) await submitScore(options.baseUrl, session, options);
    await sleep(randomInt(options.minThinkMs, options.maxThinkMs));
  }

  if (session.score > 0 && chance(options.finalScoreSubmitRate)) await submitScore(options.baseUrl, session, options);
  metrics.sessionsCompleted += 1;
}

function logMetrics() {
  const runtimeSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'pacman simulator metrics',
      runtimeSeconds,
      requests: metrics.requests,
      failures: metrics.failures,
      sessionsStarted: metrics.sessionsStarted,
      sessionsCompleted: metrics.sessionsCompleted,
      scoresSubmitted: metrics.scoresSubmitted,
      requestsPerSecond: Number((metrics.requests / runtimeSeconds).toFixed(2)),
    }),
  );
}

async function worker(workerId, options) {
  let sessionCounter = workerId;
  while (!stopping && !options.deadlineExpired()) {
    await runUserSession(sessionCounter, options);
    sessionCounter += options.users;
    await sleep(randomInt(options.minSessionGapMs, options.maxSessionGapMs));
  }
}

async function main() {
  const durationSeconds = intEnv('DURATION_SECONDS', 0, { min: 0 });
  const started = Date.now();
  const options = {
    baseUrl: process.env.PACMAN_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:8080',
    users: intEnv('USERS', 25, { min: 1, max: 5000 }),
    durationSeconds,
    minThinkMs: intEnv('MIN_THINK_MS', 750, { min: 0 }),
    maxThinkMs: intEnv('MAX_THINK_MS', 3500, { min: 1 }),
    minSessionMs: intEnv('MIN_SESSION_SECONDS', 45, { min: 1 }) * 1000,
    maxSessionMs: intEnv('MAX_SESSION_SECONDS', 180, { min: 1 }) * 1000,
    minSessionGapMs: intEnv('MIN_SESSION_GAP_MS', 250, { min: 0 }),
    maxSessionGapMs: intEnv('MAX_SESSION_GAP_MS', 3000, { min: 0 }),
    scoreSubmitRate: floatEnv('SCORE_SUBMIT_RATE', 0.08),
    finalScoreSubmitRate: floatEnv('FINAL_SCORE_SUBMIT_RATE', 0.7),
    highScoreReadRate: floatEnv('HIGH_SCORE_READ_RATE', 0.35),
    timeoutMs: intEnv('REQUEST_TIMEOUT_MS', 4000, { min: 100 }),
    staticPaths: splitEnv('STATIC_PATHS', DEFAULT_STATIC_PATHS),
    deadlineExpired: () => durationSeconds > 0 && Date.now() - started >= durationSeconds * 1000,
  };

  if (options.maxThinkMs < options.minThinkMs) options.maxThinkMs = options.minThinkMs;
  if (options.maxSessionMs < options.minSessionMs) options.maxSessionMs = options.minSessionMs;
  if (options.maxSessionGapMs < options.minSessionGapMs) options.maxSessionGapMs = options.minSessionGapMs;

  console.log(JSON.stringify({ level: 'info', msg: 'starting pacman user simulator', ...options, staticPaths: options.staticPaths }));

  const interval = setInterval(logMetrics, intEnv('METRICS_INTERVAL_SECONDS', 30, { min: 5 }) * 1000);
  const workers = Array.from({ length: options.users }, (_, workerIndex) => worker(workerIndex + 1, options));
  await Promise.all(workers);
  clearInterval(interval);
  logMetrics();
}

process.on('SIGTERM', () => {
  stopping = true;
});

process.on('SIGINT', () => {
  stopping = true;
});

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'pacman simulator failed', error: err.stack || err.message }));
  process.exitCode = 1;
});
