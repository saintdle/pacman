import { Router } from 'express';
import { renderMetrics } from '../metrics.js';

export function metricsRouter() {
  const router = Router();

  router.get('/', (_req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderMetrics());
  });

  return router;
}

export default metricsRouter;
