import { Router } from 'express';
import { config } from '../config/index.js';
import { passThroughHeaders, requestJson } from '../services/http-client.js';
import { incCounter } from '../metrics.js';
import { validateScore } from './score-validation.js';
import { getListOptions, paginate } from './list-options.js';

function upstreamPath(path, req) {
  const query = new URLSearchParams(req.query).toString();
  return query ? `${path}?${query}` : path;
}

export function highscoresRouter() {
  const router = Router();

  router.get('/list', async (req, res, next) => {
    try {
      if (config.APP_ROLE === 'web' && config.SCORE_SERVICE_URL) {
        const upstream = await requestJson(config.SCORE_SERVICE_URL, upstreamPath('/internal/score/read', req), {
          headers: passThroughHeaders(req),
        });
        return res.status(upstream.status).json(upstream.payload);
      }

      incCounter('pacman_db_operations_total', { op: 'listTopScores', source: 'public' });
      const options = getListOptions(req, 10);
      const scores = await req.app.locals.db.listTopScores(10000, options);
      res.json(options.hasPagination ? paginate(scores, options) : scores.slice(0, 10));
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
      const validationError = validateScore(userScore, userLevel, config.MAX_LEVEL);
      if (validationError) return res.status(400).json({ error: validationError });

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
