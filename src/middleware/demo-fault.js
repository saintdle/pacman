import { setTimeout as delay } from 'node:timers/promises';
import { demoAuthorized } from '../demo/guard.js';
import { incCounter } from '../metrics.js';

const MAX_DELAY_MS = 10_000;

export function demoFaultMiddleware() {
  return async (req, res, next) => {
    if (!demoAuthorized(req)) return next();

    const delayMs = Number.parseInt(req.headers['x-demo-fault-delay-ms'], 10);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await delay(Math.min(delayMs, MAX_DELAY_MS));
    }

    const status = Number.parseInt(req.headers['x-demo-fault-status'], 10);
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      incCounter('pacman_demo_faults_total', { type: 'status', value: String(status) });
      req.log?.warn({ status }, 'demo fault injected');
      return res.status(status).json({ error: 'demo fault injected', status });
    }

    return next();
  };
}

export default demoFaultMiddleware;