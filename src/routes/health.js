import { Router } from 'express';
import { config } from '../config/index.js';
import { requestJson } from '../services/http-client.js';

async function probeUpstream(url) {
  if (!url) return null;
  const start = performance.now();
  try {
    const { ok, status } = await requestJson(url, '/healthz', { timeoutMs: 1500 });
    return { url, healthy: ok, status, latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { url, healthy: false, status: 'unreachable', latencyMs: Math.round(performance.now() - start) };
  }
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
    const ok = await req.app.locals.db.healthcheck().catch(() => false);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not-ready' });
  });

  router.get('/readyz/details', async (req, res) => {
    const ok = await req.app.locals.db.healthcheck().catch(() => false);

    const shouldProbeUpstreams = config.APP_ROLE === 'web';
    const [score, user, configSvc, topology] = shouldProbeUpstreams
      ? await Promise.all([
        probeUpstream(config.SCORE_SERVICE_URL),
        probeUpstream(config.USER_SERVICE_URL),
        probeUpstream(config.CONFIG_SERVICE_URL),
        probeUpstream(config.TOPOLOGY_SERVICE_URL),
      ])
      : [null, null, null, null];

    const upstreams = Object.fromEntries(
      [['score', score], ['user', user], ['config', configSvc], ['topology', topology]]
        .filter(([, v]) => v !== null),
    );

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
