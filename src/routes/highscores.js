import { Router } from 'express';
import { config } from '../config/index.js';
import { passThroughHeaders, requestJson } from '../services/http-client.js';
import { incCounter } from '../metrics.js';

// Ported from upstream platzhersh/pacman-canvas v1.0.2 client-side check.
// Max attainable points per level: 104 pills * 10 + 4 powerpills * 50 + 4 ghosts * 4 hits * 100.
const PILL_POINTS = 10;
const POWERPILL_POINTS = 50;
const GHOST_POINTS = 100;
const MAX_POINTS_PER_LEVEL =
  104 * PILL_POINTS + 4 * POWERPILL_POINTS + 4 * 4 * GHOST_POINTS;

export function highscoresRouter() {
  const router = Router();

  router.get('/list', async (req, res, next) => {
    try {
      if (config.APP_ROLE === 'web' && config.SCORE_SERVICE_URL) {
        const upstream = await requestJson(config.SCORE_SERVICE_URL, '/internal/score/read', {
          headers: passThroughHeaders(req),
        });
        return res.status(upstream.status).json(upstream.payload);
      }

      incCounter('pacman_db_operations_total', { op: 'listTopScores', source: 'public' });
      const scores = await req.app.locals.db.listTopScores(10);
      res.json(scores);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      if (config.APP_ROLE === 'web' && config.SCORE_SERVICE_URL) {
        const upstream = await requestJson(config.SCORE_SERVICE_URL, '/internal/score/write', {
          method: 'POST',
          body: req.body,
          headers: passThroughHeaders(req),
        });
        return res.status(upstream.status).json(upstream.payload);
      }

      const userScore = Number.parseInt(req.body.score, 10);
      const userLevel = Number.parseInt(req.body.level, 10);

      if (!Number.isFinite(userScore)) {
        return res.status(400).json({ error: 'score must be a number' });
      }

      // Defence-in-depth: same sanity check the browser already runs.
      // Reject impossible score/level combinations rather than persist them.
      if (Number.isFinite(userLevel)) {
        if (userLevel < 1) {
          return res.status(400).json({ error: 'invalid level' });
        }
        if (config.MAX_LEVEL !== 'unlimited' && userLevel > config.MAX_LEVEL) {
          return res.status(400).json({ error: 'invalid level' });
        }
        if (userScore / userLevel > MAX_POINTS_PER_LEVEL) {
          return res.status(400).json({ error: 'score is implausible for level' });
        }
      }

      incCounter('pacman_db_operations_total', { op: 'insertScore', source: 'public' });
      incCounter('pacman_score_submissions_total', { source: 'public' });

      await req.app.locals.db.insertScore({
        name: req.body.name,
        cloud: req.body.cloud,
        zone: req.body.zone,
        host: req.body.host,
        score: userScore,
        level: Number.isFinite(userLevel) ? userLevel : null,
        referer: req.headers.referer,
        user_agent: req.headers['user-agent'],
        hostname: req.hostname,
        ip_addr: req.ip,
      });

      res.json({
        name: req.body.name,
        zone: req.body.zone,
        score: userScore,
        level: userLevel,
        rs: 'success',
      });
    } catch (err) {
      req.log?.error({ err }, 'failed to insert highscore');
      res.json({
        name: req.body?.name,
        zone: req.body?.zone,
        score: Number.parseInt(req.body?.score, 10),
        level: Number.parseInt(req.body?.level, 10),
        rs: 'error',
      });
      next(err);
    }
  });

  return router;
}

export default highscoresRouter;
