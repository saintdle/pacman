import express from 'express';
import { rateLimit } from 'express-rate-limit';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { highscoresRouter } from './routes/highscores.js';
import { userRouter } from './routes/user.js';
import { locationRouter } from './routes/location.js';
import { healthRouter } from './routes/health.js';
import { configRouter } from './routes/config.js';
import { versionRouter } from './routes/version.js';
import { demoRouter } from './routes/demo.js';
import { metricsRouter } from './routes/metrics.js';
import { internalRouter } from './routes/internal.js';
import { demoFaultMiddleware, FAULT_HEADER_NAMES } from './middleware/demo-fault.js';
import { metricsMiddleware } from './metrics.js';
import { config } from './config/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * Build the Express app. The database adapter is injected so that:
 *   - tests can swap in MemoryAdapter without env juggling
 *   - the server bootstrap controls connection lifecycle
 */
export function createApp({ db }) {
  const app = express();

  app.set('trust proxy', config.TRUST_PROXY);
  app.set('views', path.join(repoRoot, 'views'));
  app.set('view engine', 'pug');

  app.locals.db = db;

  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(metricsMiddleware());
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'too many demo fault requests' },
    skip: (req) => !FAULT_HEADER_NAMES.some((name) => req.headers[name] !== undefined),
  }));
  app.use(demoFaultMiddleware());

  app.use('/', express.static(path.join(repoRoot, 'public')));

  app.use('/', healthRouter());
  app.use('/version', versionRouter());
  app.use('/metrics', metricsRouter());
  app.use('/demo', demoRouter());
  app.use('/config', configRouter());
  app.use('/internal', internalRouter());
  app.use('/highscores', highscoresRouter());
  app.use('/user', userRouter());
  app.use('/location', locationRouter());

  // 404
  app.use((req, _res, next) => {
    const err = new Error('Not Found');
    err.status = 404;
    next(err);
  });

  // Error handler (4-arg signature required by Express)
  app.use((err, req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) req.log?.error({ err }, 'request failed');
    if (res.headersSent) return;
    res.status(status);
    res.render('error', {
      message: err.message,
      error: app.get('env') === 'development' ? err : { status },
    });
  });

  return app;
}

export default createApp;
