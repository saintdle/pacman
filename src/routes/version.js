import { Router } from 'express';
import { config } from '../config/index.js';

export function versionRouter() {
  const router = Router();

  router.get('/', (_req, res) => {
    const deps = {};
    if (config.SCORE_SERVICE_URL) deps.score = config.SCORE_SERVICE_URL;
    if (config.USER_SERVICE_URL) deps.user = config.USER_SERVICE_URL;
    if (config.CONFIG_SERVICE_URL) deps.config = config.CONFIG_SERVICE_URL;
    if (config.TOPOLOGY_SERVICE_URL) deps.topology = config.TOPOLOGY_SERVICE_URL;

    res.json({
      app: 'pacman',
      role: config.APP_ROLE,
      version: config.APP_VERSION,
      variant: config.APP_VARIANT,
      color: config.APP_COLOR,
      commit: config.COMMIT_SHA,
      builtAt: config.BUILD_DATE,
      database: config.DB_TYPE,
      dependencies: deps,
    });
  });

  return router;
}

export default versionRouter;