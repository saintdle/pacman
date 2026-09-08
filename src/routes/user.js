import { Router } from 'express';
import { config } from '../config/index.js';
import { passThroughHeaders, requestJson } from '../services/http-client.js';
import { incCounter } from '../metrics.js';
import { getListOptions, paginate } from './list-options.js';

function upstreamPath(path, req) {
  const query = new URLSearchParams(req.query).toString();
  return query ? `${path}?${query}` : path;
}

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, 32);
  return name || null;
}

export function userRouter() {
  const router = Router();

  router.get('/id', async (req, res, next) => {
    try {
      if (config.APP_ROLE === 'web' && config.USER_SERVICE_URL) {
        const upstream = await requestJson(config.USER_SERVICE_URL, upstreamPath('/internal/user/session', req), {
          headers: passThroughHeaders(req),
        });
        return res.status(upstream.status).json(upstream.payload?.id ?? upstream.payload);
      }

      incCounter('pacman_db_operations_total', { op: 'createUser', source: 'public' });
      const { id } = await req.app.locals.db.createUser(normalizeName(req.query.name));
      // Backwards-compat note: legacy clients received a bare Mongo ObjectId string.
      // Modern adapters return a UUID string. The shape stays "bare string in JSON".
      res.json(id);
    } catch (err) {
      next(err);
    }
  });

  router.post('/stats', async (req, res, next) => {
    try {
      if (config.APP_ROLE === 'web' && config.USER_SERVICE_URL) {
        const upstream = await requestJson(config.USER_SERVICE_URL, '/internal/user/stats', {
          method: 'POST',
          body: req.body,
          headers: passThroughHeaders(req),
        });
        return res.status(upstream.status).json(upstream.payload);
      }

      const userId = req.body.userId;
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId required' });
      }

      const userScore = Number.parseInt(req.body.score, 10);
      const userLevel = Number.parseInt(req.body.level, 10);
      const userLives = Number.parseInt(req.body.lives, 10);
      const userET = Number.parseInt(req.body.elapsedTime, 10);

      incCounter('pacman_db_operations_total', { op: 'updateUserStats', source: 'public' });
      incCounter('pacman_user_stat_updates_total', { source: 'public' });

      await req.app.locals.db.updateUserStats(userId, {
        cloud: req.body.cloud,
        name: normalizeName(req.body.name),
        zone: req.body.zone,
        host: req.body.host,
        score: Number.isFinite(userScore) ? userScore : null,
        level: Number.isFinite(userLevel) ? userLevel : null,
        lives: Number.isFinite(userLives) ? userLives : null,
        elapsedTime: Number.isFinite(userET) ? userET : null,
        referer: req.headers.referer,
        user_agent: req.headers['user-agent'],
        hostname: req.hostname,
        ip_addr: req.ip,
      });

      res.json({ rs: 'success' });
    } catch (err) {
      req.log?.error({ err }, 'failed to update user stats');
      res.json({ rs: 'error' });
      next(err);
    }
  });

  router.get('/stats', async (req, res, next) => {
    try {
      if (config.APP_ROLE === 'web' && config.USER_SERVICE_URL) {
        const upstream = await requestJson(config.USER_SERVICE_URL, upstreamPath('/internal/user/stats', req), {
          headers: passThroughHeaders(req),
        });
        return res.status(upstream.status).json(upstream.payload);
      }

      incCounter('pacman_db_operations_total', { op: 'listUserStats', source: 'public' });
      const options = getListOptions(req, config.LIVE_STATS_PAGE_SIZE);
      const stats = await req.app.locals.db.listUserStats({
        maxAgeSeconds: config.LIVE_STATS_MAX_AGE_SECONDS,
        includeSimulated: options.includeSimulated,
      });
      res.json(options.hasPagination ? paginate(stats, options) : stats);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default userRouter;
