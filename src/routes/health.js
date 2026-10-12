import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { requestJson } from '../services/http-client.js';

const READINESS_PROBE_HEADER = 'x-pacman-readiness-path';
const READINESS_NODE_ID = randomUUID();
const UPSTREAM_PROBE_TIMEOUT_MS = 750;
const UPSTREAMS = [
  ['score', 'SCORE_SERVICE_URL'],
  ['user', 'USER_SERVICE_URL'],
  ['config', 'CONFIG_SERVICE_URL'],
  ['topology', 'TOPOLOGY_SERVICE_URL'],
];

async function probeUpstream(url, probePath) {
  if (!url) return null;
  const start = performance.now();
  try {
    const { ok, status } = await requestJson(url, '/readyz', {
      headers: { [READINESS_PROBE_HEADER]: probePath.join(',') },
      timeoutMs: UPSTREAM_PROBE_TIMEOUT_MS,
    });
    return { url, healthy: ok, status, latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { url, healthy: false, status: 'unreachable', latencyMs: Math.round(performance.now() - start) };
  }
}

async function probeConfiguredUpstreams(probePath) {
  const results = await Promise.all(UPSTREAMS.map(async ([name, configKey]) => {
    const result = await probeUpstream(config[configKey], probePath);
    return result ? [name, result] : null;
  }));
  return Object.fromEntries(results.filter((entry) => entry !== null));
}

export function healthRouter() {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      version: config.APP_VERSION,
      commit: config.COMMIT_SHA,
    });
  });

  router.get('/readyz', async (req, res) => {
    const probePath = req.get(READINESS_PROBE_HEADER)?.split(',').filter(Boolean) ?? [];
    const cycleDetected = probePath.includes(READINESS_NODE_ID);
    const shouldProbeUpstreams = config.APP_ROLE === 'web'
      && config.READINESS_CHECK_UPSTREAMS
      && probePath.length === 0
      && !cycleDetected;
    const [databaseHealthy, upstreams] = await Promise.all([
      req.app.locals.db.healthcheck().catch(() => false),
      shouldProbeUpstreams ? probeConfiguredUpstreams([...probePath, READINESS_NODE_ID]) : {},
    ]);
    const ready = databaseHealthy && Object.values(upstreams).every((upstream) => upstream.healthy);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready' });
  });

  router.get('/readyz/details', async (req, res) => {
    const [ok, upstreams] = await Promise.all([
      req.app.locals.db.healthcheck().catch(() => false),
      config.APP_ROLE === 'web' ? probeConfiguredUpstreams([READINESS_NODE_ID]) : {},
    ]);

    const allUpstreamsHealthy = Object.values(upstreams).every((u) => u.healthy);
    const ready = ok && allUpstreamsHealthy;

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      role: config.APP_ROLE,
      version: config.APP_VERSION,
      variant: config.APP_VARIANT,
      database: { type: config.DB_TYPE, healthy: ok },
      upstreams,
      config: {
        maxLevel: config.MAX_LEVEL,
        allowClientOverride: config.ALLOW_CLIENT_CONFIG_OVERRIDE,
        ebeeMode: config.EBEE_MODE,
        allowEbeeModeOverride: config.ALLOW_CLIENT_EBEE_MODE_OVERRIDE,
      },
    });
  });

  return router;
}

export default healthRouter;
